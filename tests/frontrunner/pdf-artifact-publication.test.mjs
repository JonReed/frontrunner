import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  publishPdfArtifact,
  validatePdfArtifact,
} from '../../src/cv/pdf-artifact-store.mjs';

const pdf = marker => Buffer.from(`%PDF-1.7\n${marker}\n%%EOF\n`);

test('interrupted PDF publication preserves the previous binary and cleans debris', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-artifact-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cv.pdf');
  const original = pdf('original');
  publishPdfArtifact(file, original);

  assert.throws(
    () => publishPdfArtifact(file, pdf('replacement'), {
      writeOptions: {
        afterWrite() {
          throw new Error('injected PDF publication interruption');
        },
      },
    }),
    /injected PDF publication interruption/,
  );
  assert.deepEqual(readFileSync(file), original);
  assert.deepEqual(readdirSync(dir), ['cv.pdf']);
});

test('PDF artifact boundary rejects malformed and oversized output before publication', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-artifact-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bad.pdf');

  assert.throws(() => validatePdfArtifact('not binary'), /binary buffer/);
  assert.throws(() => publishPdfArtifact(file, Buffer.from('not a PDF')), /valid PDF header/);
  assert.throws(
    () => publishPdfArtifact(file, pdf('too large'), { maxBytes: 8 }),
    /size must be between/,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test('every Chromium PDF producer uses the canonical atomic publisher', () => {
  for (const relative of [
    'src/cv/generate-pdf.mjs',
    'src/cv/img-to-pdf.mjs',
    'src/scan/archive-posting.mjs',
  ]) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    assert.match(source, /publishPdfArtifact\s*\(/u, relative);
    assert.doesNotMatch(source, /writeFile\s*\(\s*outputPath\s*,\s*pdfBuffer/u, relative);
  }
});
