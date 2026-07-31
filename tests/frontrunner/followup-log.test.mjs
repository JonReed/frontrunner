import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cell,
  isIsoDate,
  logFollowup,
  snoozeFollowup,
  todayIso,
} from '../../src/tracker/followup-log.mjs';
import {
  parseFollowups,
  parseNextOverrides,
} from '../../src/tracker/followup-cadence.mjs';
import { validateFollowupControlRequest } from '../../src/application/followup-control.mjs';

function scratchFollowups(t, { tracker = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-followup-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const previous = {
    followups: process.env.FRONTRUNNER_FOLLOWUPS,
    tracker: process.env.FRONTRUNNER_TRACKER,
  };
  const file = join(dir, 'follow-ups.md');
  process.env.FRONTRUNNER_FOLLOWUPS = file;

  if (tracker) {
    const trackerFile = join(dir, 'tracker.md');
    writeFileSync(trackerFile, tracker);
    process.env.FRONTRUNNER_TRACKER = trackerFile;
  }

  t.after(() => {
    for (const [key, value] of [
      ['FRONTRUNNER_FOLLOWUPS', previous.followups],
      ['FRONTRUNNER_TRACKER', previous.tracker],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return file;
}

const TRACKER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 42 | 2026-07-01 | Acme Ltd | Practice Manager | 4.2/5 | Applied | ✅ | — | |',
  '',
].join('\n');

test('a logged follow-up round-trips through the cadence parser', async (t) => {
  const file = scratchFollowups(t, { tracker: TRACKER });

  await logFollowup(42, { channel: 'Email', note: 'Chased the recruiter' });
  const entries = parseFollowups(readFileSync(file, 'utf8'));

  assert.equal(entries.length, 1);
  assert.deepEqual(
    { ...entries[0], date: 'today' },
    {
      num: 1,
      appNum: 42,
      date: 'today',
      company: 'Acme Ltd',
      role: 'Practice Manager',
      channel: 'Email',
      contact: '',
      notes: 'Chased the recruiter',
    },
  );
  assert.equal(entries[0].date, todayIso());
});

test('follow-up numbers increment rather than colliding', async (t) => {
  const file = scratchFollowups(t, { tracker: TRACKER });
  await logFollowup(42, { channel: 'Email' });
  await logFollowup(42, { channel: 'LinkedIn' });
  await logFollowup(7, { channel: 'Phone' });

  assert.deepEqual(
    parseFollowups(readFileSync(file, 'utf8')).map((entry) => entry.num),
    [1, 2, 3],
  );
});

test('a pipe in a note cannot split or shift the row', async (t) => {
  const file = scratchFollowups(t, { tracker: TRACKER });
  // Company and role reach this from the tracker, which is assembled from job
  // board content — so this is not only about what the user types.
  await logFollowup(42, { channel: 'Email', note: 'a | b\nc\td' });

  const entries = parseFollowups(readFileSync(file, 'utf8'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].notes, 'a b c d');
  assert.equal(entries[0].appNum, 42);
});

test('a follow-up cannot be recorded before it happens', async (t) => {
  scratchFollowups(t, { tracker: TRACKER });
  const future = new Date();
  future.setDate(future.getDate() + 3);

  await assert.rejects(
    () => logFollowup(42, { date: future.toISOString().slice(0, 10) }),
    (error) => error.code === 'FUTURE_DATE',
  );
  await assert.rejects(
    () => logFollowup(42, { date: '2026-02-31' }),
    (error) => error.code === 'INVALID_DATE',
  );
  await assert.rejects(
    () => logFollowup(42, { channel: 'Carrier pigeon' }),
    (error) => error.code === 'INVALID_CHANNEL',
  );
  await assert.rejects(() => logFollowup(0, {}), (error) => error.code === 'INVALID_APP');
});

test('snoozing writes a pin the cadence understands, and claims nothing was sent', async (t) => {
  const file = scratchFollowups(t, { tracker: TRACKER });
  const later = new Date();
  later.setDate(later.getDate() + 7);
  const date = later.toISOString().slice(0, 10);

  await snoozeFollowup(42, date);
  const content = readFileSync(file, 'utf8');

  const pin = parseNextOverrides(content).get(42);
  assert.equal(pin.date, date);
  assert.equal(pin.setDate, todayIso());
  // A snooze must not increment the follow-up count: nothing was sent.
  assert.deepEqual(parseFollowups(content), []);
});

test('a snooze must move the reminder forward, and not indefinitely', async (t) => {
  scratchFollowups(t, { tracker: TRACKER });
  await assert.rejects(
    () => snoozeFollowup(42, todayIso()),
    (error) => error.code === 'PAST_DATE',
  );
  await assert.rejects(
    () => snoozeFollowup(42, '2099-01-01'),
    (error) => error.code === 'TOO_FAR',
  );
});

test('a missing tracker leaves the labels empty rather than failing the log', async (t) => {
  const file = scratchFollowups(t);
  await logFollowup(42, { channel: 'Email' });
  const [entry] = parseFollowups(readFileSync(file, 'utf8'));
  assert.equal(entry.company, '');
  assert.equal(entry.appNum, 42);
});

test('cell and isIsoDate hold their bounds', () => {
  assert.equal(cell('  a \n b  '), 'a b');
  assert.equal(cell('x'.repeat(500)).length, 300);
  assert.equal(isIsoDate('2026-07-31'), true);
  assert.equal(isIsoDate('2026-02-31'), false);
  assert.equal(isIsoDate('31-07-2026'), false);
  assert.equal(isIsoDate(null), false);
});

test('the follow-up control refuses anything outside its fixed protocol', () => {
  assert.deepEqual(
    validateFollowupControlRequest({ version: '1', action: 'log', appNum: 42 }),
    { version: '1', action: 'log', appNum: 42, channel: 'Email', note: '', date: undefined },
  );

  for (const request of [
    null,
    [],
    { version: '2', action: 'log', appNum: 42 },
    { version: '1', action: 'erase', appNum: 42 },
    { version: '1', action: 'log', appNum: 0 },
    { version: '1', action: 'log', appNum: 1.5 },
    { version: '1', action: 'log', appNum: 42, channel: 'Telepathy' },
    { version: '1', action: 'log', appNum: 42, path: '/etc/passwd' },
    { version: '1', action: 'snooze', appNum: 42 },
    { version: '1', action: 'snooze', appNum: 42, date: '2026-09-01', note: 'x' },
  ]) {
    assert.throws(() => validateFollowupControlRequest(request));
  }
});
