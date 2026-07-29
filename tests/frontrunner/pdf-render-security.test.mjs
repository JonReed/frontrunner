import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { isAllowedPdfResourceUrl } from '../../src/cv/generate-pdf.mjs';

test('PDF renderer permits only local and embedded resources', () => {
  assert.equal(isAllowedPdfResourceUrl('file:///tmp/cv.html'), true);
  assert.equal(isAllowedPdfResourceUrl('data:image/png;base64,AA=='), true);
  for (const value of [
    'https://attacker.example/collect',
    'http://127.0.0.1:8080/private',
    'javascript:alert(1)',
    'blob:https://example.com/id',
    'not a url',
  ]) {
    assert.equal(isAllowedPdfResourceUrl(value), false, value);
  }
});

test('PDF renderer disables document JavaScript before loading HTML', () => {
  const source = readFileSync(join(ROOT, 'src', 'cv', 'generate-pdf.mjs'), 'utf8');
  assert.match(source, /newPage\(\{\s*javaScriptEnabled:\s*false\s*\}\)/);
  assert.match(source, /page\.route\(['"]\*\*\/\*['"]/);
});
