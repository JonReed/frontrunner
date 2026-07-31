#!/usr/bin/env node

/**
 * Bounded JSON adapter for tracker status changes.
 *
 * Same contract as job-control.mjs and profile-control.mjs: the UI starts this
 * one fixed script and sends bounded JSON on stdin. A move names a role number
 * and a small allowlisted state. Undo names only the role; this adapter derives
 * the previous state from its own tracker marker. Neither can name a path, an
 * executable, or a flag.
 *
 * Why this exists at all: without it the workflow has no ending. Frontrunner
 * builds a tailored CV, sends the user to the company's own site, and then
 * never learns what happened — "Applied" and "In process" stay at zero
 * forever, and a role that has been sent still sits in "Ready to send" telling
 * the user to do something they already did.
 *
 * The write itself goes through src/tracker/set-status.mjs, the canonical CLI:
 * strict validation against templates/states.yml, row-resolution that refuses
 * ambiguous matches rather than guessing, shared tracker lock, atomic replace.
 * Re-implementing any of that here would be a second writer to a file the
 * project deliberately keeps to one.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import yaml from 'js-yaml';

import { ROOT } from '#paths';
import { APPLICATION_API_VERSION } from './contract.mjs';
import { resolveTrackerPath } from '../tracker/tracker-utils.mjs';
import { parseTrackerRow, resolveColumns } from '../tracker/tracker-parse.mjs';
import {
  removeWorkflowSeed,
  seedFollowup,
} from '../tracker/followup-seed.mjs';
import {
  shouldDetachProcessTree,
  signalProcessTree,
} from './process-tree.mjs';
import { readBoundedRequest } from './run.mjs';

const CONTROL_KEYS = new Set([
  'version',
  'action',
  'roleNum',
  'state',
  'note',
  'expectedRevision',
  'undoToken',
]);
const MAX_NOTE = 300;
const MAX_ROLE_NUM = 999_999;
const SET_STATUS = join(ROOT, 'src', 'tracker', 'set-status.mjs');
const TIMEOUT_MS = 20_000;
const TERMINATION_GRACE_MS = 2_000;
const STDOUT_LIMIT = 64 * 1024;
const STDERR_LIMIT = 4 * 1024;
const REVISION_RE = /^[a-f0-9]{64}$/u;
const UNDO_TOKEN_RE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

/**
 * States the UI may set, as a subset of the canonical list.
 *
 * The interface offers only user-observed workflow decisions. Interview,
 * Offer, Hired and Rejected are allowed because their controls name the exact
 * event the user is recording; none is inferred from a generic stage move.
 */
const UI_STATES = new Set([
  'Evaluated',
  'Applied',
  'Responded',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
  'Discarded',
  'SKIP',
]);

function controlError(message, code = 'INVALID_STATUS_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** The canonical labels, read from the same file set-status.mjs validates against. */
export function canonicalStates() {
  const doc = yaml.load(readFileSync(join(ROOT, 'templates', 'states.yml'), 'utf8'));
  return new Set((doc?.states ?? []).map(s => s.label).filter(Boolean));
}

export function validateStatusRequest(value, allowed = canonicalStates()) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw controlError('status-control request must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported status-control field: ${key}`);
  }
  if (value.version !== APPLICATION_API_VERSION) {
    throw controlError(`unsupported status-control version: ${String(value.version ?? '')}`);
  }
  if (!['set', 'restore'].includes(value.action)) {
    throw controlError(`unsupported status-control action: ${String(value.action ?? '')}`);
  }
  if (!Number.isSafeInteger(value.roleNum) || value.roleNum <= 0 || value.roleNum > MAX_ROLE_NUM) {
    throw controlError('roleNum must be a positive integer');
  }
  if (typeof value.expectedRevision !== 'string' || !REVISION_RE.test(value.expectedRevision)) {
    throw controlError('expectedRevision must be a lowercase SHA-256 row revision');
  }
  if (typeof value.undoToken !== 'string' || !UNDO_TOKEN_RE.test(value.undoToken)) {
    throw controlError('undoToken must be an opaque workflow token');
  }
  if (value.action === 'restore') {
    if (value.state !== undefined || value.note !== undefined) {
      throw controlError('restore does not accept state or note');
    }
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: 'restore',
      roleNum: value.roleNum,
      expectedRevision: value.expectedRevision,
      undoToken: value.undoToken,
    });
  }
  if (typeof value.state !== 'string' || !UI_STATES.has(value.state)) {
    throw controlError(
      `state must be one of: ${[...UI_STATES].join(', ')}`,
      'STATE_NOT_ALLOWED',
    );
  }
  // Belt and braces: the UI allowlist is a subset of the canonical file, and a
  // drift between the two should fail here rather than reach the tracker.
  if (!allowed.has(value.state)) {
    throw controlError(`state is not canonical in templates/states.yml: ${value.state}`);
  }
  if (value.note !== undefined) {
    if (typeof value.note !== 'string') throw controlError('note must be a string');
    if (value.note.length > MAX_NOTE) throw controlError('note is too long');
    // The note reaches a CLI argument and a markdown table cell. Newlines and
    // pipes would break the row; control characters have no business here.
    if (/[\u0000-\u001f\u007f|]/u.test(value.note)) {
      throw controlError('note contains characters that are not allowed in a tracker cell');
    }
  }
  const markerMatch = typeof value.note === 'string'
    ? value.note.match(
      new RegExp(`\\[frontrunner-before:${value.undoToken}:([A-Za-z]+):(triage|prepare|ready|applied|active|closed):([A-Za-z]+)\\]`, 'u'),
    )
    : null;
  if (!markerMatch) {
    throw controlError('set note must carry its workflow undo marker');
  }
  if (!allowed.has(markerMatch[1]) || markerMatch[3] !== value.state) {
    throw controlError('workflow undo marker does not match the requested transition');
  }

  return Object.freeze({
    version: APPLICATION_API_VERSION,
    action: 'set',
    roleNum: value.roleNum,
    state: value.state,
    note: value.note?.trim() || undefined,
    expectedRevision: value.expectedRevision,
    undoToken: value.undoToken,
  });
}

