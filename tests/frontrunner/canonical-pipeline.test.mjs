import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  resolvePipelineRunId,
  runCanonicalPipeline,
} from '../../src/pipeline/run.mjs';

test('pipeline reuses a valid application-service run id and rejects hostile inherited values', () => {
  let generated = 0;
  const runIdFactory = () => {
    generated += 1;
    return 'direct-pipeline-run';
  };
  assert.equal(resolvePipelineRunId({
    applicationRunId: 'job-pipeline-shared123',
    runIdFactory,
  }), 'job-pipeline-shared123');
  assert.equal(generated, 0);
  assert.equal(resolvePipelineRunId({
    applicationRunId: '../../hostile\nvalue',
    runIdFactory,
  }), 'direct-pipeline-run');
  assert.equal(generated, 1);
});

test('destructive pipeline: expired roles never reach prefilter or evaluation; uncertain roles do', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'pipeline.md');
  const jdsDir = join(dir, 'jds');
  const batchDir = join(dir, 'batch');
  mkdirSync(jdsDir);
  mkdirSync(batchDir);
  writeFileSync(input, [
    '# Pipeline',
    '- [ ] https://jobs.example/active | Acme | Director of Engineering |',
    '- [ ] https://jobs.example/expired | OldCo | VP Engineering |',
    '- [ ] https://jobs.example/uncertain | MaybeCo | Head of Platform |',
    '',
  ].join('\n'));

  const decisions = {
    'https://jobs.example/active': { result: 'active', source: 'api', reason: 'record exists' },
    'https://jobs.example/expired': { result: 'expired', source: 'api', reason: 'record absent' },
    'https://jobs.example/uncertain': { result: 'uncertain', source: 'browser', reason: 'timeout' },
  };
  let closed = false;
  let evaluated = [];
  const stageEvents = [];
  let clock = 1_000;
  const result = await runCanonicalPipeline({
    input,
    jdsDir,
    activeInput: join(batchDir, 'active.tsv'),
    batchInput: join(batchDir, 'batch-input.tsv'),
    rejects: join(batchDir, 'rejects.tsv'),
    livenessResults: join(batchDir, 'liveness.tsv'),
    engine: 'none',
    scan: false,
    now: () => clock++,
    onStage: event => stageEvents.push(event),
    fetchJds: async () => ({ urls: 3, requests: 0, available: 0 }),
    checker: {
      check: async (url) => decisions[url],
      close: async () => { closed = true; },
    },
    prefilter: ({ input: activeInput, out, rejects }) => {
      const text = readFileSync(activeInput, 'utf8');
      assert.doesNotMatch(text, /OldCo/);
      assert.match(text, /Acme/);
      assert.match(text, /MaybeCo/);
      writeFileSync(out, text);
      writeFileSync(rejects, 'url\tcompany\ttitle\trule\tevidence\n');
      const kept = [
        { url: 'https://jobs.example/active' },
        { url: 'https://jobs.example/uncertain' },
      ];
      return {
        kept,
        rejected: [],
        result: { roles: 2, kept: 2, rejected: 0 },
      };
    },
    evaluationRunner: async ({ kept }) => {
      evaluated = kept.map((role) => role.url);
      return { attempted: kept.length };
    },
  });

  assert.equal(closed, true);
  assert.deepEqual(evaluated, [
    'https://jobs.example/active',
    'https://jobs.example/uncertain',
  ]);
  assert.equal(result.liveness.expired, 1);
  assert.equal(result.liveness.uncertain, 1);
  assert.match(readFileSync(join(batchDir, 'rejects.tsv'), 'utf8'), /posting_expired/);
  const updatedPipeline = readFileSync(input, 'utf8');
  assert.match(updatedPipeline, /\[x\].*expired.*result: posting expired/);
  assert.match(updatedPipeline, /\[ \].*active/);
  assert.deepEqual(stageEvents.map(event => `${event.stage}:${event.state}`), [
    'cache:started',
    'cache:completed',
    'liveness:started',
    'liveness:completed',
    'prefilter:started',
    'prefilter:completed',
    'evaluation:started',
    'evaluation:completed',
  ]);
  assert.deepEqual(result.stageMetrics.map(stage => stage.stage), [
    'cache',
    'liveness',
    'prefilter',
    'evaluation',
  ]);
  assert.equal(result.stageMetrics.every(stage => stage.durationMs === 1), true);
  assert.deepEqual(result.stageMetrics.at(-1).counts, {
    attempted: 2,
    completed: 0,
    failed: 0,
    modelRequests: 0,
    usageReported: 0,
    usageMissing: 0,
  });
});

