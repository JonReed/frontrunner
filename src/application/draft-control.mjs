#!/usr/bin/env node

/**
 * Bounded JSON adapter for the unfinished setup draft.
 *
 * WHY THIS EXISTS. Setup asks for a CV — often pasted, sometimes typed over —
 * and held it in component state alone, so a stray reload lost the lot. The
 * obvious fix was sessionStorage, and that is what CodeQL correctly objected
 * to: it puts an employment history, contact details and salary expectations
 * into browser storage in clear text, where they sit until the tab closes.
 *
 * Suppressing that finding would have been the wrong answer twice over. The
 * data is not incidental — the CV is the most sensitive thing this product
 * handles — and trimming the fields the scanner happens to name (salary) while
 * keeping the CV would have silenced the tool without making anyone safer.
 *
 * So the draft lives where the finished profile already lives: on disk, under
 * `workspace/.state/`, written by the same trusted local process, reachable
 * only over loopback. Browser storage holds nothing.
 *
 * A side benefit worth having: a draft on disk survives closing the tab, not
 * merely a reload, which is the failure people actually describe.
 *
 * The draft is DELETED on successful setup. Keeping a second copy of someone's
 * CV around after the real one is written is exactly the exposure this module
 * exists to remove.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { readBoundedRegularFileSync } from '../lib/safe-file-read.mjs';
import { APPLICATION_API_VERSION } from './contract.mjs';
import { readBoundedRequest } from './run.mjs';

const CONTROL_KEYS = new Set(['version', 'action', 'draft']);
const ACTIONS = new Set(['read', 'save', 'clear']);

/**
 * Generous enough for a long CV plus a few tailored versions, bounded because
 * this arrives from a browser and is written to disk.
 */
export const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_DRAFT_REQUEST_BYTES = MAX_DRAFT_BYTES + 64 * 1024;

export function draftPath() {
  return process.env.FRONTRUNNER_SETUP_DRAFT
    || join(ROOT, 'workspace', '.state', 'setup-draft.json');
}

function controlError(message, code = 'INVALID_DRAFT_CONTROL_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function validateDraftControlRequest(value) {
  if (!plainObject(value)) throw controlError('draft-control request must be a plain object');
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported draft-control field: ${key}`);
  }
  if (value.version !== APPLICATION_API_VERSION) {
    throw controlError(`unsupported draft-control version: ${String(value.version ?? '')}`);
  }
  if (!ACTIONS.has(value.action)) {
    throw controlError(`unsupported draft-control action: ${String(value.action ?? '')}`);
  }
  if (value.action !== 'save') {
    if (value.draft !== undefined) throw controlError(`${value.action} does not accept a draft`);
    return Object.freeze({ version: APPLICATION_API_VERSION, action: value.action });
  }
  if (!plainObject(value.draft)) throw controlError('draft must be a plain object');
  const encoded = JSON.stringify(value.draft);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_DRAFT_BYTES) {
    throw controlError('draft is too large', 'DRAFT_TOO_LARGE');
  }
  return Object.freeze({ version: APPLICATION_API_VERSION, action: 'save', draft: value.draft });
}

/**
 * Read the stored draft, or null.
 *
 * Never throws on unreadable content: a corrupt draft is a lost safety net,
 * not a reason to block the setup screen that exists to replace it.
 */
export function readDraft() {
  const file = draftPath();
  const text = readBoundedRegularFileSync(file, {
    maxBytes: MAX_DRAFT_BYTES,
    allowMissing: true,
    label: 'setup draft',
  });
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(draft) {
  const file = draftPath();
  mkdirSync(dirname(file), { recursive: true });
  // 0600: this is a CV in progress, not shared state.
  replaceFileAtomic(file, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
  return { saved: true };
}

export function clearDraft() {
  const file = draftPath();
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return { cleared: existed };
}

export async function main({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  try {
    const control = validateDraftControlRequest(await readBoundedRequest(input, {
      maxBytes: MAX_DRAFT_REQUEST_BYTES,
    }));

    let result;
    if (control.action === 'read') {
      result = { version: APPLICATION_API_VERSION, draft: readDraft() };
    } else if (control.action === 'save') {
      result = { version: APPLICATION_API_VERSION, ...saveDraft(control.draft) };
    } else {
      result = { version: APPLICATION_API_VERSION, ...clearDraft() };
    }

    output.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code: error?.code ?? 'DRAFT_CONTROL_PROTOCOL_ERROR',
    })}\n`);
    process.exitCode = 1;
    return null;
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