/** Fixed argv. Nothing from the request becomes a flag. */
export function buildSetStatusArgs(request) {
  const args = [
    SET_STATUS,
    '--row',
    String(request.roleNum),
    request.state,
    '--json',
    '--expect-revision',
    request.expectedRevision,
  ];
  if (request.note) args.push('--note', request.note);
  return args;
}

/**
 * Resolve Undo from the tracker's own bounded history marker. The browser
 * cannot name the state to restore.
 */
export function buildRestoreStatusArgs(
  roleNum,
  undoToken,
  expectedRevision,
  allowed = canonicalStates(),
) {
  const tracker = resolveTrackerPath(ROOT);
  const lines = readFileSync(tracker, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  const matches = lines
    .map(line => parseTrackerRow(line, columns))
    .filter(row => row?.num === roleNum);
  if (matches.length !== 1) {
    throw controlError(
      matches.length === 0
        ? `No tracker row with #${roleNum}`
        : `Tracker #${roleNum} is ambiguous`,
      'STATUS_RESTORE_UNAVAILABLE',
    );
  }
  const actualRevision = createHash('sha256').update(matches[0].raw).digest('hex');
  if (actualRevision !== expectedRevision) {
    throw controlError(
      'This role changed after the move. Reload before trying another action.',
      'STATUS_STALE',
    );
  }
  if (matches[0].notes.includes(`[frontrunner-undone:${undoToken}]`)) {
    throw controlError('This move has already been undone', 'STATUS_RESTORE_USED');
  }
  const markers = [...matches[0].notes.matchAll(
    /\[frontrunner-before:([a-f0-9-]+):([A-Za-z]+):(triage|prepare|ready|applied|active|closed):([A-Za-z]+)\]/gu,
  )];
  const marker = markers.findLast(match => match[1] === undoToken);
  const state = marker?.[2];
  const stage = marker?.[3];
  const movedTo = marker?.[4];
  if (!state || !allowed.has(state)) {
    throw controlError('No previous state is available for this role', 'STATUS_RESTORE_UNAVAILABLE');
  }
  if (matches[0].status !== movedTo) {
    throw controlError(
      'This role no longer has the status created by that move',
      'STATUS_STALE',
    );
  }
  const notes = [`[frontrunner-undone:${undoToken}]`];
  if (stage === 'triage' || stage === 'prepare' || stage === 'ready') {
    notes.push(`[frontrunner-stage:${stage}]`);
  }
  const args = [
    SET_STATUS,
    '--row',
    String(roleNum),
    state,
    '--json',
    '--expect-revision',
    expectedRevision,
    '--note',
    notes.join('; '),
  ];
  return args;
}

export function runSetStatus(args, options = {}) {
  const abortSignal = options.signal;
  if (abortSignal?.aborted) {
    return Promise.reject(controlError('the tracker change was cancelled', 'STATUS_CANCELLED'));
  }
  const spawn = options.spawn ?? nodeSpawn;
  return new Promise((resolvePromise, reject) => {
    let child;
    let settled = false;
    let stoppingError = null;
    let timeout;
    let forceTimer;
    let stdout = '';
    let stderr = '';

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      abortSignal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolvePromise(value);
    };

    const treeOptions = {
      platform: options.platform,
      processKill: options.processKill,
      windowsTreeKill: options.windowsTreeKill,
    };
    const requestStop = (error) => {
      if (settled || stoppingError) return;
      stoppingError = error;
      const signalled = signalProcessTree(child, 'SIGTERM', treeOptions);
      if (!signalled) {
        finish(error);
        return;
      }
      forceTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', treeOptions);
        finish(error);
      }, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
    };
    const abort = () => requestStop(
      controlError('the tracker change was cancelled', 'STATUS_CANCELLED'),
    );

    try {
      child = spawn(process.execPath, args, {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        detached: shouldDetachProcessTree(options.platform),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(error);
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > STDOUT_LIMIT) {
        stdout = stdout.slice(0, STDOUT_LIMIT);
        requestStop(controlError(
          'the tracker returned too much data',
          'STATUS_OUTPUT_TOO_LARGE',
        ));
      }
    });
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
    });
    child.once('error', (error) => {
      if (!stoppingError) finish(error);
    });
    child.once('close', code => {
      if (stoppingError) return;
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      // set-status refuses ambiguous rows with a candidate list rather than
      // editing the wrong one. That is a message worth passing through.
      finish(controlError(
        (stderr || stdout).replace(/[\0\r\n]+/gu, ' ').trim().slice(0, 500)
          || `the tracker rejected the change (exit ${String(code)})`,
        'STATUS_REJECTED',
      ));
    });

    if (abortSignal?.aborted) {
      abort();
    } else {
      abortSignal?.addEventListener('abort', abort, { once: true });
    }
    if (!settled && !stoppingError) {
      timeout = setTimeout(() => requestStop(
        controlError('the tracker did not respond in time', 'STATUS_TIMEOUT'),
      ), options.timeoutMs ?? TIMEOUT_MS);
    }
  });
}

