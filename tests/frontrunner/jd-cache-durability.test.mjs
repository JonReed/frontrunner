import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  cacheProviderDescriptions,
  readJdManifest,
} from '../../src/scan/jd-cache.mjs';
import { publishJdCacheEntries } from '../../src/scan/jd-cache-store.mjs';

const worker = new URL('../fixtures/jd-cache-worker.mjs', import.meta.url);

function runWorker(outDir, index) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [worker.pathname, outDir, String(index)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
}

function fixture(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'jds');
}

function assertNoDebris(outDir) {
  assert.equal(
    readdirSync(outDir).some(name => name.endsWith('.tmp') || name.endsWith('.lock')),
    false,
  );
}

test('destructive concurrent JD publishers retain every manifest entry', async t => {
  const outDir = fixture(t, 'frontrunner-jd-cache-race-');
  const count = 20;
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) => runWorker(outDir, index)),
  );
  assert.deepEqual(
    results.map(result => result.code),
    Array(count).fill(0),
    results.map(result => result.stderr).join('\n'),
  );

  const manifest = readJdManifest(outDir);
  assert.equal(manifest.size, count);
  for (let index = 0; index < count; index++) {
    const url = `https://jobs.example/roles/${index}`;
    assert.ok(manifest.has(url), url);
    assert.match(readFileSync(manifest.get(url), 'utf8'), new RegExp(`description ${index}`));
  }
  assertNoDebris(outDir);
});

test('interrupted manifest replacement preserves the prior index and retry repairs it', async t => {
  const outDir = fixture(t, 'frontrunner-jd-cache-failure-');
  const first = {
    url: 'https://jobs.example/roles/first',
    title: 'First role',
    description: 'First durable description.',
  };
  const second = {
    url: 'https://jobs.example/roles/second',
    title: 'Second role',
    description: 'Second durable description.',
  };
  await cacheProviderDescriptions([first], { outDir });
  const indexPath = join(outDir, 'index.tsv');
  const original = readFileSync(indexPath, 'utf8');

  await assert.rejects(
    cacheProviderDescriptions([second], {
      outDir,
      publishOptions: {
        afterIndexWrite: () => { throw new Error('injected index interruption'); },
      },
    }),
    /injected index interruption/,
  );
  assert.equal(readFileSync(indexPath, 'utf8'), original);
  assert.equal(readJdManifest(outDir).has(second.url), false);
  assertNoDebris(outDir);

  await cacheProviderDescriptions([second], { outDir });
  const recovered = readJdManifest(outDir);
  assert.equal(recovered.has(first.url), true);
  assert.equal(recovered.has(second.url), true);
  assertNoDebris(outDir);
});

test('interrupted JD replacement preserves the prior file and manifest', async t => {
  const outDir = fixture(t, 'frontrunner-jd-cache-entry-failure-');
  const role = {
    url: 'https://jobs.example/roles/stable',
    title: 'Stable role',
    description: 'Original description.',
  };
  await cacheProviderDescriptions([role], { outDir });
  const manifestBefore = readFileSync(join(outDir, 'index.tsv'), 'utf8');
  const file = readJdManifest(outDir).get(role.url);
  const fileBefore = readFileSync(file, 'utf8');

  await assert.rejects(
    cacheProviderDescriptions([{
      ...role,
      description: 'Replacement that must not become visible.',
    }], {
      outDir,
      publishOptions: {
        afterEntryWrite: () => { throw new Error('injected JD interruption'); },
      },
    }),
    /injected JD interruption/,
  );
  assert.equal(readFileSync(file, 'utf8'), fileBefore);
  assert.equal(readFileSync(join(outDir, 'index.tsv'), 'utf8'), manifestBefore);
  assertNoDebris(outDir);
});

test('hostile cache metadata is bounded and cannot escape the JD directory', async t => {
  const outDir = fixture(t, 'frontrunner-jd-cache-hostile-');
  const outside = join(outDir, '..', 'outside.md');
  await cacheProviderDescriptions([{
    url: 'https://jobs.example/roles/hostile',
    title: 'Hostile\nInjected heading',
    company: 'Bad\tCompany',
    description: 'x'.repeat(100_000),
  }], { outDir });

  const manifest = readJdManifest(outDir);
  const file = manifest.get('https://jobs.example/roles/hostile');
  assert.ok(file);
  assert.equal(existsSync(outside), false);
  const content = readFileSync(file, 'utf8');
  assert.ok(content.length <= 24_001);
  assert.equal(content.split('\n')[0], '# Hostile Injected heading');
});

test('symlinked cache targets and manifests fail closed', async t => {
  const outDir = fixture(t, 'frontrunner-jd-cache-symlink-');
  const outside = join(outDir, '..', 'outside.md');
  const target = join(outDir, 'poisoned.md');
  const index = join(outDir, 'index.tsv');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outside, 'outside sentinel\n');
  symlinkSync(outside, target);

  await assert.rejects(
    publishJdCacheEntries(outDir, [{
      url: 'https://jobs.example/roles/poisoned',
      name: 'poisoned.md',
      content: 'untrusted replacement',
    }]),
    /target must be a regular file/,
  );
  assert.equal(readFileSync(outside, 'utf8'), 'outside sentinel\n');
  assert.equal(existsSync(index), false);

  rmSync(target);
  symlinkSync(outside, index);
  assert.equal(readJdManifest(outDir).size, 0);
  await publishJdCacheEntries(outDir, [{
    url: 'https://jobs.example/roles/safe',
    name: 'safe.md',
    content: 'safe description',
  }]);
  assert.equal(readFileSync(outside, 'utf8'), 'outside sentinel\n');
  assert.equal(readJdManifest(outDir).has('https://jobs.example/roles/safe'), true);
  assertNoDebris(outDir);
});
