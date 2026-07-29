import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fileLockDirFor } from '../../src/lib/file-lock.mjs';
import {
  pipelineRunLockTarget,
  runCanonicalPipeline,
} from '../../src/pipeline/run.mjs';

const worker = new URL('../fixtures/pipeline-run-worker.mjs', import.meta.url);

function runWorker(input, batchDir, marker, holdMs = 400) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      worker.pathname,
      input,
      batchDir,
      marker,
      String(holdMs),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

function fixture(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const batchDir = join(dir, 'batch');
  const input = join(dir, 'pipeline.md');
  const marker = join(dir, 'evaluations.log');
  mkdirSync(batchDir);
  writeFileSync(
    input,
    '# Pipeline\n\n- [ ] https://jobs.example/role | Acme | Platform Engineer |\n',
  );
  return { dir, batchDir, input, marker };
}

test('destructive cross-process lease permits exactly one paid pipeline run', async t => {
  const paths = fixture(t, 'frontrunner-pipeline-lease-');
  const results = await Promise.all([
    runWorker(paths.input, paths.batchDir, paths.marker),
    runWorker(paths.input, paths.batchDir, paths.marker),
  ]);

  assert.deepEqual(
    results.map(result => result.code).sort((a, b) => a - b),
    [0, 23],
    results.map(result => result.stderr).join('\n'),
  );
  assert.equal(readFileSync(paths.marker, 'utf8').trim().split('\n').length, 1);
  assert.equal(
    existsSync(fileLockDirFor(pipelineRunLockTarget(join(paths.batchDir, 'active.tsv')))),
    false,
  );
});

test('dead pipeline owner is recovered before the next run', async t => {
  const paths = fixture(t, 'frontrunner-pipeline-stale-');
  const lockDir = fileLockDirFor(
    pipelineRunLockTarget(join(paths.batchDir, 'active.tsv')),
  );
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
    pid: 999_999_999,
    token: 'dead-owner',
  }));

  const result = await runWorker(paths.input, paths.batchDir, paths.marker, 0);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(paths.marker, 'utf8').trim().split('\n').length, 1);
  assert.equal(existsSync(lockDir), false);
});

test('pipeline failure releases the lease for an immediate retry', async t => {
  const paths = fixture(t, 'frontrunner-pipeline-release-');
  let checkerClosed = false;
  const common = {
    input: paths.input,
    jdsDir: join(paths.dir, 'jds'),
    activeInput: join(paths.batchDir, 'active.tsv'),
    batchInput: join(paths.batchDir, 'batch.tsv'),
    rejects: join(paths.batchDir, 'rejects.tsv'),
    livenessResults: join(paths.batchDir, 'liveness.tsv'),
    engine: 'none',
    scan: false,
    fetchJds: async () => { throw new Error('injected cache failure'); },
    checker: {
      check: async () => ({ result: 'active', source: 'api', reason: 'unused' }),
      close: async () => { checkerClosed = true; },
    },
  };

  await assert.rejects(runCanonicalPipeline(common), /injected cache failure/);
  assert.equal(checkerClosed, true);
  const lockDir = fileLockDirFor(pipelineRunLockTarget(common.activeInput));
  assert.equal(existsSync(lockDir), false);

  const result = await runWorker(paths.input, paths.batchDir, paths.marker, 0);
  assert.equal(result.code, 0, result.stderr);
});
