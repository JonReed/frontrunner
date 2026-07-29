/**
 * Cross-process advisory lock for one local file.
 *
 * Atomic directory creation provides mutual exclusion. Owner PID/token
 * metadata, serialized stale recovery, directory-identity checks and
 * token-verified release prevent a crashed or delayed holder from deleting a
 * newer owner's lock.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRY_MS = 80;
const DEFAULT_TIMEOUT_MS = 8_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class FileLockTimeoutError extends Error {
  constructor(lockDir, timeoutMs) {
    super(`file lock timeout: ${lockDir} held > ${timeoutMs}ms`);
    this.name = 'FileLockTimeoutError';
    this.lockDir = lockDir;
  }
}

export function fileLockDirFor(filePath) {
  return `${filePath}.lock`;
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
  } catch {
    return null;
  }
}

function sameLockDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && (left.ino !== 0 || left.birthtimeMs === right.birthtimeMs);
}

function currentLockIdentity(lockDir) {
  try {
    return statSync(lockDir);
  } catch {
    return null;
  }
}

function removeUnchangedLock(lockDir, identity, ownerToken) {
  const current = currentLockIdentity(lockDir);
  if (!current || !sameLockDirectory(identity, current)) return false;
  const owner = readLockOwner(lockDir);
  if ((owner?.token ?? null) !== ownerToken) return false;
  const finalIdentity = currentLockIdentity(lockDir);
  if (!finalIdentity || !sameLockDirectory(identity, finalIdentity)) return false;
  rmSync(lockDir, { recursive: true, force: true });
  return true;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function lockCanRecover(lockDir, staleMs) {
  const owner = readLockOwner(lockDir);
  if (owner?.pid) return !processIsAlive(owner.pid);
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function lockTiming(value, fallback, name, { allowZero = true } = {}) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
  return resolved;
}

export async function acquireFileLock(filePath, options = {}) {
  const timeoutMs = lockTiming(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const retryMs = lockTiming(options.retryMs, DEFAULT_RETRY_MS, 'retryMs', { allowZero: false });
  const staleMs = lockTiming(options.staleMs, DEFAULT_STALE_MS, 'staleMs');
  const lockDir = options.lockDir ?? fileLockDirFor(filePath);
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(lockDir), { recursive: true });

  for (;;) {
    let createdIdentity;
    let createdDirectory = false;
    try {
      mkdirSync(lockDir);
      createdDirectory = true;
      createdIdentity = statSync(lockDir);
      if (typeof options.afterMkdir === 'function') {
        try {
          await options.afterMkdir(lockDir);
        } catch (hookError) {
          removeUnchangedLock(lockDir, createdIdentity, null);
          throw hookError;
        }
      }
    } catch (error) {
      if (createdDirectory && ['ENOENT', 'EINVAL'].includes(error?.code)) {
        if (Date.now() >= deadline) {
          const createTimeoutError = options.createTimeoutError
            ?? ((dir, timeout) => new FileLockTimeoutError(dir, timeout));
          throw createTimeoutError(lockDir, timeoutMs);
        }
        await sleep(retryMs);
        continue;
      }
      if (error?.code !== 'EEXIST') throw error;

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardError) {
        if (guardError?.code !== 'EEXIST') throw guardError;
        if (lockCanRecover(recoverGuardDir, staleMs)) {
          rmSync(recoverGuardDir, { recursive: true, force: true });
        }
      }

      if (hasRecoverGuard) {
        try {
          const staleIdentity = currentLockIdentity(lockDir);
          const staleOwner = readLockOwner(lockDir);
          if (
            staleIdentity
            && lockCanRecover(lockDir, staleMs)
            && removeUnchangedLock(lockDir, staleIdentity, staleOwner?.token ?? null)
          ) {
            continue;
          }
        } finally {
          rmSync(recoverGuardDir, { recursive: true, force: true });
        }
      }

      if (Date.now() >= deadline) {
        const createTimeoutError = options.createTimeoutError
          ?? ((dir, timeout) => new FileLockTimeoutError(dir, timeout));
        throw createTimeoutError(lockDir, timeoutMs);
      }
      await sleep(retryMs);
      continue;
    }

    try {
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
        ...(options.ownerFields ?? {}),
        pid: process.pid,
        token,
        started_at: new Date().toISOString(),
        file: filePath,
      }, null, 2), { flag: 'wx' });
    } catch (ownerError) {
      removeUnchangedLock(lockDir, createdIdentity, null);
      if (['EEXIST', 'ENOENT', 'EINVAL'].includes(ownerError?.code)) {
        if (Date.now() >= deadline) {
          const createTimeoutError = options.createTimeoutError
            ?? ((dir, timeout) => new FileLockTimeoutError(dir, timeout));
          throw createTimeoutError(lockDir, timeoutMs);
        }
        await sleep(retryMs);
        continue;
      }
      throw ownerError;
    }

    const acquiredIdentity = currentLockIdentity(lockDir);
    if (
      !acquiredIdentity
      || !sameLockDirectory(createdIdentity, acquiredIdentity)
      || readLockOwner(lockDir)?.token !== token
    ) {
      if (Date.now() >= deadline) {
        const createTimeoutError = options.createTimeoutError
          ?? ((dir, timeout) => new FileLockTimeoutError(dir, timeout));
        throw createTimeoutError(lockDir, timeoutMs);
      }
      await sleep(retryMs);
      continue;
    }

    let released = false;
    return {
      lockDir,
      release() {
        if (released) return;
        released = true;
        let before;
        try {
          before = statSync(lockDir);
        } catch {
          return;
        }
        const owner = readLockOwner(lockDir);
        if (owner?.token !== token) return;
        let after;
        try {
          after = statSync(lockDir);
        } catch {
          return;
        }
        if (!sameLockDirectory(before, after)) return;
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // A later stale-recovery pass can safely remove it.
        }
      },
    };
  }
}

export async function withFileLock(filePath, fn, options = {}) {
  const lock = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
