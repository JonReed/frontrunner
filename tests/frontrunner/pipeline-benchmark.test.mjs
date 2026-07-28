import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { runPipelineBenchmark } from '../../src/benchmark/pipeline-benchmark.mjs';

const rules = {
  keep: [/\b(head|director|vp|lead|manager)\b/i],
  ic: [/\bsoftware engineer\b/i],
  wrong: [/\b(marketing|tax accountant)\b/i],
  junior: [/\bjunior\b/i],
  blockers: [],
  comp: { enabled: false, margin: 0.8 },
};

test('benchmark reports every required efficiency and safety measure', () => {
  const corpus = JSON.parse(readFileSync(
    new URL('../../benchmarks/pipeline-corpus.json', import.meta.url),
    'utf8',
  ));
  const result = runPipelineBenchmark({
    corpus,
    legacyStaticChars: 50_000,
    compactStaticChars: 2_000,
    rules,
  });
  assert.equal(result.corpus.roles, 8);
  assert.ok(result.httpCalls.reductionPct > 0);
  assert.ok(result.tokens.input.reductionPct > 0);
  assert.ok(result.tokens.output.reductionPct > 0);
  assert.ok(result.modelPass.ratePct > 0 && result.modelPass.ratePct < 100);
  assert.equal(result.falseRejects.count, 0);
  assert.ok(result.wallTimeMs >= 0);
});
