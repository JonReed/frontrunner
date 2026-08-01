#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { ROOT } from '#paths';
import { classify } from '../scan/prefilter.mjs';
import { readPrefilterConfig } from '../scan/prefilter-config.mjs';
import { runPrefilterCalibration } from './prefilter-calibration.mjs';
import {
  SCORING_CONTRACT_VERSION,
  buildScoringPrompt,
  parseScoringResponse,
  renderEvaluationReport,
} from '../evaluate/scoring-contract.mjs';

const approxTokens = (chars) => Math.ceil(chars / 4);

function sampleResult(job) {
  return {
    version: SCORING_CONTRACT_VERSION,
    company: 'Benchmark Co',
    role: job.title,
    archetype: 'Benchmark archetype',
    overallScore: job.score,
    recommendation: job.score >= 4 ? 'Apply' : job.score >= 3 ? 'Consider' : 'Skip',
    dimensions: {
      cvMatch: { score: Math.max(1, Math.min(5, job.score)), evidence: ['Fixture evidence'] },
      northStar: { score: Math.max(1, Math.min(5, job.score)), evidence: ['Fixture alignment'] },
      comp: { score: null, evidence: ['Not advertised'] },
      culture: { score: 3, evidence: ['Unknown'] },
      redFlags: { score: job.score < 2 ? 2 : 4, evidence: ['Fixture signal'] },
    },
    requirements: [{ requirement: 'Representative requirement', status: 'matched', evidence: 'Fixture evidence' }],
    risks: ['Representative risk'],
    customization: ['Representative tailoring action'],
    interview: [{ question: 'Representative question?', evidenceToUse: 'Fixture story' }],
    legitimacy: { tier: 'High Confidence', signals: ['Fixture signal'] },
    keywords: ['fixture'],
  };
}

export function runPipelineBenchmark({
  corpus,
  legacyStaticChars,
  compactStaticChars,
  rules,
  calibration,
}) {
  const started = performance.now();
  const boards = new Set(corpus.jobs.map((job) => `${job.provider}:${job.board}`));
  const profile = { minComp: 0, currency: 'GBP' };
  const decisions = corpus.jobs.map((job) => ({
    job,
    decision: classify(job.title, '', profile, rules),
  }));
  const kept = decisions.filter(({ decision }) => decision.verdict === 'keep');
  const falseRejects = decisions.filter(({ job, decision }) => job.score >= 3 && decision.verdict === 'reject');

  const legacyInputTokens = corpus.jobs.reduce(
    (sum, job) => sum + approxTokens(legacyStaticChars + job.renderedHtmlChars),
    0,
  );
  const frontrunnerInputTokens = kept.reduce(
    (sum, { job }) => sum + approxTokens(compactStaticChars + job.cleanDescriptionChars),
    0,
  );
  const legacyOutputTokens = corpus.jobs.reduce((sum, job) => sum + approxTokens(job.legacyOutputChars), 0);
  const frontrunnerOutputTokens = kept.reduce((sum, { job }) => {
    const report = renderEvaluationReport(parseScoringResponse(JSON.stringify(sampleResult(job))));
    return sum + approxTokens(report.length);
  }, 0);

  const pctReduction = (before, after) => Math.round((1 - after / before) * 1000) / 10;
  const result = {
    corpus: { roles: corpus.jobs.length, boards: boards.size },
    httpCalls: {
      legacy: corpus.jobs.length,
      frontrunner: boards.size,
      reductionPct: pctReduction(corpus.jobs.length, boards.size),
    },
    tokens: {
      input: {
        legacy: legacyInputTokens,
        frontrunner: frontrunnerInputTokens,
        reductionPct: pctReduction(legacyInputTokens, frontrunnerInputTokens),
      },
      output: {
        legacy: legacyOutputTokens,
        frontrunner: frontrunnerOutputTokens,
        reductionPct: pctReduction(legacyOutputTokens, frontrunnerOutputTokens),
      },
    },
    modelPass: {
      roles: kept.length,
      ratePct: Math.round((kept.length / corpus.jobs.length) * 1000) / 10,
    },
    falseRejects: {
      threshold: 3,
      count: falseRejects.length,
      roles: falseRejects.map(({ job }) => job.title),
    },
    wallTimeMs: Math.round((performance.now() - started) * 1000) / 1000,
  };
  if (calibration) result.calibration = calibration;
  return result;
}

function stableMetrics(result) {
  const { wallTimeMs: _ignored, ...stable } = result;
  return stable;
}

