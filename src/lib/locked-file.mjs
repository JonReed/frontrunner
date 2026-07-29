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
    renameSync(temporary, filePath);
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