function parseWriterResult(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw controlError('the tracker returned an invalid response', 'STATUS_INVALID_RESPONSE');
  }
  if (
    value === null
    || typeof value !== 'object'
    || !REVISION_RE.test(value.revision ?? '')
  ) {
    throw controlError('the tracker returned an incomplete response', 'STATUS_INVALID_RESPONSE');
  }
  return value;
}

/**
 * Reconcile the idempotent follow-up side effects recorded in tracker notes.
 *
 * The tracker transition is the durable source of truth. If a process dies
 * after that atomic write but before follow-ups.md is replaced, the next
 * workflow request repairs the missing pin (or removes a pin owned by an
 * already-undone move) without replaying the status transition.
 */
export async function reconcileWorkflowFollowups(options = {}) {
  const tracker = options.trackerPath ?? resolveTrackerPath(ROOT);
  const lines = readFileSync(tracker, 'utf8').split('\n');
  const columns = resolveColumns(lines);
  const work = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, columns);
    if (!row) continue;
    if (options.roleNum != null && row.num !== options.roleNum) continue;
    const undone = new Set(
      [...row.notes.matchAll(/\[frontrunner-undone:([a-f0-9-]+)\]/gu)]
        .map(match => match[1]),
    );
    for (const marker of row.notes.matchAll(
      /\[frontrunner-before:([a-f0-9-]+):([A-Za-z]+):(triage|prepare|ready|applied|active|closed):([A-Za-z]+)\]/gu,
    )) {
      const token = marker[1];
      if (!UNDO_TOKEN_RE.test(token)) continue;
      if (marker[4] === 'Applied') {
        if (!undone.has(token) && row.status === 'Applied') {
          work.push(() => seedFollowup(row.num, { ...options, workflowToken: token }));
        } else {
          // Once the role leaves Applied, its workflow-owned date must stop
          // overriding Responded/Interview cadence. Undoing back to Applied
          // re-seeds the still-live earlier marker below.
          work.push(() => removeWorkflowSeed(row.num, token, options));
        }
      }
      if (work.length >= 500) break;
    }
    if (work.length >= 500) break;
  }
  const repaired = [];
  const failed = [];
  for (const operation of work) {
    try {
      repaired.push(await operation());
    } catch (error) {
      failed.push(String(error?.message ?? error).slice(0, 300));
    }
  }
  return { repaired, failed, truncated: work.length >= 500 };
}

export async function main({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  runStatus = runSetStatus,
  repairSideEffects = reconcileWorkflowFollowups,
} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const request = validateStatusRequest(await readBoundedRequest(input));
    await repairSideEffects();
    const args = request.action === 'restore'
      ? buildRestoreStatusArgs(
        request.roleNum,
        request.undoToken,
        request.expectedRevision,
      )
      : buildSetStatusArgs(request);
    const writerResult = parseWriterResult(
      await runStatus(args, { signal: controller.signal }),
    );
    let followup = null;
    try {
      const recovery = await repairSideEffects({ roleNum: request.roleNum });
      if (recovery?.failed?.length) {
        throw new Error(recovery.failed.join('; '));
      }
      if (recovery?.repaired?.length) {
        followup = { reconciled: recovery.repaired.length };
      }
    } catch (error) {
      // The tracker move is already durable. Its workflow marker is a recovery
      // journal: a later reconciliation can safely retry this idempotent side
      // effect without replaying the status transition.
      followup = {
        pending: true,
        error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 300),
      };
    }
    const result = {
      version: APPLICATION_API_VERSION,
      roleNum: request.roleNum,
      action: request.action,
      ...(request.state ? { state: request.state } : {}),
      revision: writerResult.revision,
      undoToken: request.undoToken,
      ...(followup ? { followup } : {}),
    };
    output.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    const code = error?.code ?? 'STATUS_CONTROL_PROTOCOL_ERROR';
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: /^STATUS_/u.test(code) ? 'status_error' : 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code,
    })}\n`);
    process.exitCode = 1;
    return null;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
