import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { cachedJdForUrl } from '../../src/evaluate/openrouter-runner.mjs';

test('OpenRouter evaluation reads a cached JD instead of requiring another page fetch', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'frontrunner-openrouter-cache-'));
  const url = 'https://jobs.example.test/role/123';
  const jdFile = join(outDir, 'cached.md');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(jdFile, '# Backend Engineer\n\nBuild deterministic systems.\n');
  writeFileSync(join(outDir, 'index.tsv'), `url\tfile\n${url}\t${jdFile}\n`);

  assert.equal(
    cachedJdForUrl(url, { outDir }),
    '# Backend Engineer\n\nBuild deterministic systems.',
  );
  assert.equal(cachedJdForUrl(`${url}-missing`, { outDir }), null);
});
