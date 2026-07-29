import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  publishEvaluationArtifacts,
  recoverEvaluationPublications,
} from '../../src/evaluate/evaluation-publication.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, '..', 'fixtures', 'evaluation-publication-worker.mjs');

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'frontrunner-publication-'));
  mkdirSync(join(root, 'reports'), { recursive: true });
  mkdirSync(join(root, 'batch', 'tracker-additions'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'),
    '# Applications Tracker\n\n'
    + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
    + '|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  return root;
}

function publication(number = 12) {
  const num = String(number).padStart(3, '0');
  return {
    number,
    slug: 'acme',
    date: '2026-07-29',
    report: '# Evaluation: Acme — Engineer\n',
    tracker: `${number}\t2026-07-29\tAcme\tEngineer\tEvaluated\t4.2/5\t❌\t[${num}](reports/${num}-acme-2026-07-29.md)\tfixture\n`,
    mergeTracker: true,
  };
}

function mergeIntoFixture(rootDir, item) {
  const trackerPath = join(rootDir, 'data', 'applications.md');
  const current = readFileSync(trackerPath, 'utf8');
  writeFileSync(trackerPath,
    `${current}| ${item.number} | ${item.date} | Acme | Engineer | 4.2/5 | Evaluated | ❌ | [${item.num}](../reports/${item.filename}) | fixture |\n`);
}

test('failed tracker merge leaves an idempotent journal that recovery completes', async () => {
  const rootDir = makeRoot();
  let mergeAttempts = 0;
  await assert.rejects(
    publishEvaluationArtifacts({ ...publication(), rootDir }, {
      mergeTrackerFn() {
        mergeAttempts += 1;
        throw new Error('injected merge failure');
      },
    }),
    /injected merge failure/,
  );

  const journal = join(rootDir, 'reports', '012-PUBLISHING.json');
  const report = join(rootDir, 'reports', '012-acme-2026-07-29.md');
  const addition = join(rootDir, 'batch', 'tracker-additions', '012-acme.tsv');
  assert.equal(existsSync(journal), true);
  assert.equal(existsSync(report), true);
  assert.equal(existsSync(addition), true);

  const recovered = await recoverEvaluationPublications({
    rootDir,
    mergeTrackerFn: mergeIntoFixture,
  });
  assert.equal(recovered.length, 1);
  assert.equal(existsSync(journal), false);
  assert.match(readFileSync(join(rootDir, 'data', 'applications.md'), 'utf8'),
    /\[012\].*012-acme-2026-07-29\.md/);
  assert.equal(mergeAttempts, 1);
});

test('abrupt process exit after report write is recovered without partial loss', () => {
  const rootDir = makeRoot();
  const crashed = spawnSync(process.execPath, [worker, 'publish-crash', rootDir], {
    encoding: 'utf8',
  });
  assert.equal(crashed.status, 86);
  assert.equal(existsSync(join(rootDir, 'reports', '007-PUBLISHING.json')), true);
  assert.equal(existsSync(join(rootDir, 'reports', '007-crash-co-2026-07-29.md')), true);
  assert.equal(existsSync(join(rootDir, 'batch', 'tracker-additions', '007-crash-co.tsv')), false);

  const recovered = spawnSync(process.execPath, [worker, 'recover', rootDir], {
    encoding: 'utf8',
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(join(rootDir, 'reports', '007-PUBLISHING.json')), false);
  assert.equal(
    readFileSync(join(rootDir, 'batch', 'tracker-additions', '007-crash-co.tsv'), 'utf8'),
    '7\t2026-07-29\tCrash Co\tEngineer\tEvaluated\t4.5/5\t❌\t[007](reports/007-crash-co-2026-07-29.md)\tfixture\n',
  );
});

test('concurrent recovery processes publish a pending evaluation exactly once', async () => {
  const rootDir = makeRoot();
  const crashed = spawnSync(process.execPath, [worker, 'publish-crash', rootDir]);
  assert.equal(crashed.status, 86);

  const exits = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, 'recover', rootDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stderr }));
  })));
  assert.deepEqual(exits.map(item => item.code), Array(8).fill(0), exits.map(item => item.stderr).join('\n'));
  assert.equal(existsSync(join(rootDir, 'reports', '007-PUBLISHING.json')), false);
  const addition = readFileSync(join(rootDir, 'batch', 'tracker-additions', '007-crash-co.tsv'), 'utf8');
  assert.equal(addition.split('\n').filter(Boolean).length, 1);
});

test('malformed journal cannot redirect recovery outside fixed publication paths', async () => {
  const rootDir = makeRoot();
  const outside = join(dirname(rootDir), 'escaped-evaluation.md');
  writeFileSync(join(rootDir, 'reports', '009-PUBLISHING.json'), JSON.stringify({
    version: 1,
    number: 9,
    slug: '../../escaped-evaluation',
    date: '2026-07-29',
    report: 'malicious',
    tracker: 'malicious',
    mergeTracker: false,
  }));

  await assert.rejects(recoverEvaluationPublications({ rootDir }), /slug is invalid/);
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(rootDir, 'reports', '009-PUBLISHING.json')), true);
});

test('tracker recovery requires report number and filename on the same row', async () => {
  const rootDir = makeRoot();
  let mergeAttempts = 0;
  const trackerPath = join(rootDir, 'data', 'applications.md');
  const current = readFileSync(trackerPath, 'utf8');
  writeFileSync(
    trackerPath,
    `${current}`
      + '| 12 | 2026-07-29 | Other | Role | 4.0/5 | Evaluated | ❌ | [012](../reports/012-other-2026-07-29.md) | — |\n'
      + '| 13 | 2026-07-29 | Notes | Role | 4.0/5 | Evaluated | ❌ | [013](../reports/013-notes-2026-07-29.md) | mentions 012-acme-2026-07-29.md |\n',
  );

  await publishEvaluationArtifacts({ ...publication(), rootDir }, {
    mergeTrackerFn(root, item) {
      mergeAttempts += 1;
      mergeIntoFixture(root, item);
    },
  });

  assert.equal(mergeAttempts, 1);
  assert.equal(existsSync(join(rootDir, 'reports', '012-PUBLISHING.json')), false);
  assert.match(readFileSync(trackerPath, 'utf8'),
    /\[012\]\(\.\.\/reports\/012-acme-2026-07-29\.md\)/u);
});
