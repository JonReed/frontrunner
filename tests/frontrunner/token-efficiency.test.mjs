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

test('OpenAI and Gemini evaluators keep the per-role JD out of their system prompt', () => {
  for (const file of ['src/evaluate/openai-eval.mjs', 'src/evaluate/gemini-eval.mjs']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    const promptBuild = source.match(/const systemPrompt = buildScoringPrompt\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
    assert.ok(promptBuild, `${file}: scoring prompt construction not found`);
    assert.doesNotMatch(promptBuild, /\bjdText\b/, `${file}: JD leaked into cacheable system prompt`);
    assert.match(source, /JOB DESCRIPTION TO EVALUATE:\\n\\n\$\{jdText\}/, `${file}: JD is not a separate user turn`);
  }
});

test('batch workers are told not to re-read personalization already injected into context', () => {
  const prompt = readFileSync(join(ROOT, 'batch/batch-prompt.md'), 'utf8');
  const runner = readFileSync(join(ROOT, 'batch/batch-runner.sh'), 'utf8');

  assert.match(prompt, /Runtime personalization[\s\S]*do not read the same file again/i);
  assert.match(runner, /Do not read this path again/);
});
