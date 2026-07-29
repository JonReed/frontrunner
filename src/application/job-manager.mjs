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
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ROOT } from '#paths';
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
  const idFactory = options.idFactory
    ?? (roleNum => `cv-${roleNum}-${now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 6)}`);

  const ensureDir = () => mkdirSync(jobsDir, { recursive: true });

  const jobPath = (id) => {
    if (!JOB_ID.test(id)) throw new Error('invalid job id');
    return join(jobsDir, `${id}.json`);
  };

  const logPath = id => join(jobsDir, `${id}.log`);

  const write = (job) => {
    if (!validStoredJob(job)) throw new Error('invalid application job state');
    ensureDir();
    const target = jobPath(job.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(job, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
  };

  const appendLog = (id, text) => {
    try {
      const file = logPath(id);
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      writeFileSync(file, boundedTail(`${current}${String(text ?? '')}`), { mode: 0o600 });
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

  const reapIfStale = (job) => {
    if (job.status !== 'running' || now() - job.startedAt < STALE_JOB_MS) return job;
    const reaped = {
      ...job,
      status: 'failed',
      finishedAt: now(),
      error: 'Timed out. The CV build stopped unexpectedly and can be tried again.',
    };
    write(reaped);
    return reaped;
  };

  const readJob = (id) => {
    try {
      const job = JSON.parse(readFileSync(jobPath(id), 'utf8'));
      if (!validStoredJob(job)) return null;
      const current = reapIfStale(job);
      if (current.status === 'running') {
        current.stage = stageFromLog(id) ?? current.stage;
      }
      return current;
    } catch {
      return null;
    }
  };

  const listJobs = () => {
    ensureDir();
    return readdirSync(jobsDir)
      .filter(file => file.endsWith('.json') && JOB_ID.test(file.slice(0, -5)))
      .map(file => readJob(file.slice(0, -5)))
      .filter(Boolean)
      .sort((left, right) => right.startedAt - left.startedAt);
  };

  const runningJobFor = roleNum => (
    listJobs().find(job => job.roleNum === roleNum && job.status === 'running') ?? null
  );

  const finish = (job, result) => {
    const tail = technicalTail(result.outputTail);
    write({
      ...job,
      status: result.status === 'succeeded' ? 'done' : 'failed',
      finishedAt: result.finishedAt ?? now(),
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : undefined,
      tail: tail || undefined,
      error: result.status === 'succeeded' ? undefined : publicFailure(result),
    });
  };

  const failUnexpectedly = (job, error) => {
    write({
      ...job,
      status: 'failed',
      finishedAt: now(),
      error: String(error?.message ?? error ?? 'The secure CV builder failed to start.').slice(0, 1_000),
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
      const existing = runningJobFor(request.input.roleNum);
      if (existing) return existing;

      const id = idFactory(request.input.roleNum);
      if (!JOB_ID.test(id)) throw new Error('job id factory returned an invalid id');
      writeFileSync(logPath(id), '', { mode: 0o600 });
      const job = {
        id,
        roleNum: request.input.roleNum,
        kind: 'build-cv',
        status: 'running',
        startedAt: now(),
      };
      write(job);

      const operation = Promise.resolve().then(() => execute(request, {
        runId: id,
        signal,
        onEvent(event) {
          if (event.type === 'output') appendLog(id, event.text);
        },
      }));
      const completion = operation
        .then(result => finish(job, result))
        .catch(error => failUnexpectedly(job, error));
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
    startCvBuild,
  });
}
