import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

test('My details exposes canonical and additional CVs as separate workflows', () => {
  const page = read('ui/src/app/profile/page.tsx');
  const component = read('ui/src/components/additional-cvs.tsx');
  const backend = read('src/application/profile-control.mjs');

  assert.match(page, /<ReplaceCv\b/u);
  assert.match(page, /<AdditionalCvs\b/u);
  assert.match(component, /addCvVersion\(/u);
  assert.match(component, /not scored directly/u);
  assert.match(backend, /add-version/u);
  assert.match(backend, /listCvVersions/u);
});