test('destructive pipeline: checker teardown runs when a liveness check throws', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-fail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'pipeline.md');
  writeFileSync(input, '- [ ] https://jobs.example/fail | Acme | Director Engineering |\n');
  let closed = false;
  const stageEvents = [];

  let failure;
  try {
    await runCanonicalPipeline({
      input,
      jdsDir: join(dir, 'jds'),
      activeInput: join(dir, 'active.tsv'),
      batchInput: join(dir, 'batch.tsv'),
      rejects: join(dir, 'rejects.tsv'),
      livenessResults: join(dir, 'live.tsv'),
      scan: false,
      onStage: event => stageEvents.push(event),
      fetchJds: async () => ({ urls: 1 }),
      checker: {
        check: async () => { throw new Error('browser crashed'); },
        close: async () => { closed = true; },
      },
    });
    assert.fail('pipeline unexpectedly succeeded');
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /browser crashed/u);
  assert.equal(closed, true);
  assert.deepEqual(stageEvents.map(event => `${event.stage}:${event.state}`), [
    'cache:started',
    'cache:completed',
    'liveness:started',
    'liveness:failed',
  ]);
  assert.deepEqual(failure.pipelineStageMetrics.map(stage => [
    stage.stage,
    stage.status,
  ]), [
    ['cache', 'succeeded'],
    ['liveness', 'failed'],
  ]);
});

test('canonical pipeline keeps bare inbox URLs and persists browser fallback text before filtering', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-bare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'pipeline.md');
  const jdsDir = join(dir, 'jds');
  writeFileSync(input, '# Pipeline\n\n## Pending\n- [ ] https://custom.example/jobs/42\n');

  let filteredJd = '';
  const result = await runCanonicalPipeline({
    input,
    jdsDir,
    activeInput: join(dir, 'active.tsv'),
    batchInput: join(dir, 'batch.tsv'),
    rejects: join(dir, 'rejects.tsv'),
    livenessResults: join(dir, 'liveness.tsv'),
    engine: 'none',
    scan: false,
    fetchJds: async () => ({ urls: 1, available: 0 }),
    checker: {
      check: async () => ({ result: 'active', source: 'browser', reason: 'loaded' }),
      extract: async () => ({
        title: 'Director of Engineering',
        text: 'Lead the platform engineering organization.',
      }),
      close: async () => {},
    },
    prefilter: ({ input: activeInput, jdsDir: cacheDir, out, rejects }) => {
      const active = readFileSync(activeInput, 'utf8');
      assert.match(active, /Director of Engineering/);
      const index = readFileSync(join(cacheDir, 'index.tsv'), 'utf8');
      const cachedFile = index.trim().split('\n')[1].split('\t')[1];
      filteredJd = readFileSync(cachedFile, 'utf8');
      writeFileSync(out, active);
      writeFileSync(rejects, 'url\tcompany\ttitle\trule\tevidence\n');
      return {
        kept: [{ id: '1', url: 'https://custom.example/jobs/42' }],
        rejected: [],
        result: { roles: 1, kept: 1, rejected: 0 },
      };
    },
  });

  assert.equal(result.inputRoles, 1);
  assert.equal(result.cache.fallbackCached, 1);
  assert.match(filteredJd, /Lead the platform engineering organization/);
});
