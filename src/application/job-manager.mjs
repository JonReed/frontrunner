/**
 * Persistent local job state for application-service consumers.
 *
 * Presentation layers may reload while a backend operation is running, so the
 * durable truth is a small atomic JSON file rather than an in-memory registry.
 * A cross-process claim serializes the check-and-create step: two simultaneous
 * UI requests for one role can never launch two paid model operations.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { withFileLock } from '../lib/file-lock.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { withPipelineLock } from '../tracker/pipeline-lock.mjs';
import {
  APPLICATION_API_VERSION,
  validateApplicationRequest,
} from './contract.mjs';
import { executeApplicationOperation } from './service.mjs';

const DEFAULT_JOBS_DIR = join(ROOT, 'ui', '.jobs');
const OPERATION_TIMEOUT_MS = 5 * 60_000;
const STALE_JOB_MS = OPERATION_TIMEOUT_MS + 10_000;
const LOG_LIMIT = 64 * 1024;
const RESULT_TAIL_LIMIT = 16 * 1024;
const DEFAULT_CANCEL_POLL_MS = 100;
const JOB_ID = /^cv-\d+-[a-z0-9]+$/u;

const STAGE_SIGNALS = Object.freeze([
  [/reading|fetching|job description|\bJD\b/iu, 'Reading the job description'],
  [/cv\.md|profile\.yml|comparing|match/iu, 'Comparing it with your CV'],
  [/tailor|rewrit|summary|bullet/iu, 'Rewriting your experience for this role'],
  [/build-cv-html|html/iu, 'Laying out your CV'],
  [/generate-pdf|playwright|chromium|pdf/iu, 'Building the PDF'],
  [/pdf generated|✅|saved/iu, 'Finishing up'],
]);

function boundedTail(text, max = LOG_LIMIT) {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(-max);
}

function technicalTail(text) {
  return boundedTail(text, RESULT_TAIL_LIMIT)
    .trim()
    .split('\n')
    .slice(-6)
    .join('\n');
}

function publicFailure(result) {
  const tail = technicalTail(result.outputTail);
  if (/not logged in|\/login/iu.test(tail)) {
    return 'The Claude CLI is not signed in. Frontrunner needs it connected to your AI subscription.';
  }
  if (/ENOENT/iu.test(String(result.error ?? ''))) {
    return 'Could not start the secure CV builder. Check that Node and the Claude CLI are installed.';
  }
  if (result.status === 'timed_out') {
    return 'Timed out. The CV build took longer than five minutes and was stopped.';
  }
  if (result.status === 'cancelled') return 'The CV build was cancelled.';
  return result.error || `The run failed (exit code ${String(result.exitCode ?? 'unknown')}).`;
}

function validStoredJob(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.id === 'string'
    && JOB_ID.test(value.id)
    && Number.isSafeInteger(value.roleNum)
    && value.roleNum > 0
    && value.roleNum <= 999_999
    && value.id.startsWith(`cv-${String(value.roleNum)}-`)
    && value.kind === 'build-cv'
    && ['running', 'done', 'failed'].includes(value.status)
    && Number.isSafeInteger(value.startedAt)
    && value.startedAt >= 0
    && (value.finishedAt === undefined || Number.isSafeInteger(value.finishedAt))
    && (value.exitCode === undefined || Number.isInteger(value.exitCode))
    && (value.tail === undefined || (typeof value.tail === 'string' && value.tail.length <= RESULT_TAIL_LIMIT))
    && (value.stage === undefined || (typeof value.stage === 'string' && value.stage.length <= 120))
    && (value.error === undefined || (typeof value.error === 'string' && value.error.length <= 1_000)),
  );
}

export function createApplicationJobManager(options = {}) {
  const jobsDir = options.jobsDir ?? DEFAULT_JOBS_DIR;
  const execute = options.execute ?? executeApplicationOperation;
  const withLock = options.withLock ?? withPipelineLock;
  const signal = options.signal;
  const onOperation = typeof options.onOperation === 'function'
    ? options.onOperation
    : () => {};
  const now = options.now ?? (() => Date.now());
  const cancelPollMs = options.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS;
  if (!Number.isSafeInteger(cancelPollMs) || cancelPollMs < 1) {
    throw new TypeError('cancelPollMs must be a positive integer');
  }
  const idFactory = options.idFactory
    ?? (roleNum => `cv-${roleNum}-${now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 6)}`);

  const ensureDir = () => mkdirSync(jobsDir, { recursive: true });

  const jobPath = (id) => {
    if (!JOB_ID.test(id)) throw new Error('invalid job id');
    return join(jobsDir, `${id}.json`);
  };

  const logPath = id => join(jobsDir, `${id}.log`);
  const cancelPath = id => join(jobsDir, `${id}.cancel`);

  const writeUnlocked = (job) => {
    if (!validStoredJob(job)) throw new Error('invalid application job state');
    ensureDir();
    replaceFileAtomic(jobPath(job.id), `${JSON.stringify(job, null, 2)}\n`, {
      mode: 0o600,
    });
  };

  const appendLog = (id, text) => {
    try {
      const file = logPath(id);
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      replaceFileAtomic(file, boundedTail(`${current}${String(text ?? '')}`), {
        mode: 0o600,
      });
    } catch {
      // Diagnostic output must never change the backend operation result.
    }
  };

  const stageFromLog = (id) => {
    try {
      const log = readFileSync(logPath(id), 'utf8');
      let found;
      for (const [pattern, label] of STAGE_SIGNALS) {
        if (pattern.test(log)) found = label;
      }
      return found;
    } catch {
      return undefined;
    }
  };

  const reapIfStaleUnlocked = (job) => {
    if (job.status !== 'running' || now() - job.startedAt < STALE_JOB_MS) return job;
    const reaped = {
      ...job,
      status: 'failed',
      finishedAt: now(),
      error: 'Timed out. The CV build stopped unexpectedly and can be tried again.',
    };
    writeUnlocked(reaped);
    rmSync(cancelPath(job.id), { force: true });
    return reaped;
  };

  const readStoredJob = (id) => {
    try {
      const job = JSON.parse(readFileSync(jobPath(id), 'utf8'));
      return validStoredJob(job) ? job : null;
    } catch {
      return null;
    }
  };

  const readJob = async (id) => {
    let target;
    try {
      target = jobPath(id);
    } catch {
      return null;
    }
    if (!existsSync(target)) return null;
    return withFileLock(target, async () => {
      const job = readStoredJob(id);
      if (!job) return null;
      const current = reapIfStaleUnlocked(job);
      if (current.status === 'running') {
        return {
          ...current,
          stage: existsSync(cancelPath(id))
            ? 'Cancelling'
            : (stageFromLog(id) ?? current.stage),
        };
      }
      return current;
    });
  };

  const listJobs = async () => {
    ensureDir();
    const jobs = await Promise.all(readdirSync(jobsDir)
      .filter(file => file.endsWith('.json') && JOB_ID.test(file.slice(0, -5)))
      .map(file => readJob(file.slice(0, -5))));
    return jobs
      .filter(Boolean)
      .sort((left, right) => right.startedAt - left.startedAt);
  };

  const runningJobFor = async roleNum => (
    (await listJobs()).find(
      job => job.roleNum === roleNum && job.status === 'running',
    ) ?? null
  );

  const transitionTerminal = async (id, build) => {
    const target = jobPath(id);
    return withFileLock(target, async () => {
      const current = readStoredJob(id);
      if (!current || current.status !== 'running') return current;
      const next = build(current);
      writeUnlocked(next);
      rmSync(cancelPath(id), { force: true });
      return next;
    });
  };

  const finish = (job, result) => {
    const tail = technicalTail(result.outputTail);
    return transitionTerminal(job.id, current => ({
      ...current,
      status: result.status === 'succeeded' ? 'done' : 'failed',
      finishedAt: result.finishedAt ?? now(),
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : undefined,
      tail: tail || undefined,
      error: result.status === 'succeeded' ? undefined : publicFailure(result),
    }));
  };

  const failUnexpectedly = (job, error) => transitionTerminal(job.id, current => ({
    ...current,
    status: 'failed',
    finishedAt: now(),
    error: String(error?.message ?? error ?? 'The secure CV builder failed to start.').slice(0, 1_000),
  }));

  const cancelJob = async (id) => {
    let target;
    try {
      target = jobPath(id);
    } catch {
      return null;
    }
    if (!existsSync(target)) return null;
    return withFileLock(target, async () => {
      const current = readStoredJob(id);
      if (!current) return null;
      const job = reapIfStaleUnlocked(current);
      if (job.status !== 'running') return job;
      replaceFileAtomic(cancelPath(id), `${JSON.stringify({
        version: APPLICATION_API_VERSION,
        requestedAt: now(),
      })}\n`, { mode: 0o600 });
      return { ...job, stage: 'Cancelling' };
    });
  };

  const startCvBuild = async (roleNum, jobUrl, reportPath) => {
    const request = validateApplicationRequest({
      version: APPLICATION_API_VERSION,
      operation: 'cv.build',
      input: {
        roleNum,
        jobUrl,
        reportPath: reportPath ?? undefined,
      },
      idempotencyKey: Number.isSafeInteger(roleNum) ? `cv:${String(roleNum)}` : undefined,
    });
    ensureDir();
    const claimPath = join(jobsDir, `role-${String(request.input.roleNum)}.claim`);
    return withLock(claimPath, async () => {
      const existing = await runningJobFor(request.input.roleNum);
      if (existing) return existing;

      const id = idFactory(request.input.roleNum);
      if (!JOB_ID.test(id)) throw new Error('job id factory returned an invalid id');
      replaceFileAtomic(logPath(id), '', { mode: 0o600 });
      const job = {
        id,
        roleNum: request.input.roleNum,
        kind: 'build-cv',
        status: 'running',
        startedAt: now(),
      };
      await withFileLock(jobPath(id), async () => writeUnlocked(job));

      const operationController = new AbortController();
      const abortOperation = () => operationController.abort();
      if (signal?.aborted) abortOperation();
      else signal?.addEventListener('abort', abortOperation, { once: true });
      const pollCancellation = () => {
        if (existsSync(cancelPath(id))) abortOperation();
      };
      pollCancellation();
      const cancelTimer = setInterval(pollCancellation, cancelPollMs);

      const operation = Promise.resolve().then(() => execute(request, {
        runId: id,
        signal: operationController.signal,
        onEvent(event) {
          if (event.type === 'output') appendLog(id, event.text);
        },
      }));
      const completion = operation
        .then(result => finish(job, result))
        .catch(error => failUnexpectedly(job, error))
        .finally(() => {
          clearInterval(cancelTimer);
          signal?.removeEventListener('abort', abortOperation);
          rmSync(cancelPath(id), { force: true });
        });
      try {
        onOperation(completion);
      } catch {
        // Observers cannot change job execution or persistence.
      }
      return job;
    });
  };

  return Object.freeze({
    readJob,
    listJobs,
    runningJobFor,
    cancelJob,
    startCvBuild,
  });
}
