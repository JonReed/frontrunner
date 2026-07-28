import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCanonicalPipeline } from '../../src/pipeline/run.mjs';

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
  const result = await runCanonicalPipeline({
    input,
    jdsDir,
    activeInput: join(batchDir, 'active.tsv'),
    batchInput: join(batchDir, 'batch-input.tsv'),
    rejects: join(batchDir, 'rejects.tsv'),
    livenessResults: join(batchDir, 'liveness.tsv'),
    engine: 'none',
    scan: false,
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
});

test('destructive pipeline: checker teardown runs when a liveness check throws', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-fail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'pipeline.md');
  writeFileSync(input, '- [ ] https://jobs.example/fail | Acme | Director Engineering |\n');
  let closed = false;

  await assert.rejects(
    runCanonicalPipeline({
      input,
      jdsDir: join(dir, 'jds'),
      activeInput: join(dir, 'active.tsv'),
      batchInput: join(dir, 'batch.tsv'),
      rejects: join(dir, 'rejects.tsv'),
      livenessResults: join(dir, 'live.tsv'),
      scan: false,
      fetchJds: async () => ({ urls: 1 }),
      checker: {
        check: async () => { throw new Error('browser crashed'); },
        close: async () => { closed = true; },
      },
    }),
    /browser crashed/,
  );
  assert.equal(closed, true);
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
