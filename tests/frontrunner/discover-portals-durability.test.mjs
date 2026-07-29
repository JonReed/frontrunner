import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';

import { ROOT } from '#paths';
import { appendDiscoveredPortals } from '../../src/scan/discover-ats.mjs';

const WORKER = join(ROOT, 'tests', 'fixtures', 'discover-portals-worker.mjs');
const START = [
  '# Keep this comment and formatting.',
  'title_filter:',
  '  positive: [engineer]',
  '',
  'tracked_companies:',
  '  - name: Existing',
  '    careers_url: https://jobs.lever.co/existing',
  '    enabled: true',
  '',
  'job_boards:',
  '  - name: Example board',
  '',
].join('\n');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-portals-state-'));
  const portalsPath = join(dir, 'portals.yml');
  writeFileSync(portalsPath, START);
  return { dir, portalsPath };
}

function runWorker(portalsPath, match) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      WORKER,
      portalsPath,
      JSON.stringify(match),
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function match(index) {
  return {
    name: `Company ${index}`,
    careers_url: `https://jobs.lever.co/company-${index}`,
    provider: 'lever',
  };
}

function assertNoDebris(dir) {
  const files = readdirSync(dir, { recursive: true }).map(String);
  assert.equal(
    files.some(file => file.endsWith('.tmp') || file.includes('.lock')),
    false,
    files.join(', '),
  );
}

test('destructive cross-process discovery retains every unique board once', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const unique = 10;
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, index) => runWorker(
      fx.portalsPath,
      match(index % unique),
    )),
  );
  assert.equal(results.every(result => result.code === 0), true);

  const content = readFileSync(fx.portalsPath, 'utf8');
  const parsed = yaml.load(content);
  assert.equal(parsed.tracked_companies.length, unique + 1);
  for (let index = 0; index < unique; index += 1) {
    assert.equal(
      parsed.tracked_companies.filter(entry => entry.name === `Company ${index}`).length,
      1,
    );
  }
  assert.match(content, /# Keep this comment and formatting\./u);
  assert.match(content, /job_boards:\n  - name: Example board/u);
  assertNoDebris(fx.dir);
});

test('interrupted portals replacement preserves the original and cleans debris', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  await assert.rejects(
    appendDiscoveredPortals([match(1)], fx.portalsPath, {
      afterWrite() {
        throw new Error('injected portals interruption');
      },
    }),
    /injected portals interruption/u,
  );
  assert.equal(readFileSync(fx.portalsPath, 'utf8'), START);
  assertNoDebris(fx.dir);
});

test('malformed portals config fails closed without replacement', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));
  const malformed = 'tracked_companies:\n  - name: [broken\n';
  writeFileSync(fx.portalsPath, malformed);

  await assert.rejects(
    appendDiscoveredPortals([match(1)], fx.portalsPath),
    /could not be parsed/u,
  );
  assert.equal(readFileSync(fx.portalsPath, 'utf8'), malformed);
  assertNoDebris(fx.dir);
});

test('unsafe discovered URLs fail before touching portals config', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  await assert.rejects(
    appendDiscoveredPortals([{
      name: 'Injected',
      careers_url: 'https://jobs.lever.co/safe\njob_boards: []',
    }], fx.portalsPath),
    /careers_url is invalid/u,
  );
  await assert.rejects(
    appendDiscoveredPortals([{
      name: 'Metadata',
      careers_url: 'https://169.254.169.254/latest/meta-data',
    }], fx.portalsPath),
    /not a supported ATS URL/u,
  );
  assert.equal(readFileSync(fx.portalsPath, 'utf8'), START);
  assertNoDebris(fx.dir);
});

test('a duplicate-only transaction is byte-identical', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.dir, { recursive: true, force: true }));

  const outcome = await appendDiscoveredPortals([{
    name: 'Existing',
    careers_url: 'https://jobs.lever.co/existing/',
    provider: 'lever',
  }], fx.portalsPath);
  assert.equal(outcome.written, false);
  assert.equal(outcome.duplicates.length, 1);
  assert.equal(readFileSync(fx.portalsPath, 'utf8'), START);
  assertNoDebris(fx.dir);
});
