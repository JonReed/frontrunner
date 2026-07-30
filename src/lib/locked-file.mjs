/**
 * Locked, atomic mutation for durable local user-state files.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { withFileLock } from './file-lock.mjs';
import { assertTestUserDataWriteAllowed } from './test-user-data-policy.mjs';

const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 500];
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function renameReplacingFile(source, destination, options) {
  const renameFile = options.renameFile ?? renameSync;
  const platform = options.platform ?? process.platform;
  const retryDelays = options.renameRetryDelaysMs ?? WINDOWS_RENAME_RETRY_DELAYS_MS;
  let attempt = 0;

  for (;;) {
    try {
      renameFile(source, destination);
      return;
    } catch (error) {
      if (
        platform !== 'win32'
        || !WINDOWS_RENAME_RETRY_CODES.has(error?.code)
        || attempt >= retryDelays.length
      ) {
        throw error;
      }
      const delay = retryDelays[attempt++];
      if (!Number.isSafeInteger(delay) || delay < 0) {
        throw new TypeError('rename retry delays must be non-negative integers');
      }
      // Antivirus/indexing handles can briefly prevent an otherwise valid
      // replace on Windows. Keep the retry bounded and inside the caller's
      // file lock; readers continue to see the prior complete file.
      if (delay > 0) Atomics.wait(SLEEP_CELL, 0, 0, delay);
    }
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } catch {
    // Windows and some network filesystems do not permit directory fsync.
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The caller's filesystem mutation is already complete.
      }
    }
  }
}

export function replaceFileAtomic(filePath, content, options = {}) {
  assertTestUserDataWriteAllowed(filePath);
  const parent = dirname(filePath);
  const temporary = join(
    parent,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  mkdirSync(parent, { recursive: true });
  const mode = options.mode
    ?? (existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o600);
  let descriptor;

  try {
    descriptor = openSync(temporary, 'wx', mode);
    const payload = typeof content === 'string' || ArrayBuffer.isView(content)
      ? content
      : String(content);
    writeFileSync(descriptor, payload, typeof payload === 'string' ? 'utf8' : undefined);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    options.afterWrite?.(temporary);
    renameReplacingFile(temporary, filePath, options);
    // Persist the directory entry where the host filesystem supports it. A
    // rename is atomic for readers, while this best-effort fsync narrows the
    // power-loss window without turning an already-committed rename into a
    // reported failure on platforms that reject directory handles.
    fsyncDirectory(parent);
    options.afterRename?.(filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Create a file only when it does not already exist. Unlike a bare `wx`
 * write, this applies the test/user-data barrier and persists the directory
 * entry before reporting success.
 */
export function createFileExclusive(filePath, content, options = {}) {
  assertTestUserDataWriteAllowed(filePath);
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(filePath, 'wx', options.mode ?? 0o600);
    created = true;
    const payload = typeof content === 'string' || ArrayBuffer.isView(content)
      ? content
      : String(content);
    writeFileSync(descriptor, payload, typeof payload === 'string' ? 'utf8' : undefined);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original creation failure.
      }
    }
    if (created) rmSync(filePath, { force: true });
    throw error;
  }
}

/** Publish a byte-for-byte copy without exposing a partial destination. */
export function copyFileAtomic(sourcePath, destinationPath, options = {}) {
  assertTestUserDataWriteAllowed(destinationPath);
  const mode = options.mode
    ?? (existsSync(destinationPath)
      ? statSync(destinationPath).mode & 0o777
      : statSync(sourcePath).mode & 0o777);
  replaceFileAtomic(destinationPath, readFileSync(sourcePath), {
    ...options,
    mode,
  });
}

/**
 * Atomically move a file on the same filesystem, protecting both the removed
 * source and the replaced destination from stale test processes.
 */
export function moveFileAtomic(sourcePath, destinationPath, options = {}) {
  assertTestUserDataWriteAllowed(sourcePath);
  assertTestUserDataWriteAllowed(destinationPath);
  if (options.overwrite === false && existsSync(destinationPath)) {
    const error = new Error(`destination already exists: ${destinationPath}`);
    error.code = 'EEXIST';
    throw error;
  }
  const sourceParent = dirname(sourcePath);
  const destinationParent = dirname(destinationPath);
  mkdirSync(destinationParent, { recursive: true });
  renameSync(sourcePath, destinationPath);
  fsyncDirectory(destinationParent);
  if (sourceParent !== destinationParent) fsyncDirectory(sourceParent);
}

/** Remove a file through the same fail-closed user-data boundary. */
export function removeFileProtected(filePath, options = {}) {
  assertTestUserDataWriteAllowed(filePath);
  try {
    unlinkSync(filePath);
    fsyncDirectory(dirname(filePath));
    return true;
  } catch (error) {
    if (options.force === true && error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function mutateFileLocked(filePath, mutate, options = {}) {
  return withFileLock(filePath, async () => {
    const current = existsSync(filePath)
      ? readFileSync(filePath, options.encoding ?? 'utf8')
      : (options.initial ?? '');
    const next = await mutate(current);
    if (typeof next !== 'string') {
      throw new TypeError('Locked file mutation must return complete string content');
    }
    if (next !== current || !existsSync(filePath)) {
      replaceFileAtomic(filePath, next, options.writeOptions);
    }
    return next;
  }, options.lockOptions);
}

export async function appendFileLocked(filePath, addition, options = {}) {
  if (!addition) return;
  return mutateFileLocked(
    filePath,
    current => `${current || options.header || ''}${addition}`,
    options,
  );
}
