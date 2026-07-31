/**
 * Persistent local job state for application-service consumers.
 *
 * Presentation layers may reload while a backend operation is running, so the
 * durable truth is a small atomic JSON file rather than an in-memory registry.
 * A cross-process claim serializes the check-and-create step: two simultaneous
 * clients using the same trusted operation key can never launch duplicate
 * model, browser, scanner, or pipeline work.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ROOT, STATE_DIR } from '#paths';
import { withFileLock } from '../lib/file-lock.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { readBoundedRegularFileSync } from '../lib/safe-file-read.mjs';
import { withPipelineLock } from '../tracker/pipeline-lock.mjs';
import {
  APPLICATION_API_VERSION,
  APPLICATION_OPERATIONS,
  validateApplicationRequest,
} from './contract.mjs';
import {
  applicationOperationResourceKey,
  resolveApplicationOperation,
} from './operations.mjs';
import { executeApplicationOperation } from './service.mjs';
import {
  applicationRunHistoryRecord,
  writeRunHistorySafely,
} from './run-history.mjs';
import {
  APPLICATION_JOB_ID_RE,
  cleanupOrphanJobArtifacts,
  DEFAULT_ORPHAN_ARTIFACT_RETENTION_MS,
} from './job-storage-cleanup.mjs';
import {
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
} from './progress.mjs';

const DEFAULT_JOBS_DIR = join(STATE_DIR, 'application-jobs');
const LEGACY_CV_STALE_MS = 5 * 60_000 + 10_000;
const LOG_LIMIT = 64 * 1024;
const RESULT_TAIL_LIMIT = 16 * 1024;
const JOB_STATE_LIMIT = 32 * 1024;
const PROGRESS_STATE_LIMIT = 2 * 1024;
const DEFAULT_CANCEL_POLL_MS = 100;
export const DEFAULT_TERMINAL_JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_MAX_TERMINAL_JOBS = 200;
export { APPLICATION_JOB_ID_RE, DEFAULT_ORPHAN_ARTIFACT_RETENTION_MS };

/**
 * `roleScoped` marks the operations whose job belongs to one tracker row.
 *
 * These carry a roleNum, take a role-prefixed id, and dedupe per role rather
 * than globally — two roles may have documents building at once, but one role
 * must never pay for the same document twice. It was implicit in a chain of
 * `operation === 'cv.build'` checks until the cover letter became the second
 * such operation and every one of them would have silently excluded it.
 */
const OPERATION_META = Object.freeze({
  'cv.build': Object.freeze({
    prefix: 'cv',
    kind: 'build-cv',
    roleScoped: true,
    initialStage: 'Starting the CV build',
  }),
  'cover.build': Object.freeze({
    prefix: 'cover',
    kind: 'build-cover',
    roleScoped: true,
    initialStage: 'Starting the covering letter',
  }),
  'pipeline.run': Object.freeze({
    prefix: 'pipeline',
    kind: 'pipeline',
    initialStage: 'Starting the pipeline',
  }),
  'pipeline.prepare': Object.freeze({
    prefix: 'prepare',
    kind: 'prepare-pipeline',
    initialStage: 'Preparing the pipeline',
  }),
  'scan.run': Object.freeze({
    prefix: 'scan',
    kind: 'scan',
    initialStage: 'Starting the scan',
  }),
  'companies.discover': Object.freeze({
    prefix: 'companies',
    kind: 'discover-companies',
    initialStage: 'Looking up their job boards',
  }),
  'companies.suggest': Object.freeze({
    prefix: 'suggest',
    kind: 'suggest-companies',
    initialStage: 'Reading your CV',
  }),
});

