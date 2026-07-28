import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateDeterministicGate,
  extractEvaluationMetadata,
  formatGateRejection,
} from '../../src/evaluate/evaluation-gate.mjs';
import {
  SCORING_CONTRACT_VERSION,
  buildScoringPrompt,
  parseScoringResponse,
  renderEvaluationReport,
} from '../../src/evaluate/scoring-contract.mjs';
import { createLivenessChecker } from '../../src/scan/liveness-service.mjs';

const rules = {
  keep: [/\bhead\b/i, /\bdirector\b/i],
  ic: [/\bsoftware engineer\b/i],
  wrong: [/\bmarketing\b/i],
  junior: [/\bjunior\b/i],
  blockers: [],
  comp: { enabled: false, margin: 0.8 },
};
const profile = { minComp: 0, currency: 'GBP' };

test('destructive boundary: a deterministic rejection prevents provider eligibility', () => {
  const decision = evaluateDeterministicGate({
    jdText: '# Head of Marketing\n\nOwn demand generation.',
    profile,
    rules,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rule, 'wrong_function');
  assert.match(formatGateRejection(decision), /stopped before the model call/);
});

test('metadata extraction prefers explicit labels and otherwise uses the cached-JD heading', () => {
  assert.deepEqual(
    extractEvaluationMetadata('# Cached title\n\nCompany: Acme'),
    { title: 'Cached title', company: 'Acme' },
  );
  assert.deepEqual(
    extractEvaluationMetadata('# Cached title\n\nTitle: Explicit title\nCompany: Acme'),
    { title: 'Explicit title', company: 'Acme' },
  );
});

function validResult(overrides = {}) {
  return {
    version: SCORING_CONTRACT_VERSION,
    company: 'Acme',
    role: 'Director of Engineering',
    archetype: 'Engineering leadership',
    overallScore: 4.2,
    recommendation: 'Apply',
    dimensions: {
      cvMatch: { score: 4.5, evidence: ['Led comparable teams'] },
      northStar: { score: 4, evidence: ['Matches target direction'] },
      comp: { score: null, evidence: ['Not advertised'] },
      culture: { score: 3, evidence: ['Unknown'] },
      redFlags: { score: 4, evidence: ['No blocker found'] },
    },
    requirements: [{ requirement: 'Leadership', status: 'matched', evidence: 'CV role' }],
    risks: ['Compensation unknown'],
    customization: ['Lead with platform transformation'],
    interview: [{ question: 'How is the team structured?', evidenceToUse: 'Scaling story' }],
    legitimacy: { tier: 'High Confidence', signals: ['Specific JD'] },
    keywords: ['platform'],
    ...overrides,
  };
}

test('scoring prompt is versioned, JSON-only, and excludes inherited operational modes', () => {
  const prompt = buildScoringPrompt({ cv: 'CV FACT', profile: 'PROFILE', profileMode: 'TARGET' });
  assert.match(prompt, new RegExp(`SCORING_CONTRACT_VERSION: ${SCORING_CONTRACT_VERSION.replace('.', '\\.')}`));
  assert.match(prompt, /Return JSON only/);
  assert.doesNotMatch(prompt, /WebSearch|batch-runner|Playwright/);
});

test('destructive contract: malformed, unversioned, and out-of-range model output is rejected', () => {
  assert.throws(() => parseScoringResponse('I think this is a 4/5'), /not valid/);
  assert.throws(
    () => parseScoringResponse(JSON.stringify({ ...validResult(), version: '99' })),
    /unsupported scoring contract/,
  );
  assert.throws(
    () => parseScoringResponse(JSON.stringify({ ...validResult(), overallScore: 8 })),
    /between 1 and 5/,
  );
});

test('code—not the model—renders every report block and machine summary', () => {
  const parsed = parseScoringResponse(`\`\`\`json\n${JSON.stringify(validResult())}\n\`\`\``);
  const report = renderEvaluationReport(parsed);
  for (const block of 'ABCDEFG') assert.match(report, new RegExp(`Block ${block}`));
  assert.match(report, /SCORE: 4\.2/);
  assert.match(report, /CONTRACT_VERSION: 1\.0/);
});

test('API result prevents browser launch; inconclusive API uses browser exactly once', async () => {
  let browserLoads = 0;
  const apiOnly = createLivenessChecker({
    apiCheck: async () => ({ result: 'active', reason: 'provider record exists' }),
    loadChromium: async () => {
      browserLoads++;
      throw new Error('must not load');
    },
  });
  assert.equal((await apiOnly.check('https://example.com/job')).source, 'api');
  assert.equal(browserLoads, 0);

  const fakePage = {
    route: async () => {},
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    url: () => 'https://example.com/job',
    evaluate: async (fn) => String(fn).includes('querySelectorAll') ? ['Apply'] : 'Role description',
  };
  const fakeBrowser = {
    newContext: async () => ({ newPage: async () => fakePage }),
    close: async () => {},
  };
  const fallback = createLivenessChecker({
    apiCheck: async () => null,
    loadChromium: async () => {
      browserLoads++;
      return { launch: async () => fakeBrowser };
    },
  });
  const result = await fallback.check('https://example.com/job');
  assert.equal(result.source, 'browser');
  assert.equal(browserLoads, 1);
  await fallback.close();
});
