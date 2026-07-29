/**
 * Closed child-to-application progress channel.
 *
 * Progress is advisory: malformed or oversized data is ignored and surfaced as
 * a warning, but can never change the backend operation result. Remote content,
 * free text, URLs and errors are not fields in this contract.
 */

import { writeSync } from 'node:fs';

export const APPLICATION_PROGRESS_VERSION = '1';
export const APPLICATION_PROGRESS_FD_ENV = 'FRONTRUNNER_PROGRESS_FD';
export const PIPELINE_STAGES = Object.freeze([
  'scan',
  'cache',
  'liveness',
  'prefilter',
  'evaluation',
]);
export const PIPELINE_STAGE_LABELS = Object.freeze({
  scan: 'Scanning job sources',
  cache: 'Caching job descriptions',
  liveness: 'Checking which roles are still live',
  prefilter: 'Filtering obvious mismatches',
  evaluation: 'Evaluating the shortlist',
});

const STAGES = new Set(PIPELINE_STAGES);
const STATES = new Set(['started', 'completed', 'failed']);
const ALLOWED_KEYS = new Set(['version', 'stage', 'state', 'counts']);
const MAX_PROGRESS_BYTES = 64 * 1024;
const MAX_PROGRESS_LINE_BYTES = 2 * 1024;
const MAX_PROGRESS_EVENTS = 32;

function normalizeCounts(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('progress counts must be an object');
  }
  const counts = {};
  const entries = Object.entries(value);
  if (entries.length > 16) throw new TypeError('too many progress counts');
  for (const [key, raw] of entries) {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/u.test(key)) {
      throw new TypeError(`invalid progress count: ${key}`);
    }
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new TypeError(`invalid progress count value: ${key}`);
    }
    counts[key] = raw;
  }
  return Object.keys(counts).length ? Object.freeze(counts) : undefined;
}

export function normalizeApplicationProgress(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('progress event must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) throw new TypeError(`unsupported progress field: ${key}`);
  }
  if (value.version !== APPLICATION_PROGRESS_VERSION) {
    throw new TypeError('unsupported progress version');
  }
  if (!STAGES.has(value.stage)) throw new TypeError('invalid progress stage');
  if (!STATES.has(value.state)) throw new TypeError('invalid progress state');
  const counts = normalizeCounts(value.counts);
  if (value.state === 'started' && counts) {
    throw new TypeError('started progress cannot contain counts');
  }
  return Object.freeze({
    version: APPLICATION_PROGRESS_VERSION,
    stage: value.stage,
    state: value.state,
    ...(counts ? { counts } : {}),
  });
}

export function applicationProgress({ stage, state, counts } = {}) {
  return normalizeApplicationProgress({
    version: APPLICATION_PROGRESS_VERSION,
    stage,
    state,
    ...(counts ? { counts } : {}),
  });
}

export function emitApplicationProgress(value, options = {}) {
  const rawFd = options.fd ?? process.env[APPLICATION_PROGRESS_FD_ENV];
  if (rawFd === undefined) return false;
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd !== 3) {
    throw new Error('invalid application progress file descriptor');
  }
  const event = normalizeApplicationProgress(value);
  writeSync(fd, `${JSON.stringify(event)}\n`);
  return true;
}

export function createApplicationProgressDecoder({
  onEvent = () => {},
  onWarning = () => {},
} = {}) {
  let buffer = '';
  let totalBytes = 0;
  let eventCount = 0;
  let disabled = false;

  const warn = (message) => {
    if (disabled) return;
    disabled = true;
    buffer = '';
    try {
      onWarning(new Error(message));
    } catch {
      // Progress observers have no authority over execution.
    }
  };

  const consume = (line) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > MAX_PROGRESS_LINE_BYTES) {
      warn('application progress line exceeds its byte limit');
      return;
    }
    if (++eventCount > MAX_PROGRESS_EVENTS) {
      warn('application progress event limit exceeded');
      return;
    }
    try {
      const event = normalizeApplicationProgress(JSON.parse(line));
      onEvent(event);
    } catch (error) {
      warn(`invalid application progress: ${error.message}`);
    }
  };

  return Object.freeze({
    push(chunk) {
      if (disabled) return;
      const text = String(chunk ?? '');
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > MAX_PROGRESS_BYTES) {
        warn('application progress exceeds its total byte limit');
        return;
      }
      buffer += text;
      let newline;
      while (!disabled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consume(line);
      }
      if (Buffer.byteLength(buffer) > MAX_PROGRESS_LINE_BYTES) {
        warn('application progress line exceeds its byte limit');
      }
    },
    end() {
      if (!disabled && buffer.trim()) consume(buffer);
      buffer = '';
    },
  });
}