const STAGE_SIGNALS = Object.freeze({
  'cover.build': Object.freeze([
    [/reading|fetching|job description|\bJD\b/iu, 'Reading the job description'],
    [/writing|letter|draft/iu, 'Writing your covering letter'],
    [/generate-cover|generate-pdf|playwright|chromium|pdf/iu, 'Building the PDF'],
    [/pdf generated|✅|saved/iu, 'Finishing up'],
  ]),
  'cv.build': Object.freeze([
    [/reading|fetching|job description|\bJD\b/iu, 'Reading the job description'],
    [/cv\.md|profile\.yml|comparing|match/iu, 'Comparing it with your CV'],
    [/tailor|rewrit|summary|bullet/iu, 'Rewriting your experience for this role'],
    [/build-cv-html|html/iu, 'Laying out your CV'],
    [/generate-pdf|playwright|chromium|pdf/iu, 'Building the PDF'],
    [/pdf generated|✅|saved/iu, 'Finishing up'],
  ]),
  'pipeline.run': Object.freeze([
    [/\bscan(?:ning)?\b/iu, 'Scanning job sources'],
    [/\bcach(?:e|ing)\b|job description|\bJD\b/iu, 'Caching job descriptions'],
    [/liveness|checking links/iu, 'Checking which roles are still live'],
    [/prefilter|filtering/iu, 'Filtering obvious mismatches'],
    [/evaluat|model/iu, 'Evaluating the shortlist'],
    [/complete|finished|summary/iu, 'Finishing the pipeline'],
  ]),
  'pipeline.prepare': Object.freeze([
    [/\bscan(?:ning)?\b/iu, 'Scanning job sources'],
    [/\bcach(?:e|ing)\b|job description|\bJD\b/iu, 'Caching job descriptions'],
    [/liveness|checking links/iu, 'Checking which roles are still live'],
    [/prefilter|filtering/iu, 'Filtering obvious mismatches'],
    [/complete|finished|summary/iu, 'Finishing preparation'],
  ]),
  'companies.suggest': Object.freeze([
    [/reading|cv/iu, 'Reading your CV'],
    [/choosing|match|employers/iu, 'Choosing employers that match your background'],
  ]),
  'companies.discover': Object.freeze([
    [/probing|resolving|checking/iu, 'Looking up their job boards'],
    [/resolved|matched|added/iu, 'Adding the ones that were found'],
  ]),
  'scan.run': Object.freeze([
    [/portal|provider|board/iu, 'Scanning job sources'],
    [/found|added|dedup/iu, 'Recording new roles'],
    [/complete|finished|summary/iu, 'Finishing the scan'],
  ]),
});

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

function readBoundedRegularFile(file, maxBytes) {
  try {
    return readBoundedRegularFileSync(file, {
      maxBytes,
      allowMissing: true,
      label: 'application job state',
    });
  } catch {
    return null;
  }
}

function operationFor(job) {
  if (APPLICATION_OPERATIONS.includes(job?.operation)) return job.operation;
  // Jobs written before `operation` was persisted carry only `kind`.
  return job?.kind === 'build-cv' ? 'cv.build' : null;
}

/** True for operations whose job belongs to a single tracker row. */
function isRoleScoped(operation) {
  return OPERATION_META[operation]?.roleScoped === true;
}

function dedupeKeyFor(job) {
  const operation = operationFor(job);
  if (isRoleScoped(operation) && Number.isSafeInteger(job?.roleNum)) {
    return `${operation}:tracker:${String(job.roleNum)}`;
  }
  return operation && !isRoleScoped(operation) ? operation : null;
}

export class ApplicationOperationBusyError extends Error {
  constructor(requestedOperation, activeJob) {
    const activeOperation = operationFor(activeJob);
    super(
      `${requestedOperation} cannot start while ${activeOperation} `
      + `is running as ${activeJob.id}`,
    );
    this.name = 'ApplicationOperationBusyError';
    this.code = 'APPLICATION_OPERATION_BUSY';
    this.requestedOperation = requestedOperation;
    this.activeJob = Object.freeze({
      id: activeJob.id,
      operation: activeOperation,
      startedAt: activeJob.startedAt,
      costsTokens: Boolean(activeJob.costsTokens),
    });
  }
}

