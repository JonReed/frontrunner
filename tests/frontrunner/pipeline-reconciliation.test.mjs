import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import { acquirePipelineLock } from '../../src/tracker/pipeline-lock.mjs';
import { publishPipelineReconciliation } from '../../src/tracker/pipeline-reconciliation-write.mjs';

const NODE = process.execPath;
const CLI = join(ROOT, 'src/tracker/reconcile-pipeline.mjs');
const WORKER = join(ROOT, 'tests/fixtures/pipeline-reconciliation-worker.mjs');

function fixture() {
  const root = mkdtempSync(join(ROOT, '.frontrunner-pipeline-reconcile-'));
  const data = join(root, 'data');
  const batch = join(root, 'batch');
  const reports = join(root, 'reports');
  mkdirSync(data, { recursive: true });
  mkdirSync(batch, { recursive: true });
  mkdirSync(reports, { recursive: true });
  const pipeline = join(data, 'pipeline.md');
  const state = join(batch, 'batch-state.tsv');
  writeFileSync(pipeline, `# Pipeline

## Pending

- [ ] https://jobs.example/1 | Acme | Engineer

## Processed
`);
  writeFileSync(state, `id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries
1\thttps://jobs.example/1\tcompleted\t-\t-\t1\t4.2\t\t0
`);
  return { root, pipeline, state, reports };
}

test('destructive concurrency: reconciliation reads only after the shared pipeline lock', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const report = join(f.reports, '001-reconciliation-fixture.md');
  writeFileSync(report, '**Score:** 4.2/5\n**PDF:** Not generated\n');
  writeFileSync(f.pipeline, readFileSync(f.pipeline, 'utf8').replace(/\n/g, '\r\n'));

  const lock = await acquirePipelineLock(f.pipeline, {
    timeoutMs: 2_000,
    retryMs: 10,
    staleMs: 5_000,
  });
  let stdout = '';
  let stderr = '';
  const child = spawn(NODE, [
    CLI,
    '--pipeline', f.pipeline,
    '--state', f.state,
    '--reports', f.reports,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      FRONTRUNNER_PIPELINE_LOCK_TIMEOUT_MS: '3000',
      FRONTRUNNER_PIPELINE_LOCK_RETRY_MS: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  await new Promise(resolve => setTimeout(resolve, 100));
  const concurrent = '- [ ] https://jobs.example/2 | Beta | Analyst';
  const freshContent = `${readFileSync(f.pipeline, 'utf8').trimEnd()}\r\n${concurrent}\r\n`;
  writeFileSync(f.pipeline, freshContent);
  lock.release();

  const exit = await new Promise(resolve => child.once('close', resolve));
  assert.equal(exit, 0, `${stdout}\n${stderr}`);
  const after = readFileSync(f.pipeline, 'utf8');
  assert.match(after, /https:\/\/jobs\.example\/1/);
  assert.match(after, /https:\/\/jobs\.example\/2/);
  assert.match(after, /- \[x\]/);
  assert.match(after, /\]\(\.\.\/reports\/001-reconciliation-fixture\.md\)/);
  assert.equal(readFileSync(`${f.pipeline}.pre-reconcile.bak`, 'utf8'), freshContent);
});

test('destructive interruption after backup preserves the original and retry commits atomically', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const original = readFileSync(f.pipeline, 'utf8');
  const next = join(f.root, 'next.md');
  writeFileSync(next, original.replace('- [ ]', '- [x]'));

  const crashed = spawnSync(NODE, [
    WORKER,
    f.pipeline,
    next,
    'crash-after-backup',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(crashed.status, 0);
  assert.equal(readFileSync(f.pipeline, 'utf8'), original);
  assert.equal(readFileSync(`${f.pipeline}.pre-reconcile.bak`, 'utf8'), original);

  const retried = spawnSync(NODE, [WORKER, f.pipeline, next], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(readFileSync(f.pipeline, 'utf8'), readFileSync(next, 'utf8'));
  assert.equal(readFileSync(`${f.pipeline}.pre-reconcile.bak`, 'utf8'), original);
  assert.deepEqual(
    readdirSync(join(f.root, 'data')).filter(name => name.endsWith('.tmp')),
    [],
  );
});

test('an idempotent reconciliation creates neither a backup nor a replacement', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const original = readFileSync(f.pipeline, 'utf8');

  const result = publishPipelineReconciliation({
    pipelineFile: f.pipeline,
    currentContent: original,
    nextContent: original,
  });
  assert.deepEqual(result, { changed: false, backupPath: null });
  assert.equal(readFileSync(f.pipeline, 'utf8'), original);
  assert.equal(
    readdirSync(join(f.root, 'data')).some(name => name.includes('pre-reconcile')),
    false,
  );
});

test('path flags without values fail before reading or writing the inbox', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const original = readFileSync(f.pipeline, 'utf8');

  const result = spawnSync(NODE, [
    CLI,
    '--pipeline',
    '--state', f.state,
    '--reports', f.reports,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --pipeline: expected a path value/);
  assert.equal(readFileSync(f.pipeline, 'utf8'), original);
  assert.equal(
    readdirSync(join(f.root, 'data')).some(name => name.includes('pre-reconcile')),
    false,
  );
});

test('a custom reports directory produces a link to that exact directory', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const customReports = join(f.root, 'saved-evaluations');
  mkdirSync(customReports);
  writeFileSync(
    join(customReports, '001-reconciliation-fixture.md'),
    '**Score:** 4.2/5\n**PDF:** Not generated\n',
  );

  const result = spawnSync(NODE, [
    CLI,
    '--pipeline', f.pipeline,
    '--state', f.state,
    '--reports', customReports,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    readFileSync(f.pipeline, 'utf8'),
    /\]\(\.\.\/saved-evaluations\/001-reconciliation-fixture\.md\)/u,
  );
});