function benchmarkMarkdown(result) {
  const number = (value) => Number(value).toLocaleString('en-US');
  return `<!-- pipeline-benchmark:start -->
The checked-in ${result.corpus.roles}-role, ${result.corpus.boards}-board fixture currently produces:

| What was measured | inherited flow | Frontrunner | Result |
|---|---:|---:|---:|
| Separate job-listing lookups | ${number(result.httpCalls.legacy)} | ${number(result.httpCalls.frontrunner)} | ${result.httpCalls.reductionPct}% fewer |
| Approximate AI input needed | ${number(result.tokens.input.legacy)} | ${number(result.tokens.input.frontrunner)} | ${result.tokens.input.reductionPct}% less |
| Approximate AI output needed | ${number(result.tokens.output.legacy)} | ${number(result.tokens.output.frontrunner)} | ${result.tokens.output.reductionPct}% less |
| Roles kept for AI review | ${result.corpus.roles} | ${result.modelPass.roles} | All ${result.modelPass.roles} kept |
| Promising roles filtered out | — | ${result.falseRejects.count} | None |

The separate ${number(result.calibration.corpus.roles)}-role leadership calibration rejects
${number(result.calibration.lowScoreRejected)} of ${number(result.calibration.lowScoreRoles)} roles scoring
below ${result.calibration.threshold.toFixed(1)} (${result.calibration.lowScoreCapturePct}%) and rejects **${result.calibration.falseRejects.count} roles scoring ${result.calibration.threshold.toFixed(1)} or above**.
<!-- pipeline-benchmark:end -->`;
}

function updateReadmeBenchmark(result, { check = false } = {}) {
  const readmePath = join(ROOT, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const expected = benchmarkMarkdown(result);
  const pattern = /<!-- pipeline-benchmark:start -->[\s\S]*?<!-- pipeline-benchmark:end -->/;
  if (!pattern.test(readme)) throw new Error('README benchmark markers are missing');
  if (check) {
    if (readme.match(pattern)?.[0] !== expected) {
      throw new Error('README benchmark table is stale; run npm run benchmark');
    }
    return;
  }
  writeFileSync(readmePath, readme.replace(pattern, expected));
}

function main() {
  const args = process.argv.slice(2);
  const corpusPath = join(ROOT, 'src', 'benchmark', 'corpora', 'pipeline-corpus.json');
  const calibrationCorpusPath = join(ROOT, 'src', 'benchmark', 'corpora', 'prefilter-scored-corpus.json');
  const calibrationConfigPath = join(ROOT, 'src', 'benchmark', 'corpora', 'prefilter-leadership.yml');
  const artifactPath = join(ROOT, 'src', 'benchmark', 'corpora', 'pipeline-benchmark.json');
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const fixtureCv = '# CV\nDirector of Engineering. Led platform teams.';
  const fixtureProfile = 'target_roles:\n  - Engineering leadership\n';
  /*
    PINNED, not measured live.

    This is the inherited agent-first flow's static prompt: the whole of
    _shared.md plus an evaluation mode, re-sent for every role. It used to be
    computed by reading those two files at run time, which made the comparison
    move whenever anyone edited documentation — writing prose inflated our
    advantage, deleting prose shrank it, and neither had anything to do with
    the product getting better. Worse, an edit failed `benchmark:check` and
    blocked the commit until the artifact was regenerated.

    The number below is the size of that flow as it stood on 2026-08-01
    (_shared.md 24,530 chars + oferta.md 47,070). Update it only when the
    comparison itself is wrong — never to absorb a routine documentation edit.
  */
  const LEGACY_STATIC_PROMPT_CHARS = 71_600;
  const legacyStaticChars = LEGACY_STATIC_PROMPT_CHARS + fixtureCv.length + fixtureProfile.length;
  const compactStaticChars = buildScoringPrompt({
    cv: fixtureCv,
    profile: fixtureProfile,
    profileMode: 'Target senior engineering leadership roles.',
    languageInstruction: 'Write in English.',
  }).length;
  const rules = readPrefilterConfig(join(ROOT, 'config', 'prefilter.example.yml'));
  const calibration = runPrefilterCalibration({
    corpus: JSON.parse(readFileSync(calibrationCorpusPath, 'utf8')),
    rules: readPrefilterConfig(calibrationConfigPath),
    source: 'src/benchmark/corpora/prefilter-scored-corpus.json',
  });
  const result = runPipelineBenchmark({
    corpus,
    legacyStaticChars,
    compactStaticChars,
    rules,
    calibration,
  });

  if (args.includes('--check')) {
    if (!existsSync(artifactPath)) throw new Error('benchmark artifact is missing; run npm run benchmark');
    const recorded = JSON.parse(readFileSync(artifactPath, 'utf8'));
    if (JSON.stringify(stableMetrics(recorded)) !== JSON.stringify(stableMetrics(result))) {
      throw new Error('benchmark artifact is stale; run npm run benchmark');
    }
    updateReadmeBenchmark(recorded, { check: true });
  } else if (args.includes('--write')) {
    writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
    updateReadmeBenchmark(result);
  }
  console.log(JSON.stringify(result, null, 2));
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  try {
    main();
  } catch (error) {
    console.error(`benchmark failed: ${error.message}`);
    process.exitCode = 1;
  }
}
