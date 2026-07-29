/**
 * Compatibility boundary for the historical pipeline lock API.
 *
 * The implementation is now the generic file lock used by scanner audit files,
 * the agent inbox and application job claims. Existing callers and error
 * identity remain stable.
 */

import {
  FileLockTimeoutError,
  acquireFileLock,
  fileLockDirFor,
} from '../lib/file-lock.mjs';

export class LockTimeoutError extends FileLockTimeoutError {
  constructor(lockDir, timeoutMs) {
    super(lockDir, timeoutMs);
    this.name = 'LockTimeoutError';
    this.message = `pipeline lock timeout: ${lockDir} held > ${timeoutMs}ms`;
  }
}

export function lockDirFor(pipelinePath) {
  return fileLockDirFor(pipelinePath);
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function acquirePipelineLock(pipelinePath, options = {}) {
  return acquireFileLock(pipelinePath, {
    timeoutMs: options.timeoutMs
      ?? positiveIntegerEnv('FRONTRUNNER_PIPELINE_LOCK_TIMEOUT_MS', 8_000),
    retryMs: options.retryMs
      ?? positiveIntegerEnv('FRONTRUNNER_PIPELINE_LOCK_RETRY_MS', 80),
    staleMs: options.staleMs
      ?? positiveIntegerEnv('FRONTRUNNER_PIPELINE_LOCK_STALE_MS', 30_000),
    ownerFields: { pipeline: pipelinePath },
    createTimeoutError: (lockDir, timeoutMs) => new LockTimeoutError(lockDir, timeoutMs),
  });
}

export async function withPipelineLock(pipelinePath, fn, options = {}) {
  const lock = await acquirePipelineLock(pipelinePath, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
