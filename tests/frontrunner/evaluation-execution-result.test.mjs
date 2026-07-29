import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { ROOT } from '#paths';
import {
  evaluationExecutionResult,
  normalizeEvaluatorUsage,
  parseEvaluationExecutionResult,
} from '../../src/evaluate/execution-result.mjs';
import { runPipelineEvaluations } from '../../src/pipeline/run.mjs';

const worker = fileURLToPath(new URL('../fixtures/evaluation-result-worker.mjs', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-evaluation-accounting-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const jdsDir = join(dir, 'jds');
  mkdirSync(jdsDir);
  const roles = [
    { url: 'https://jobs.example/one' },
    { url: 'https://jobs.example/two' },
    { url: 'https://jobs.example/three' },
  ];
  for (let index = 0; index < roles.length; index++) {
    writeFileSync(join(jdsDir, `${String(index + 1)}.md`), `# Role ${String(index + 1)}\n`);
  }
  writeFileSync(
    join(jdsDir, 'index.tsv'),
    `url\tfile\n${roles.map((role, index) => `${role.url}\t${String(index + 1)}.md`).join('\n')}\n`,
  );
  return { jdsDir, roles };
}

test('execution result normalizes provider usage without admitting content fields', () => {
  assert.deepEqual(normalizeEvaluatorUsage({
    input_tokens: 20,
    output_tokens: 5,
    cache_read_input_tokens: 7,
  }), {
    promptTokens: 20,
    completionTokens: 5,
    totalTokens: 25,
    cachedTokens: 7,
  });
  assert.throws(
    () => parseEvaluationExecutionResult(JSON.stringify({
      ...evaluationExecutionResult({ usage: { prompt_tokens: 1 } }),
      jobUrl: 'https://attacker.example',
    })),
    /unsupported evaluation execution field/u,
  );
  assert.throws(
    () => parseEvaluationExecutionResult(JSON.stringify({
      version: '1',
      status: 'skipped',
      requestCount: 1,
    })),
    /skipped evaluation cannot report model activity/u,
  );
  assert.throws(
    () => parseEvaluationExecutionResult('x'.repeat(3_000)),
    /missing or oversized/u,
  );
  assert.equal(evaluationExecutionResult({ requestCount: 3 }).requestCount, 3);
});

test('fixed descriptor 3 carries one bounded result independently of stdout', () => {
  const result = spawnSync(process.execPath, [worker], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FRONTRUNNER_EVALUATION_RESULT_FD: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(parseEvaluationExecutionResult(result.output[3]), {
    version: '1',
    status: 'succeeded',
    requestCount: 1,
    usage: {
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
      cachedTokens: 4,
    },
  });
});

test('pipeline aggregates exact reported usage and exposes missing accounting', async t => {
  const { jdsDir, roles } = fixture(t);
  const envelopes = [
    evaluationExecutionResult({
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedTokens: 30,
      },
    }),
    evaluationExecutionResult({
      usage: {
        promptTokens: 50,
        completionTokens: 10,
        totalTokens: 60,
        cachedTokens: 0,
      },
    }),
    evaluationExecutionResult(),
  ];
  let calls = 0;
  const result = await runPipelineEvaluations({
    engine: 'openai',
    kept: roles,
    jdsDir,
    run(_command, _args, options) {
      assert.equal(options.resultChannel, true);
      return { evaluationResult: JSON.stringify(envelopes[calls++]) };
    },
  });

  assert.equal(result.attempted, 3);
  assert.equal(result.completed.length, 3);
  assert.equal(result.modelRequests, 3);
  assert.equal(result.usageReported, 2);
  assert.equal(result.usageMissing, 1);
  assert.deepEqual(result.usage, {
    promptTokens: 150,
    completionTokens: 30,
    totalTokens: 180,
    cachedTokens: 30,
  });
});

test('malformed, injected, skipped and absent child results fail closed per role', async t => {
  const { jdsDir, roles } = fixture(t);
  const outputs = [
    '{"version":"1","status":"succeeded","requestCount":1,"url":"https://evil"}',
    JSON.stringify(evaluationExecutionResult({ status: 'skipped' })),
    '',
  ];
  let calls = 0;
  const result = await runPipelineEvaluations({
    engine: 'claude',
    kept: roles,
    jdsDir,
    run() {
      return { evaluationResult: outputs[calls++] };
    },
  });

  assert.equal(result.completed.length, 0);
  assert.equal(result.failed.length, 3);
  assert.equal(result.modelRequests, 0);
  assert.equal(result.usageReported, 0);
  assert.equal(result.usageMissing, 0);
  assert.match(result.failed[0].error, /unsupported evaluation execution field/u);
  assert.match(result.failed[1].error, /evaluator gate rejected/u);
  assert.match(result.failed[2].error, /missing or oversized/u);
});

test('every pipeline evaluator emits the structured accounting contract', () => {
  for (const file of [
    'claude-eval.mjs',
    'openai-eval.mjs',
    'gemini-eval.mjs',
    'openrouter-runner.mjs',
  ]) {
    const source = readFileSync(join(ROOT, 'src', 'evaluate', file), 'utf8');
    assert.match(source, /emitEvaluationExecutionResult/u, file);
    assert.match(source, /evaluationExecutionResult/u, file);
  }
});