function idMatchesJob(id, operation, roleNum) {
  const meta = OPERATION_META[operation];
  if (!meta || !APPLICATION_JOB_ID_RE.test(id)) return false;
  return meta.roleScoped
    ? Number.isSafeInteger(roleNum) && id.startsWith(`${meta.prefix}-${String(roleNum)}-`)
    : id.startsWith(`job-${meta.prefix}-`);
}

function publicFailure(job, result) {
  const tail = technicalTail(result.outputTail);
  const operation = operationFor(job);
  /*
    An expired session is the commonest failure of all and used to surface as
    a bare exit code: the CLI reports "Failed to authenticate: OAuth session
    expired and could not be refreshed", which matched none of the old
    patterns. `claude auth status` also keeps reporting a signed-in session
    until something forces a refresh, so the pre-flight cannot catch this —
    the run itself is the first honest signal, and it has to say so plainly.
  */
  if (/not logged in|\/login|failed to authenticate|oauth|session expired|could not be refreshed/iu.test(tail)) {
    return 'Your Claude sign-in has expired. Reconnect it on My details, then try again — nothing was charged.';
  }
  if (/ENOENT/iu.test(String(result.error ?? ''))) {
    if (operation === 'cv.build') {
      return 'Could not start the secure CV builder. Check that Node and the Claude CLI are installed.';
    }
    if (operation === 'cover.build') {
      return 'Could not start the secure letter writer. Check that Node and the Claude CLI are installed.';
    }
    return 'Could not start the secure backend operation. Check that Frontrunner is installed correctly.';
  }
  // The PDF renderer is a separate download, and its absence used to surface
  // as a bare exit code at the very end of a run the user had already paid a
  // model call for. The role page now checks before offering the button, so
  // reaching here means the browser disappeared mid-run — say what it is.
  if (/playwright|executable doesn't exist|browserType\.launch|chromium/iu.test(tail)) {
    return 'The PDF maker is missing. Open the role again and Frontrunner will offer to download it.';
  }
  // Every scan reads this file, and its absence is the one failure a brand-new
  // installation is most likely to hit. The raw message names a path and tells
  // the user to run onboarding they have already completed.
  if (/portals\.yml/iu.test(tail)) {
    return 'Your search settings are missing. Open Where to search and Frontrunner will set them up.';
  }
  if (result.status === 'timed_out') {
    if (operation === 'cv.build') {
      return 'Timed out. The CV build took longer than five minutes and was stopped.';
    }
    if (operation === 'cover.build') {
      return 'Timed out. The covering letter took longer than five minutes and was stopped.';
    }
    return 'Timed out. The backend operation exceeded its configured limit and was stopped.';
  }
  if (result.status === 'cancelled') {
    if (operation === 'cv.build') return 'The CV build was cancelled.';
    if (operation === 'cover.build') return 'The covering letter was cancelled.';
    return 'The backend operation was cancelled.';
  }
  return result.error || `The run failed (exit code ${String(result.exitCode ?? 'unknown')}).`;
}

