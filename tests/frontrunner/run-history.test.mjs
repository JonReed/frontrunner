import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  APPLICATION_RUN_ID_ENV,
  DEFAULT_RUN_HISTORY_BYTES,
  applicationRunHistoryRecord,
  pipelineRunHistoryRecord,
  readRunHistory,
  redactRunHistoryText,
  resolveRunHistoryRunId,
  writeRunHistory,
  writeRunHistorySafely,
} from '../../src/application/run-history.mjs';
import { main as applicationMain } from '../../src/application/run.mjs';

const worker = fileURLToPath(new URL('../fixtures/run-history-worker.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-run-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'nested', 'run-history.ndjson') };
}

function record(index, overrides = {}) {
  return {
    runId: `run-${String(index)}`,
    operation: 'pipeline.run',
    status: 'succeeded',
    startedAt: index * 10,
    finishedAt: index * 10 + 5,
    costsTokens: true,
    ...overrides,
  };
}

function runWorker(file, prefix, count) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      worker,
      file,
      prefix,
      String(count),
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
}

test('run history is bounded, private, and excludes unapproved metadata', async t => {
  const { file } = fixture(t);
  for (let index = 0; index < 5; index++) {
    await writeRunHistory({
      ...record(index),
      url: `https://jobs.example/${String(index)}`,
      description: 'hostile job text',
      outputTail: 'model output',
      counts: { roles: index, invalid_key: 99 },
    }, { file, maxRecords: 3 });
  }

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(line => JSON.parse(line).runId), ['run-2', 'run-3', 'run-4']);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /jobs\.example|hostile job text|model output/u);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(file).mode & 0o077, 0);
  }
});

test('run history reader is newest-first, filtered, bounded, and fails closed on corruption', async t => {
  const { file } = fixture(t);
  await writeRunHistory(record(1, { operation: 'scan.run', costsTokens: false }), { file });
  await writeRunHistory(record(2, { status: 'failed' }), { file });
  await writeRunHistory(record(3), { file });

  assert.deepEqual(
    readRunHistory({ file, limit: 2 }).map(item => item.runId),
    ['run-3', 'run-2'],
  );
  assert.deepEqual(
    readRunHistory({ file, operation: 'pipeline.run', status: 'failed' })
      .map(item => item.runId),
    ['run-2'],
  );
  assert.equal(Object.isFrozen(readRunHistory({ file })), true);
  assert.throws(() => readRunHistory({ file, limit: 51 }), /between 1 and 50/u);

  writeFileSync(file, `${readFileSync(file, 'utf8')}not-json\n`);
  assert.throws(() => readRunHistory({ file }), /invalid run history record/u);

  writeFileSync(file, 'x'.repeat(DEFAULT_RUN_HISTORY_BYTES + 1));
  assert.throws(() => readRunHistory({ file }), /maximum readable size/u);
});

test('parent lifecycle upsert preserves detailed child accounting', async t => {
  const { file } = fixture(t);
  await writeRunHistory(record(1, {
    startedAt: 110,
    finishedAt: 190,
    counts: { evaluationsCompleted: 2, modelRequests: 2 },
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 30 },
    stages: [{
      stage: 'evaluation',
      status: 'succeeded',
      startedAt: 120,
      finishedAt: 180,
      counts: { attempted: 2, completed: 2 },
    }],
  }), { file });
  await writeRunHistory(record(1, {
    startedAt: 100,
    finishedAt: 200,
  }), { file });

  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].startedAt, 100);
  assert.equal(records[0].finishedAt, 200);
  assert.equal(records[0].durationMs, 100);
  assert.equal(records[0].counts.modelRequests, 2);
  assert.equal(records[0].usage.totalTokens, 120);
  assert.equal(records[0].stages[0].stage, 'evaluation');
  assert.equal(records[0].stages[0].durationMs, 60);
});

