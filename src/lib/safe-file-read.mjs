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

function readFlags() {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' && process.platform !== 'win32'
    ? constants.O_NOFOLLOW
    : 0;
  return constants.O_RDONLY | noFollow;
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
    descriptor = openSync(file, readFlags());
    const stat = fstatSync(descriptor);
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
