/**
 * Descriptor-based bounded reads for local files.
 *
 * Opening first and validating the opened descriptor removes the usual
 * exists/lstat/read time-of-check-to-time-of-use window. On platforms that
 * support O_NOFOLLOW, the final path component must not be a symbolic link.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';

function fail(label, message, code = 'UNSAFE_FILE_READ') {
  const error = new Error(`${label} ${message}`);
  error.code = code;
  return error;
}

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer');
  }
}

function supportsNoFollow() {
  return typeof constants.O_NOFOLLOW === 'number' && process.platform !== 'win32';
}

function readFlags() {
  return constants.O_RDONLY | (supportsNoFollow() ? constants.O_NOFOLLOW : 0);
}

function validatePathIdentity(file, descriptorStat, beforeStat, label) {
  if (!beforeStat) return;
  const afterStat = lstatSync(file);
  const unsafeType = !beforeStat.isFile() || !afterStat.isFile()
    || beforeStat.isSymbolicLink() || afterStat.isSymbolicLink();
  const changed = (
    beforeStat.dev !== descriptorStat.dev
    || beforeStat.ino !== descriptorStat.ino
    || afterStat.dev !== descriptorStat.dev
    || afterStat.ino !== descriptorStat.ino
  );
  if (unsafeType || changed) {
    throw fail(label, 'must be a stable regular file, not a symbolic link');
  }
}

export function readBoundedRegularFileWithStatSync(
  file,
  {
    maxBytes,
    encoding = 'utf8',
    allowMissing = false,
    label = 'file',
  } = {},
) {
  validateMaxBytes(maxBytes);
  let descriptor;
  try {
    // Windows does not expose O_NOFOLLOW. Check the reparse-point type before
    // opening, then compare it with both the descriptor and the path after the
    // open. Reading remains descriptor-based, so later path replacement cannot
    // redirect the bytes being consumed.
    const beforeStat = supportsNoFollow() ? null : lstatSync(file);
    if (beforeStat?.isSymbolicLink() || (beforeStat && !beforeStat.isFile())) {
      throw fail(label, 'must not be a symbolic link');
    }
    descriptor = openSync(file, readFlags());
    const stat = fstatSync(descriptor);
    validatePathIdentity(file, stat, beforeStat, label);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw fail(label, `must be a regular file no larger than ${String(maxBytes)} bytes`);
    }
    const content = readFileSync(descriptor, encoding === null ? undefined : { encoding });
    const bytes = typeof content === 'string'
      ? Buffer.byteLength(content, encoding)
      : content.byteLength;
    if (bytes > maxBytes) {
      throw fail(label, `exceeds ${String(maxBytes)} bytes`);
    }
    return { content, stat };
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') {
      throw fail(label, 'must not be a symbolic link');
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readBoundedRegularFileSync(file, options = {}) {
  const result = readBoundedRegularFileWithStatSync(file, options);
  return result === null ? null : result.content;
}
