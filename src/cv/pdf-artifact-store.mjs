/**
 * Canonical crash-safe publisher for generated PDF artifacts.
 *
 * Chromium returns a complete in-memory buffer. Publishing that buffer through
 * a same-directory durable temporary file and atomic rename prevents a killed
 * renderer from truncating an existing CV or archived posting.
 */

import { replaceFileAtomic } from '../lib/locked-file.mjs';

export const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024;

export function validatePdfArtifact(pdfBuffer, options = {}) {
  if (!Buffer.isBuffer(pdfBuffer) && !(pdfBuffer instanceof Uint8Array)) {
    throw new TypeError('PDF artifact must be a binary buffer');
  }
  const bytes = Buffer.from(
    pdfBuffer.buffer,
    pdfBuffer.byteOffset,
    pdfBuffer.byteLength,
  );
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('PDF artifact maxBytes must be a positive integer');
  }
  if (bytes.length < 5 || bytes.length > maxBytes) {
    throw new RangeError(`PDF artifact size must be between 5 and ${maxBytes} bytes`);
  }
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new TypeError('PDF artifact does not have a valid PDF header');
  }
  return bytes;
}

export function publishPdfArtifact(outputPath, pdfBuffer, options = {}) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new TypeError('PDF artifact output path must be a non-empty string');
  }
  const bytes = validatePdfArtifact(pdfBuffer, options);
  replaceFileAtomic(outputPath, bytes, {
    mode: options.mode,
    ...options.writeOptions,
  });
  return { outputPath, size: bytes.length };
}
