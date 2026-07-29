/**
 * Durable transition-ledger publication.
 *
 * The tracker remains the source of truth. This append is observation-only,
 * but it must never expose a partial TSV row or lose a concurrent event.
 */

import { appendFileLocked } from '../lib/locked-file.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const STATE_RE = /^(?:[A-Za-z][A-Za-z -]{0,63}|-)$/u;

function validDate(value) {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.toISOString().slice(0, 10) === value;
}

export function statusTransitionLine({
  trackerNum,
  date,
  from,
  to,
} = {}) {
  if (!Number.isSafeInteger(trackerNum) || trackerNum <= 0) {
    throw new TypeError('status transition tracker number is invalid');
  }
  if (typeof date !== 'string' || !validDate(date)) {
    throw new TypeError('status transition date is invalid');
  }
  if (typeof from !== 'string' || !STATE_RE.test(from)) {
    throw new TypeError('status transition source state is invalid');
  }
  if (typeof to !== 'string' || !STATE_RE.test(to)) {
    throw new TypeError('status transition target state is invalid');
  }
  return `${trackerNum}\t${date}\t${from}\t${to}\tset-status\t\n`;
}

export async function appendStatusTransition(filePath, event, options = {}) {
  const line = statusTransitionLine(event);
  await appendFileLocked(filePath, line, {
    lockOptions: options.lockOptions,
    writeOptions: {
      mode: 0o600,
      ...options.writeOptions,
    },
  });
  return line;
}