test('a generic successful parent cannot erase a detailed child failure', async t => {
  const { file } = fixture(t);
  await writeRunHistory(record(9, {
    status: 'failed',
    startedAt: 110,
    finishedAt: 190,
    counts: { evaluationsCompleted: 1, evaluationsFailed: 1 },
    stages: [{
      stage: 'evaluation',
      status: 'failed',
      startedAt: 120,
      finishedAt: 180,
    }],
  }), { file });
  await writeRunHistory(record(9, {
    status: 'succeeded',
    startedAt: 100,
    finishedAt: 200,
  }), { file });

  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.status, 'failed');
  assert.equal(stored.startedAt, 100);
  assert.equal(stored.finishedAt, 200);
  assert.equal(stored.counts.evaluationsFailed, 1);
  assert.equal(stored.stages[0].status, 'failed');
});

test('application run identity is reused only when it satisfies the closed history contract', () => {
  let fallbackCalls = 0;
  const fallback = () => {
    fallbackCalls += 1;
    return 'generated-run';
  };
  assert.equal(
    resolveRunHistoryRunId('job-pipeline-correlated123', fallback),
    'job-pipeline-correlated123',
  );
  assert.equal(fallbackCalls, 0);
  assert.equal(resolveRunHistoryRunId('../hostile\nid', fallback), 'generated-run');
  assert.equal(fallbackCalls, 1);
  assert.equal(APPLICATION_RUN_ID_ENV, 'FRONTRUNNER_APPLICATION_RUN_ID');
  assert.throws(
    () => resolveRunHistoryRunId('', () => '../still-invalid'),
    /invalid run id/u,
  );
});

test('run history redacts likely credentials from the only free-text field', async t => {
  const { file } = fixture(t);
  const secret = 'sk-super-secret-123456';
  await writeRunHistory(record(1, {
    status: 'failed',
    error: `Bearer abc.def API_KEY=${secret} password=hunter2 https://jon:pass@example.com/x`,
  }), { file });

  const stored = readFileSync(file, 'utf8');
  assert.doesNotMatch(stored, /abc\.def|super-secret|hunter2|jon:pass/u);
  assert.match(stored, /\[redacted\]/u);
  assert.doesNotMatch(redactRunHistoryText(`token=${secret}`), /super-secret/u);
  assert.doesNotMatch(
    redactRunHistoryText('{"api_key":"danger-value"} AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyz'),
    /danger-value|AKIAIOSFODNN7EXAMPLE|ghp_abcdefghijklmnopqrstuvwxyz/u,
  );
});

test('corruption and an interrupted atomic replacement preserve prior history', async t => {
  const { file } = fixture(t);
  await writeRunHistory(record(1), { file });
  const prior = readFileSync(file, 'utf8');

  await assert.rejects(
    writeRunHistory(record(2), {
      file,
      writeOptions: {
        afterWrite() {
          throw new Error('injected power loss');
        },
      },
    }),
    /injected power loss/u,
  );
  assert.equal(readFileSync(file, 'utf8'), prior);

  writeFileSync(file, `${prior}{broken json\n`);
  const corrupted = readFileSync(file, 'utf8');
  await assert.rejects(writeRunHistory(record(3), { file }), /invalid run history record/u);
  assert.equal(readFileSync(file, 'utf8'), corrupted);
});

test('run history refuses to replace a symbolic-link target', async t => {
  const { dir, file } = fixture(t);
  const target = join(dir, 'target');
  mkdirSync(join(dir, 'nested'));
  writeFileSync(target, 'do not replace\n');
  symlinkSync(target, file);

  await assert.rejects(writeRunHistory(record(1), { file }), /symbolic link/u);
  assert.equal(readFileSync(target, 'utf8'), 'do not replace\n');
});

test('destructive concurrent writers retain every completed run across repeated contention', async t => {
  const { file } = fixture(t);
  const prefixes = ['alpha', 'bravo', 'charlie', 'delta'];
  for (let batch = 0; batch < 2; batch++) {
    const results = await Promise.all(prefixes.map(prefix =>
      runWorker(file, `${prefix}-${String(batch)}`, 25)));
    assert.deepEqual(
      results.map(result => result.code),
      [0, 0, 0, 0],
      results.map(result => result.stderr).join('\n'),
    );
  }

  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const expected = new Set(Array.from({ length: 2 }, (_, batch) =>
    prefixes.flatMap(prefix =>
      Array.from({ length: 25 }, (_, index) => `${prefix}-${String(batch)}-${String(index)}`)))
    .flat());
  const actual = new Set(records.map(item => item.runId));
  assert.deepEqual([...expected].filter(runId => !actual.has(runId)), []);
  assert.equal(records.length, expected.size);
  assert.equal(actual.size, expected.size);
});

