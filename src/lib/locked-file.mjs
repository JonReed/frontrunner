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
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { withFileLock } from './file-lock.mjs';
import { assertTestUserDataWriteAllowed } from './test-user-data-policy.mjs';

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
    writeFileSync(descriptor, String(content), 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    options.afterWrite?.(temporary);
    renameSync(temporary, filePath);
    // Persist the directory entry where the host filesystem supports it. A
    // rename is atomic for readers, while this best-effort fsync narrows the
    // power-loss window without turning an already-committed rename into a
    // reported failure on platforms that reject directory handles.
    let directoryDescriptor;
    try {
      directoryDescriptor = openSync(parent, 'r');
      fsyncSync(directoryDescriptor);
    } catch {
      // Windows and some network filesystems do not permit directory fsync.
    } finally {
      if (directoryDescriptor !== undefined) {
        try {
          closeSync(directoryDescriptor);
        } catch {
          // The replacement itself is already complete.
        }
      }
    }
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
