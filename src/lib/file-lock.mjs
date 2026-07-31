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
export const OWNERLESS_GRACE_MS = 1_000;
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
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    // Windows can transiently retain a handle to a directory that another
    // process has just inspected. The lock is still present, so callers can
    // safely treat this as contention and retry.
    if (error?.code === 'EPERM' || error?.code === 'EBUSY') return false;
    throw error;
  }
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

/**
 * Whether a lock may be taken from its current holder.
 *
 * `ageClock` exists so the ownerless grace floor can be tested for what it is
 * — a rule about lock age — rather than by racing it. A test that creates a
 * fresh lock and asserts it cannot be reclaimed is only correct while less
 * than OWNERLESS_GRACE_MS of real time has passed since the directory was
 * made, so a GC pause or a loaded CI runner turns a correct implementation
 * into a red build. Injecting the clock makes the decision deterministic
 * without weakening it: production passes nothing and gets Date.now.
 *
 * Deliberately separate from the acquisition deadline, which must keep using
 * real time — a pinned clock there would mean a contended lock never timed
 * out at all.
 */
function lockCanRecover(lockDir, staleMs, ageClock = Date.now) {
  const owner = readLockOwner(lockDir);
  if (owner?.pid) return !processIsAlive(owner.pid);
  try {
    return ageClock() - statSync(lockDir).mtimeMs > Math.max(staleMs, OWNERLESS_GRACE_MS);
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
  // Judges lock AGE only; the deadline below stays on real time.
  const ageClock = options.ageClock ?? Date.now;
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(lockDir), { recursive: true });

  for (;;) {
    let createdIdentity;
    let createdDirectory = false;
    try {
      if (typeof options.beforeMkdir === 'function') {
        await options.beforeMkdir(lockDir);
      }
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
      // Windows may briefly report EPERM/EBUSY when another process has just
      // removed this directory but the OS still retains a handle to it. This
      // is bounded contention, not a permanent acquisition failure.
      if (['EPERM', 'EBUSY'].includes(error?.code)) {
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
        if (!['EEXIST', 'EPERM', 'EBUSY'].includes(guardError?.code)) throw guardError;
        if (guardError?.code === 'EEXIST' && lockCanRecover(recoverGuardDir, staleMs, ageClock)) {
          try {
            rmSync(recoverGuardDir, { recursive: true, force: true });
          } catch (recoverError) {
            if (!['EPERM', 'EBUSY'].includes(recoverError?.code)) throw recoverError;
          }
        }
      }

      if (hasRecoverGuard) {
        try {
          const staleIdentity = currentLockIdentity(lockDir);
          const staleOwner = readLockOwner(lockDir);
          if (
            staleIdentity
            && lockCanRecover(lockDir, staleMs, ageClock)
            && removeUnchangedLock(lockDir, staleIdentity, staleOwner?.token ?? null)
          ) {
            continue;
          }
        } finally {
          try {
            rmSync(recoverGuardDir, { recursive: true, force: true });
          } catch (cleanupError) {
            if (!['EPERM', 'EBUSY'].includes(cleanupError?.code)) throw cleanupError;
          }
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
      }, null, 2), { flag: 'wx', mode: 0o600 });
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
