#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { classify } from '../scan/prefilter.mjs';
import {
  readPrefilterConfig,
  resolvePrefilterConfigPath,
} from '../scan/prefilter-config.mjs';

const percent = (part, whole) => whole
  ? Math.round((part / whole) * 1_000) / 10
  : 0;

function validateCorpus(corpus, source) {
  if (!Array.isArray(corpus)) throw new Error(`${source}: corpus must be an array`);
  if (corpus.length === 0) throw new Error(`${source}: corpus must not be empty`);
  if (corpus.length > 10_000) throw new Error(`${source}: corpus exceeds 10,000 roles`);
  return corpus.map((role, index) => {
    if (!role || typeof role !== 'object' || Array.isArray(role)) {
      throw new Error(`${source}: role ${index + 1} must be an object`);
    }
    if (typeof role.title !== 'string' || !role.title.trim()) {
      throw new Error(`${source}: role ${index + 1} needs a title`);
    }
    if (role.title.length > 500) {
      throw new Error(`${source}: role ${index + 1} title exceeds 500 characters`);
    }
    if (typeof role.score !== 'number' || !Number.isFinite(role.score) || role.score < 0 || role.score > 5) {
      throw new Error(`${source}: role ${index + 1} score must be between 0 and 5`);
    }
    return { title: role.title.trim(), score: role.score };
  });
}

export function runPrefilterCalibration({
  corpus,
  rules,
  threshold = 3,
  profile = { minComp: 0, currency: 'GBP' },
  source = '<memory>',
}) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 5) {
    throw new Error('calibration threshold must be between 0 and 5');
  }
  const roles = validateCorpus(corpus, source);
  const decisions = roles.map((role) => ({
    ...role,
    decision: classify(role.title, '', profile, rules),
  }));
  const positive = decisions.filter((role) => role.score >= threshold);
  const negative = decisions.filter((role) => role.score < threshold);
  const rejected = decisions.filter((role) => role.decision.verdict === 'reject');
  const falseRejects = positive.filter((role) => role.decision.verdict === 'reject');
  const lowScoreRejected = negative.filter((role) => role.decision.verdict === 'reject');
  const byRule = {};
  for (const role of rejected) {
    byRule[role.decision.rule] = (byRule[role.decision.rule] ?? 0) + 1;
  }

  return {
    corpus: { roles: roles.length, source },
    threshold,
    highScoreRoles: positive.length,
    lowScoreRoles: negative.length,
    rejected: rejected.length,
    kept: decisions.length - rejected.length,
    falseRejects: {
      count: falseRejects.length,
      roles: falseRejects.map((role) => ({
        title: role.title,
        score: role.score,
        rule: role.decision.rule,
      })),
    },
    lowScoreRejected: lowScoreRejected.length,
    lowScoreCapturePct: percent(lowScoreRejected.length, negative.length),
    rejectionPrecisionPct: percent(lowScoreRejected.length, rejected.length),
    byRule,
  };
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

function renderSummary(result, configPath) {
  const lines = [
    'prefilter calibration',
    `  config:              ${configPath}`,
    `  corpus:              ${result.corpus.roles} scored roles`,
    `  threshold:           ${result.threshold.toFixed(1)}`,
    `  rejected:            ${result.rejected}`,
    `  false rejects:       ${result.falseRejects.count}`,
    `  low-score capture:   ${result.lowScoreRejected}/${result.lowScoreRoles} (${result.lowScoreCapturePct}%)`,
    `  rejection precision:${String(result.rejectionPrecisionPct).padStart(6)}%`,
    '  by rule:',
  ];
  for (const [rule, count] of Object.entries(result.byRule).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${String(count).padStart(4)}  ${rule}`);
  }
  if (result.falseRejects.roles.length) {
    lines.push('  false-reject roles:');
    for (const role of result.falseRejects.roles) {
      lines.push(`    ${role.score.toFixed(1)}  ${role.title} [${role.rule}]`);
    }
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`prefilter-calibration.mjs — measure an active rule set against scored roles

Usage:
  npm run benchmark:prefilter
  node src/benchmark/prefilter-calibration.mjs [--config <file>] [--corpus <file>]

Options:
  --config <file>    Rules to calibrate. Default: active user config, then shipped example
  --corpus <file>    Scored role corpus. Default: benchmarks/prefilter-scored-corpus.json
  --threshold <n>    False-reject threshold from 0 to 5. Default: 3
  --json             Print machine-readable output
  --check            Exit non-zero when any role at or above the threshold is rejected
`);
    return;
  }

  const configArg = argValue(args, '--config', '');
  const configPath = configArg
    ? resolve(configArg)
    : resolvePrefilterConfigPath();
  const corpusPath = resolve(argValue(
    args,
    '--corpus',
    join(ROOT, 'benchmarks', 'prefilter-scored-corpus.json'),
  ));
  if (!existsSync(corpusPath)) throw new Error(`calibration corpus does not exist: ${corpusPath}`);
  const threshold = Number(argValue(args, '--threshold', '3'));
  const rules = readPrefilterConfig(configPath);
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const result = runPrefilterCalibration({
    corpus,
    rules,
    threshold,
    source: corpusPath,
  });

  console.log(args.includes('--json')
    ? JSON.stringify(result, null, 2)
    : renderSummary(result, configPath));
  if (args.includes('--check') && result.falseRejects.count > 0) process.exitCode = 1;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  try {
    main();
  } catch (error) {
    console.error(`prefilter calibration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