test('application and pipeline adapters expose useful counts without hostile content', () => {
  const application = applicationRunHistoryRecord({
    runId: 'job-scan-abc123',
    operation: 'scan.run',
    status: 'succeeded',
    startedAt: 100,
    finishedAt: 140,
    exitCode: 0,
    outputTail: 'must not persist',
  }, { costsTokens: false });
  assert.deepEqual(application, {
    version: '1',
    runId: 'job-scan-abc123',
    operation: 'scan.run',
    status: 'succeeded',
    startedAt: 100,
    finishedAt: 140,
    durationMs: 40,
    costsTokens: false,
    exitCode: 0,
  });

  const pipeline = pipelineRunHistoryRecord({
    inputRoles: 8,
    liveness: { active: 5, uncertain: 1, expired: 2 },
    prefilter: { kept: 3, rejected: 3 },
    evaluation: {
      attempted: 3,
      completed: ['secret-url-1', 'secret-url-2'],
      failed: [{ url: 'secret-url-3', error: 'secret description' }],
      usage: { prompt_tokens: 120, completion_tokens: 20, cached_tokens: 10 },
    },
    stageMetrics: [{
      stage: 'evaluation',
      status: 'failed',
      startedAt: 1_100,
      finishedAt: 1_200,
      counts: { attempted: 3, failed: 1 },
    }],
  }, {
    runId: 'pipeline-1',
    startedAt: 1_000,
    finishedAt: 1_250,
    engine: 'claude',
  });
  assert.equal(pipeline.status, 'failed');
  assert.equal(pipeline.counts.evaluationsCompleted, 2);
  assert.equal(pipeline.usage.totalTokens, 140);
  assert.deepEqual(pipeline.stages, [{
    stage: 'evaluation',
    status: 'failed',
    startedAt: 1_100,
    finishedAt: 1_200,
    durationMs: 100,
    counts: { attempted: 3, failed: 1 },
  }]);
  assert.doesNotMatch(JSON.stringify(pipeline), /secret-url|secret description/u);
});

test('audit storage failure never changes a completed backend result', async () => {
  let warning = '';
  const result = await writeRunHistorySafely(
    async () => { throw new Error('disk full'); },
    record(1),
    error => { warning = error.message; },
  );
  assert.equal(result, null);
  assert.equal(warning, 'disk full');
  assert.equal(existsSync('/definitely-not-created-by-this-test'), false);
});

test('the application adapter publishes exactly one terminal audit record', async () => {
  const audits = [];
  let output = '';
  let errors = '';
  const result = await applicationMain({
    input: Readable.from([JSON.stringify({
      version: '1',
      operation: 'scan.run',
      input: {},
    })]),
    output: { write(chunk) { output += chunk; } },
    errorOutput: { write(chunk) { errors += chunk; } },
    auditWriter: async audit => { audits.push(audit); },
    async execute(request, options) {
      options.onEvent({
        version: '1',
        runId: 'job-scan-adapter',
        sequence: 0,
        at: 10,
        type: 'accepted',
        operation: request.operation,
        costsTokens: false,
      });
      return {
        version: '1',
        runId: 'job-scan-adapter',
        operation: request.operation,
        status: 'succeeded',
        startedAt: 10,
        finishedAt: 20,
        exitCode: 0,
        signal: null,
        outputTail: 'untrusted output must not persist',
        error: null,
      };
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.match(output, /"type":"accepted"/u);
  assert.equal(errors, '');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operation, 'scan.run');
  assert.equal(audits[0].costsTokens, false);
  assert.doesNotMatch(JSON.stringify(audits[0]), /untrusted output/u);
});
