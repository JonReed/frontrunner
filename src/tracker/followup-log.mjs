/**
 * followup-log.mjs — record that a follow-up actually happened, or move the
 * next one.
 *
 * The cadence side of this was already complete: `followup-seed.mjs` pins a
 * first date when a role turns Applied, and `followup-cadence.mjs` works out
 * what is due. What was missing was the other half of the loop. Nothing in the
 * product could write a follow-up back, so `followupCount` never left zero and
 * every application stayed permanently overdue — while "N follow-ups need your
 * attention" sat at the top of the home screen as the highest-priority thing
 * the user could not do anything about.
 *
 * Two operations, because there are two honest answers to "this is due":
 *
 *   log     I contacted them. Appends a table row, which is what
 *           `parseFollowups` counts. The next date is then recomputed from it
 *           by the existing cadence rules — this file never decides when the
 *           following one is due.
 *
 *   snooze  Not yet. Writes a pin directive, the same mechanism the seeder
 *           uses, so the schedule moves without pretending contact was made.
 *
 * The distinction matters more than it looks. Logging a follow-up that never
 * happened corrupts the only record of what was actually sent to an employer,
 * and that record is what the user relies on when a reply arrives three weeks
 * later.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { transactFollowups } from './followup-store.mjs';
import { FOLLOWUPS_HEADER, formatPinLine } from './followup-seed.mjs';
import { parseFollowups } from './followup-cadence.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';

/** The ways someone actually chases an application. */
export const FOLLOWUP_CHANNELS = Object.freeze(['Email', 'LinkedIn', 'Phone', 'Portal', 'Other']);

const MAX_NOTE = 300;
/** A snooze beyond this is someone abandoning the role, not deferring it. */
const MAX_SNOOZE_DAYS = 180;

export class FollowupLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FollowupLogError';
    this.code = code;
  }
}

function followupsPath() {
  return process.env.FRONTRUNNER_FOLLOWUPS
    || join(ROOT, 'workspace', 'applications', 'follow-ups.md');
}

function trackerPath() {
  return process.env.FRONTRUNNER_TRACKER
    || join(ROOT, 'workspace', 'applications', 'tracker.md');
}

export function todayIso(now = new Date()) {
  return [
    String(now.getFullYear()).padStart(4, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Make one value safe to put in a table cell.
 *
 * `|` ends a cell and a newline ends the row, so either would silently move a
 * note into the contact column or split one follow-up into two unreadable
 * ones. Company and role come from the tracker, which is assembled from job
 * board content, so this is not only about what the user types.
 */
export function cell(value, limit = MAX_NOTE) {
  return String(value ?? '')
    .replace(/[|\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function appNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999) {
    throw new FollowupLogError('INVALID_APP', 'That is not an application this can record.');
  }
  return value;
}

/** Company and role for the row, so the log reads without the tracker beside it. */
function trackerLabels(appNum) {
  const file = trackerPath();
  if (!existsSync(file)) return { company: '', role: '' };
  const lines = readFileSync(file, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  for (const line of lines) {
    const row = parseTrackerRow(line, columns);
    if (row && row.num === appNum) {
      return { company: cell(row.company, 80), role: cell(row.role, 80) };
    }
  }
  return { company: '', role: '' };
}

function nextRowNumber(content) {
  let highest = 0;
  for (const entry of parseFollowups(content ?? '')) {
    if (Number.isSafeInteger(entry.num) && entry.num > highest) highest = entry.num;
  }
  return highest + 1;
}

function append(current, line) {
  if (current == null || !current.trim()) return `${FOLLOWUPS_HEADER}\n${line}\n`;
  return `${current}${current.endsWith('\n') ? '' : '\n'}${line}\n`;
}

/**
 * Record that a follow-up was sent.
 *
 * The date defaults to today and cannot be in the future: this logs something
 * that happened, and a future-dated row would suppress the reminder for a
 * message nobody has written yet.
 */
export async function logFollowup(appNum, {
  channel = 'Email',
  note = '',
  date = todayIso(),
  contact = '',
} = {}) {
  const num = appNumber(appNum);
  if (!FOLLOWUP_CHANNELS.includes(channel)) {
    throw new FollowupLogError('INVALID_CHANNEL', 'That is not a way of following up this can record.');
  }
  if (!isIsoDate(date)) {
    throw new FollowupLogError('INVALID_DATE', 'That is not a real date.');
  }
  if (date > todayIso()) {
    throw new FollowupLogError('FUTURE_DATE', 'A follow-up cannot be recorded before it happens.');
  }

  const labels = trackerLabels(num);
  return transactFollowups(followupsPath(), current => {
    // Eight cells, in the order parseFollowups reads them. All of them are
    // written even when empty: the parser indexes by position and skips any
    // row with fewer, so a missing contact would drop the whole follow-up.
    const cells = [
      String(nextRowNumber(current)),
      String(num),
      date,
      labels.company,
      labels.role,
      cell(channel, 20),
      cell(contact, 80),
      cell(note),
    ];
    const row = `| ${cells.join(' | ')} |`;

    return { value: { logged: true, date, channel }, content: append(current, row) };
  });
}

/**
 * Move the next follow-up without claiming one was sent.
 *
 * Written as the same pin directive the seeder uses, so the cadence resolves
 * it through one code path — and so a pin made here is superseded by the next
 * real follow-up exactly as a seeded one is.
 */
export async function snoozeFollowup(appNum, date) {
  const num = appNumber(appNum);
  if (!isIsoDate(date)) throw new FollowupLogError('INVALID_DATE', 'That is not a real date.');
  const today = todayIso();
  if (date <= today) {
    throw new FollowupLogError('PAST_DATE', 'Choose a date in the future to put this off until.');
  }
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + MAX_SNOOZE_DAYS);
  if (date > limit.toISOString().slice(0, 10)) {
    throw new FollowupLogError('TOO_FAR', 'That is too far ahead. Close the role instead if you are done with it.');
  }

  return transactFollowups(followupsPath(), current => ({
    value: { snoozed: true, date },
    content: append(current, formatPinLine(num, date, today)),
  }));
}
