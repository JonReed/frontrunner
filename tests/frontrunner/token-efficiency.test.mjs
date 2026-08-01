import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { buildBudgetedPrompt } from '../../src/lib/context-budget.mjs';

test('API prompt budgeting counts a JD without duplicating it into the cacheable prefix', () => {
  const marker = 'ROLE-SPECIFIC-JD-MARKER';
  const { contextBody, budgetReport } = buildBudgetedPrompt({
    sharedContent: 'shared',
    ofertaContent: 'evaluation',
    cvContent: 'cv',
    jdText: marker,
    includeJdInContext: false,
  });

  assert.ok(budgetReport.totalTokens > 0);
  assert.ok(!contextBody.includes(marker));
});

test('the Claude evaluator keeps the per-role JD out of its cacheable system prompt', () => {
  // A JD inside the system prompt defeats prompt caching and re-bills the
  // static context on every role.
  const source = readFileSync(join(ROOT, 'src/evaluate/claude-eval.mjs'), 'utf8');
  const promptBuild = source.match(/buildScoringPrompt\(\{([\s\S]*?)\n\s*\}\)/)?.[1] ?? '';
  assert.ok(promptBuild, 'scoring prompt construction not found');
  assert.doesNotMatch(promptBuild, /\bjdText\b/, 'JD leaked into the cacheable system prompt');
});

test('batch does not duplicate personalization into a temporary worker prompt', () => {
  const runner = readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf8');
  const evaluator = readFileSync(join(ROOT, 'src/evaluate/claude-eval.mjs'), 'utf8');

  assert.doesNotMatch(runner, /\.resolved-prompt|Runtime personalization|batch-prompt\.md/);
  assert.match(evaluator, /buildScoringPrompt/);
  assert.match(evaluator, /workspace', 'profile', 'profile\.yml/);
});
