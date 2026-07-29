import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { ROOT } from '#paths';
import { applyAdd } from '../../src/tracker/add-entry.mjs';
import {
  mutateAddEntrySources,
  recoverAddEntryPublication,
} from '../../src/tracker/add-entry-publication.mjs';

const CRASH_WORKER = join(ROOT, 'tests', 'fixtures', 'add-entry-crash-worker.mjs');
const CLI = join(ROOT, 'src', 'tracker', 'add-entry.mjs');
const CV_START = '# Candidate\n\n## Projects\n';
const PAYLOAD = Object.freeze({
  cv: {
    section: 'Projects',
    dedupKey: 'Crash Safe Project',
    entry: '- **Crash Safe Project** — published transactionally.',
  },
  articleDigest: {
    dedupKey: 'Crash Safe Project',
    entry: '## Crash Safe Project — Evidence\n\nA grounded proof point.',
  },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-add-publication-'));
  const paths = {
    dir,
    cvPath: join(dir, 'cv.md'),
    articlePath: join(dir, 'article-digest.md'),
    journalPath: join(dir, 'data', '.add-entry-PUBLISHING.json'),
    payloadPath: join(dir, 'payload.json'),
  };
  writeFileSync(paths.cvPath, CV_START);
  writeFileSync(paths.payloadPath, JSON.stringify(PAYLOAD));
  return paths;
}

function runCli(paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, paths.payloadPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAREER_OPS_CV: paths.cvPath,
        CAREER_OPS_ARTICLE_DIGEST: paths.articlePath,
        CAREER_OPS_ADD_ENTRY_JOURNAL: paths.journalPath,
      },
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

function assertNoTransactionDebris(paths) {
  const files = readdirSync(paths.dir, { recursive: true }).map(String);
  assert.equal(files.some(file => (
    file.endsWith('.lock')
    || file.includes('.lock/')
    || file.endsWith('.tmp')
    || file.endsWith('-PUBLISHING.json')
  )), false, `unexpected transaction debris: ${files.join(', ')}`);
}

test('recovers an actual process exit between canonical source writes', async t => {
  const paths = fixture();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));

  const crashed = spawnSync(process.execPath, [
    CRASH_WORKER,
    paths.cvPath,
    paths.articlePath,
    paths.journalPath,
    paths.payloadPath,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(crashed.status, 73);
  assert.match(readFileSync(paths.cvPath, 'utf8'), /Crash Safe Project/u);
  assert.equal(existsSync(paths.articlePath), false);
  assert.equal(existsSync(paths.journalPath), true);

  const resumed = await runCli(paths);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).cv.status, 'duplicate');
  assert.equal(JSON.parse(resumed.stdout).articleDigest.status, 'duplicate');
  assert.match(readFileSync(paths.articlePath, 'utf8'), /A grounded proof point/u);
  assert.equal(existsSync(paths.journalPath), false);
  assertNoTransactionDebris(paths);
});

test('refuses recovery over a source edited after the journal was persisted', async t => {
  const paths = fixture();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));

  await assert.rejects(
    mutateAddEntrySources({
      ...paths,
      compute: current => applyAdd(PAYLOAD, current),
    }, {
      afterStage(stage) {
        if (stage === 'journal') throw new Error('injected interruption');
      },
    }),
    /injected interruption/u,
  );
  writeFileSync(paths.articlePath, 'Human proof-point edit made during recovery window.\n');

  await assert.rejects(
    recoverAddEntryPublication(paths),
    /source changed after publication was journaled/u,
  );
  assert.equal(readFileSync(paths.cvPath, 'utf8'), CV_START);
  assert.match(readFileSync(paths.articlePath, 'utf8'), /Human proof-point edit/u);
  assert.equal(existsSync(paths.journalPath), true);
});

test('serializes concurrent CLI additions into one idempotent publication', async t => {
  const paths = fixture();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));

  const results = await Promise.all([runCli(paths), runCli(paths), runCli(paths)]);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0]);
  const parsed = results.map(result => JSON.parse(result.stdout));
  assert.equal(parsed.filter(result => result.cv.status === 'added').length, 1);
  assert.equal(parsed.filter(result => result.cv.status === 'duplicate').length, 2);
  assert.equal(
    readFileSync(paths.cvPath, 'utf8').match(/Crash Safe Project/gu)?.length,
    1,
  );
  assert.equal(
    readFileSync(paths.articlePath, 'utf8').match(/## Crash Safe Project/gu)?.length,
    1,
  );
  assertNoTransactionDebris(paths);
});

test('an idempotent duplicate creates no journal or replacement files', async t => {
  const paths = fixture();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));

  const first = await runCli(paths);
  const beforeCv = readFileSync(paths.cvPath, 'utf8');
  const beforeArticle = readFileSync(paths.articlePath, 'utf8');
  const second = await runCli(paths);

  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(JSON.parse(second.stdout).cv.status, 'duplicate');
  assert.equal(readFileSync(paths.cvPath, 'utf8'), beforeCv);
  assert.equal(readFileSync(paths.articlePath, 'utf8'), beforeArticle);
  assertNoTransactionDebris(paths);
});
