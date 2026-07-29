import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cacheProviderDescriptions } from '../../src/scan/jd-cache.mjs';
import { runFetchJds } from '../../src/scan/fetch-jds.mjs';

test('provider descriptions flow from scan cache to ingestion without another HTTP request', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'frontrunner-scan-jd-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = join(root, 'jds');
  const input = join(root, 'pipeline.md');
  const url = 'https://jobs.lever.co/acme/role-123';

  const cache = await cacheProviderDescriptions(
    [{
      url,
      company: 'Acme',
      title: 'Director of Engineering',
      location: 'Remote',
      description: '<p>Own the engineering organisation.</p><ul><li>Lead delivery</li></ul>',
    }],
    { outDir },
  );
  assert.deepEqual(cache, { cached: 1, manifestSize: 1 });

  const index = readFileSync(join(outDir, 'index.tsv'), 'utf8');
  const jdPath = index.split('\n').find((line) => line.startsWith(`${url}\t`)).split('\t')[1];
  assert.match(readFileSync(jdPath, 'utf8'), /Own the engineering organisation\.[\s\S]*Lead delivery/);

  writeFileSync(input, `- [ ] ${url} | Acme | Director of Engineering |\n`);
  let requests = 0;
  const ingest = await runFetchJds({
    input,
    outDir,
    fetchJson: async () => {
      requests += 1;
      throw new Error('the scan cache should make this unnecessary');
    },
  });

  assert.equal(ingest.cached, 1);
  assert.equal(ingest.requests, 0);
  assert.equal(requests, 0);
});