function validStoredJob(value) {
  const operation = operationFor(value);
  const meta = operation ? OPERATION_META[operation] : null;
  const cvJob = isRoleScoped(operation);
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.id === 'string'
    && APPLICATION_JOB_ID_RE.test(value.id)
    && meta
    && value.kind === meta.kind
    && (
      cvJob
        ? (
          Number.isSafeInteger(value.roleNum)
          && value.roleNum > 0
          && value.roleNum <= 999_999
        )
        : value.roleNum === undefined
    )
    && idMatchesJob(value.id, operation, value.roleNum)
    && (
      value.operation === undefined
      || value.operation === operation
    )
    && (
      (cvJob && value.dedupeKey === undefined)
      || value.dedupeKey === dedupeKeyFor(value)
    )
    && ['running', 'done', 'failed'].includes(value.status)
    && Number.isSafeInteger(value.startedAt)
    && value.startedAt >= 0
    && (
      (cvJob && value.staleAt === undefined)
      || (Number.isSafeInteger(value.staleAt) && value.staleAt > value.startedAt)
    )
    && (value.costsTokens === undefined || typeof value.costsTokens === 'boolean')
    && (
      value.status === 'running'
        ? value.finishedAt === undefined
        : (
          Number.isSafeInteger(value.finishedAt)
          && value.finishedAt >= value.startedAt
        )
    )
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
  const auditWriter = options.auditWriter ?? null;
  const onAuditError = typeof options.onAuditError === 'function'
    ? options.onAuditError
    : () => {};
  const onCleanupError = typeof options.onCleanupError === 'function'
    ? options.onCleanupError
    : () => {};
  const terminalJobRetentionMs = options.terminalJobRetentionMs
    ?? DEFAULT_TERMINAL_JOB_RETENTION_MS;
  const orphanArtifactRetentionMs = options.orphanArtifactRetentionMs
    ?? DEFAULT_ORPHAN_ARTIFACT_RETENTION_MS;
  const maxTerminalJobs = options.maxTerminalJobs ?? DEFAULT_MAX_TERMINAL_JOBS;
  if (!Number.isSafeInteger(cancelPollMs) || cancelPollMs < 1) {
    throw new TypeError('cancelPollMs must be a positive integer');
  }
  if (!Number.isSafeInteger(terminalJobRetentionMs) || terminalJobRetentionMs < 0) {
    throw new TypeError('terminalJobRetentionMs must be a non-negative integer');
  }
  if (!Number.isSafeInteger(orphanArtifactRetentionMs) || orphanArtifactRetentionMs < 1) {
    throw new TypeError('orphanArtifactRetentionMs must be a positive integer');
  }
  if (!Number.isSafeInteger(maxTerminalJobs) || maxTerminalJobs < 1) {
    throw new TypeError('maxTerminalJobs must be a positive integer');
  }
  const idFactory = options.idFactory ?? ((request) => {
    const suffix = `${now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 6)}`;
    if (OPERATION_META[request.operation].roleScoped) {
      return `${OPERATION_META[request.operation].prefix}-${String(request.input.roleNum)}-${suffix}`;
    }
    return `job-${OPERATION_META[request.operation].prefix}-${suffix}`;
  });

  const ensureDir = () => mkdirSync(jobsDir, { recursive: true });

  const jobPath = (id) => {
    if (!APPLICATION_JOB_ID_RE.test(id)) throw new Error('invalid job id');
    return join(jobsDir, `${id}.json`);
  };

  const logPath = id => join(jobsDir, `${id}.log`);
  const cancelPath = id => join(jobsDir, `${id}.cancel`);
  const progressPath = id => join(jobsDir, `${id}.progress.json`);

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
      const current = readBoundedRegularFile(file, LOG_LIMIT) ?? '';
      replaceFileAtomic(file, boundedTail(`${current}${String(text ?? '')}`), {
        mode: 0o600,
      });
    } catch {
      // Diagnostic output must never change the backend operation result.
    }
  };

  const stageFromLog = (job) => {
    try {
      const log = readBoundedRegularFile(logPath(job.id), LOG_LIMIT);
      if (log === null) return undefined;
      let found;
      for (const [pattern, label] of STAGE_SIGNALS[operationFor(job)] ?? []) {
        if (pattern.test(log)) found = label;
      }
      return found;
    } catch {
      return undefined;
    }
  };

  const readStructuredProgress = (job) => {
    if (!operationFor(job)?.startsWith('pipeline.')) return undefined;
    try {
      const content = readBoundedRegularFile(progressPath(job.id), PROGRESS_STATE_LIMIT);
      if (content === null) return undefined;
      const progress = JSON.parse(content);
      if (
        progress?.version !== APPLICATION_API_VERSION
        || !PIPELINE_STAGES.includes(progress.stage)
        || !['started', 'completed', 'failed'].includes(progress.state)
        || !Number.isSafeInteger(progress.updatedAt)
        || progress.updatedAt < 0
      ) return undefined;
      if (progress.stage === 'evaluation' && progress.state === 'completed') {
        return operationFor(job) === 'pipeline.prepare'
          ? 'Finishing preparation'
          : 'Finishing the pipeline';
      }
      return PIPELINE_STAGE_LABELS[progress.stage];
    } catch {
      return undefined;
    }
  };

  const writeStructuredProgress = (job, event) => {
    if (
      !operationFor(job)?.startsWith('pipeline.')
      || !PIPELINE_STAGES.includes(event?.stage)
      || !['started', 'completed', 'failed'].includes(event?.state)
      || !Number.isSafeInteger(event?.at)
      || event.at < 0
    ) return;
    try {
      const file = progressPath(job.id);
      let prior;
      try {
        const content = readBoundedRegularFile(file, PROGRESS_STATE_LIMIT);
        prior = content === null ? null : JSON.parse(content);
      } catch {
        prior = null;
      }
      const priorIndex = PIPELINE_STAGES.indexOf(prior?.stage);
      const nextIndex = PIPELINE_STAGES.indexOf(event.stage);
      if (priorIndex > nextIndex) return;
      replaceFileAtomic(file, `${JSON.stringify({
        version: APPLICATION_API_VERSION,
        stage: event.stage,
        state: event.state,
        updatedAt: event.at,
      })}\n`, { mode: 0o600 });
    } catch {
      // Progress persistence is advisory and cannot change execution.
    }
  };

  const reapIfStaleUnlocked = async (job) => {
    const staleAt = job.staleAt ?? (job.startedAt + LEGACY_CV_STALE_MS);
    if (job.status !== 'running' || now() < staleAt) return job;
    const documentJob = isRoleScoped(operationFor(job));
    const reaped = {
      ...job,
      status: 'failed',
      finishedAt: now(),
      error: documentJob
        ? 'Timed out. The document build stopped unexpectedly and can be tried again.'
        : 'Timed out. The backend operation stopped unexpectedly and can be tried again.',
    };
    writeUnlocked(reaped);
    rmSync(cancelPath(job.id), { force: true });
    rmSync(progressPath(job.id), { force: true });
    await writeRunHistorySafely(
      auditWriter,
      applicationRunHistoryRecord({
        runId: job.id,
        operation: operationFor(job),
        status: 'timed_out',
        startedAt: job.startedAt,
        finishedAt: reaped.finishedAt,
        exitCode: null,
        error: reaped.error,
      }, { costsTokens: job.costsTokens }),
      onAuditError,
    );
    return reaped;
  };

  const readStoredJob = (id) => {
    try {
      const content = readBoundedRegularFile(jobPath(id), JOB_STATE_LIMIT);
      if (content === null) return null;
      const job = JSON.parse(content);
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
      const current = await reapIfStaleUnlocked(job);
      if (current.status === 'running') {
        return {
          ...current,
          stage: existsSync(cancelPath(id))
            ? 'Cancelling'
            : (readStructuredProgress(current) ?? stageFromLog(current) ?? current.stage),
        };
      }
      return current;
    });
  };

  const listJobs = async () => {
    ensureDir();
    const jobs = await Promise.all(readdirSync(jobsDir)
      .filter(file => file.endsWith('.json') && APPLICATION_JOB_ID_RE.test(file.slice(0, -5)))
      .map(file => readJob(file.slice(0, -5))));
    return jobs
      .filter(Boolean)
      .sort((left, right) => right.startedAt - left.startedAt);
  };

  const removeTerminalJob = async (job, removeForCount) => {
    const target = jobPath(job.id);
    if (!existsSync(target)) return false;
    return withFileLock(target, async () => {
      const current = readStoredJob(job.id);
      if (!current || current.status === 'running') return false;
      const terminalAt = current.finishedAt ?? current.startedAt;
      const expired = now() - terminalAt > terminalJobRetentionMs;
      if (!expired && !removeForCount) return false;
      rmSync(logPath(job.id), { force: true });
      rmSync(cancelPath(job.id), { force: true });
      rmSync(progressPath(job.id), { force: true });
      rmSync(target, { force: true });
      return true;
    });
  };

  const pruneJobs = async () => {
    const jobs = await listJobs();
    const terminal = jobs
      .filter(job => job.status !== 'running')
      .sort((left, right) =>
        (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt));
    const retainedByCount = new Set(
      terminal
        .filter(job => now() - (job.finishedAt ?? job.startedAt) <= terminalJobRetentionMs)
        .slice(0, maxTerminalJobs)
        .map(job => job.id),
    );
    let removed = 0;
    for (const job of terminal) {
      const expired = now() - (job.finishedAt ?? job.startedAt) > terminalJobRetentionMs;
      const removeForCount = !expired && !retainedByCount.has(job.id);
      if (await removeTerminalJob(job, removeForCount)) removed++;
    }
    const orphanArtifactsRemoved = await cleanupOrphanJobArtifacts({
      jobsDir,
      now: now(),
      retentionMs: orphanArtifactRetentionMs,
      readValidJob: readStoredJob,
    });
    return Object.freeze({
      removed,
      retained: jobs.length - removed,
      orphanArtifactsRemoved,
    });
  };

  const pruneJobsSafely = async () => {
    try {
      return await pruneJobs();
    } catch (error) {
      try {
        onCleanupError(error);
      } catch {
        // Cleanup observability cannot change job execution.
      }
      return null;
    }
  };

  const runningJobFor = async (roleNum, operation = 'cv.build') => (
    (await listJobs()).find(
      job => (
        operationFor(job) === operation
        && job.roleNum === roleNum
        && job.status === 'running'
      ),
    ) ?? null
  );

  const runningJobForDedupeKey = async dedupeKey => (
    (await listJobs()).find(
      job => dedupeKeyFor(job) === dedupeKey && job.status === 'running',
    ) ?? null
  );

  const transitionTerminal = async (id, build) => {
    const target = jobPath(id);
    return withFileLock(target, async () => {
      const current = readStoredJob(id);
      if (!current || current.status !== 'running') {
        return { job: current, changed: false };
      }
      const next = build(current);
      writeUnlocked(next);
      rmSync(cancelPath(id), { force: true });
      rmSync(progressPath(id), { force: true });
      return { job: next, changed: true };
    });
  };

  const finish = async (job, result) => {
    const tail = technicalTail(result.outputTail);
    const transition = await transitionTerminal(job.id, current => ({
      ...current,
      status: result.status === 'succeeded' ? 'done' : 'failed',
      finishedAt: Math.max(
        current.startedAt,
        Number.isSafeInteger(result.finishedAt) ? result.finishedAt : now(),
      ),
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : undefined,
      tail: tail || undefined,
      error: result.status === 'succeeded' ? undefined : publicFailure(job, result),
    }));
    if (transition.changed) {
      await writeRunHistorySafely(
        auditWriter,
        applicationRunHistoryRecord(result, { costsTokens: job.costsTokens }),
        onAuditError,
      );
    }
    return transition.job;
  };

  const failUnexpectedly = async (job, error) => {
    const finishedAt = now();
    const message = String(
      error?.message
      ?? error
      ?? (
        isRoleScoped(operationFor(job))
          ? 'The secure document builder failed to start.'
          : 'The secure backend operation failed to start.'
      ),
    ).slice(0, 1_000);
    const transition = await transitionTerminal(job.id, current => ({
      ...current,
      status: 'failed',
      finishedAt,
      error: message,
    }));
    if (transition.changed) {
      await writeRunHistorySafely(
        auditWriter,
        applicationRunHistoryRecord({
          runId: job.id,
          operation: operationFor(job),
          status: 'failed',
          startedAt: job.startedAt,
          finishedAt,
          exitCode: null,
          error: message,
        }, { costsTokens: job.costsTokens }),
        onAuditError,
      );
    }
    return transition.job;
  };

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
      const job = await reapIfStaleUnlocked(current);
      if (job.status !== 'running') return job;
      replaceFileAtomic(cancelPath(id), `${JSON.stringify({
        version: APPLICATION_API_VERSION,
        requestedAt: now(),
      })}\n`, { mode: 0o600 });
      return { ...job, stage: 'Cancelling' };
    });
  };

  const start = async (value) => {
    const request = validateApplicationRequest(value);
    const spec = resolveApplicationOperation(request);
    const canonicalSpec = resolveApplicationOperation({
      ...request,
      idempotencyKey: null,
    });
    const meta = OPERATION_META[request.operation];
    const dedupeKey = canonicalSpec.dedupeKey;
    const resourceKey = canonicalSpec.resourceKey;
    await pruneJobsSafely();
    ensureDir();
    const claimHash = createHash('sha256').update(resourceKey).digest('hex').slice(0, 24);
    const claimPath = join(jobsDir, `operation-${claimHash}.claim`);
    return withLock(claimPath, async () => {
      const jobs = await listJobs();
      const running = jobs.filter(job => job.status === 'running');
      const existing = running.find(job => dedupeKeyFor(job) === dedupeKey);
      if (existing) return existing;
      const conflicting = running.find(job => (
        applicationOperationResourceKey(operationFor(job), dedupeKeyFor(job)) === resourceKey
      ));
      if (conflicting) {
        throw new ApplicationOperationBusyError(request.operation, conflicting);
      }

      const id = idFactory(request);
      if (!idMatchesJob(id, request.operation, request.input.roleNum)) {
        throw new Error('job id factory returned an invalid id');
      }
      const startedAt = now();
      const job = {
        id,
        ...(meta.roleScoped ? { roleNum: request.input.roleNum } : {}),
        operation: request.operation,
        kind: meta.kind,
        dedupeKey,
        costsTokens: spec.costsTokens,
        status: 'running',
        startedAt,
        staleAt: startedAt + spec.timeoutMs + 10_000,
        stage: meta.initialStage,
      };
      await withFileLock(jobPath(id), async () => {
        replaceFileAtomic(logPath(id), '', { mode: 0o600 });
        writeUnlocked(job);
      });

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
          if (event.type === 'progress') writeStructuredProgress(job, event);
        },
      }));
      const completion = operation
        .then(result => finish(job, result))
        .catch(error => failUnexpectedly(job, error))
        .finally(() => {
          clearInterval(cancelTimer);
          signal?.removeEventListener('abort', abortOperation);
          rmSync(cancelPath(id), { force: true });
          rmSync(progressPath(id), { force: true });
        });
      try {
        onOperation(completion);
      } catch {
        // Observers cannot change job execution or persistence.
      }
      return job;
    });
  };

  const startCvBuild = (roleNum, jobUrl, reportPath) => start({
    version: APPLICATION_API_VERSION,
    operation: 'cv.build',
    input: {
      roleNum,
      jobUrl,
      reportPath: reportPath ?? undefined,
    },
    idempotencyKey: Number.isSafeInteger(roleNum) ? `cv:${String(roleNum)}` : undefined,
  });

  const startCoverBuild = (roleNum, jobUrl, reportPath) => start({
    version: APPLICATION_API_VERSION,
    operation: 'cover.build',
    input: {
      roleNum,
      jobUrl,
      reportPath: reportPath ?? undefined,
    },
    idempotencyKey: Number.isSafeInteger(roleNum) ? `cover:${String(roleNum)}` : undefined,
  });

  return Object.freeze({
    readJob,
    listJobs,
    pruneJobs,
    pruneJobsSafely,
    runningJobFor,
    runningJobForDedupeKey,
    cancelJob,
    start,
    startCvBuild,
    startCoverBuild,
  });
}
