#!/usr/bin/env node
/**
 * Tool-less Claude evaluator.
 *
 * Claude receives only bounded text and must return the scoring JSON schema.
 * It has no Read, Write, Bash, browser, MCP, extension, hook, or session tools.
 * Deterministic code validates the response and writes reports/tracker rows.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import { frameUntrustedJobText } from '../security/job-document.mjs';
import { evaluateDeterministicGate, formatGateRejection } from './evaluation-gate.mjs';
import {
  SCORING_JSON_SCHEMA,
  buildScoringPrompt,
  parseScoringResponse,
} from './scoring-contract.mjs';
import { saveEvaluation } from './save-evaluation.mjs';
import {
  emitEvaluationExecutionResult,
  evaluationExecutionResult,
  normalizeEvaluatorUsage,
} from './execution-result.mjs';
import { runBoundedSubprocess } from '../security/subprocess.mjs';

function defaultClaudeRun(command, args, options) {
  return runBoundedSubprocess(command, args, {
    cwd: options.cwd,
    input: options.input,
    timeoutMs: options.timeout,
    maxStdoutBytes: options.maxBuffer,
    maxStderrBytes: Math.min(options.maxBuffer, 512 * 1024),
  });
}

function readOptional(file, fallback) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : fallback;
}

function parseClaudeEnvelope(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(String(stdout ?? '').trim());
  } catch {
    throw new Error('Claude CLI did not return valid JSON');
  }
  const candidate = envelope.structured_output ?? envelope.result ?? envelope;
  return {
    candidate: typeof candidate === 'string' ? candidate : JSON.stringify(candidate),
    usage: normalizeEvaluatorUsage(envelope.usage),
  };
}

export function buildClaudeArgs({ systemPrompt, model = '' }) {
  const args = [
    '-p',
    '--safe-mode',
    '--strict-mcp-config',
    '--tools', '',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SCORING_JSON_SCHEMA),
    '--system-prompt', systemPrompt,
  ];
  if (model) args.push('--model', model);
  return args;
}

export async function runClaudeEvaluation({
  jdText,
  model = '',
  reportNumber = null,
  sourceUrl = null,
  save = true,
  run = defaultClaudeRun,
} = {}) {
  const document = frameUntrustedJobText(jdText);
  if (!document.text) throw new Error('job description is empty');

  const gate = evaluateDeterministicGate({ jdText: document.text });
  if (!gate.allowed) return { skipped: true, gate };

  const profileYml = readOptional(join(ROOT, 'config', 'profile.yml'), '[profile not found]');
  const systemPrompt = buildScoringPrompt({
    cv: readOptional(join(ROOT, 'cv.md'), '[CV not found]'),
    profile: profileYml,
    profileMode: readOptional(join(ROOT, 'modes', '_profile.md'), '[targeting rules not found]'),
    articleDigest: readOptional(join(ROOT, 'article-digest.md'), '[none supplied]'),
    customRules: readOptional(join(ROOT, 'modes', '_custom.md'), '[none]'),
    languageInstruction: outputLanguageInstruction(parseOutputLanguage(profileYml)),
  });

  const child = await run('claude', buildClaudeArgs({ systemPrompt, model }), {
    cwd: ROOT,
    input: document.prompt,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const detail = String(child.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 500);
    throw new Error(`Claude evaluator exited ${child.status}${detail ? `: ${detail}` : ''}`);
  }

  const envelope = parseClaudeEnvelope(child.stdout);
  const result = parseScoringResponse(envelope.candidate);
  const artifact = save
    ? await saveEvaluation(result, {
      tool: `Claude tool-less evaluator${model ? ` (${model})` : ''}`,
      sourceUrl,
      reportNumber,
    })
    : null;
  return {
    skipped: false,
    result,
    usage: envelope.usage,
    artifact,
    security: {
      tools: false,
      suspiciousSignals: document.suspiciousSignals.length,
      inputSha256: document.sha256,
      truncated: document.truncated,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`frontrunner Claude evaluator — tool-less structured scoring

Usage:
  node src/evaluate/claude-eval.mjs --file <cached-jd> [--model <name>]
  node src/evaluate/claude-eval.mjs "<job description>"

The model has zero tools. Code validates JSON and writes the report/tracker.`);
    return;
  }
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const file = value('--file');
  const jdText = file
    ? readFileSync(resolve(file), 'utf8')
    : args.filter((arg, index) => !arg.startsWith('--') && !['--file', '--model', '--report-num', '--url'].includes(args[index - 1])).join(' ');
  const output = await runClaudeEvaluation({
    jdText,
    model: value('--model') ?? '',
    reportNumber: value('--report-num'),
    sourceUrl: value('--url'),
    save: !args.includes('--no-save'),
  });
  if (output.skipped) {
    console.log(formatGateRejection(output.gate));
    emitEvaluationExecutionResult(evaluationExecutionResult({ status: 'skipped' }));
    return;
  }
  console.log(JSON.stringify({
    score: output.result.overallScore,
    company: output.result.company,
    role: output.result.role,
    report: output.artifact?.filename ?? null,
    security: output.security,
  }));
  emitEvaluationExecutionResult(evaluationExecutionResult({
    status: 'succeeded',
    usage: output.usage,
  }));
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  main().catch((error) => {
    console.error(`claude-eval failed: ${error.message}`);
    process.exitCode = 1;
  });
}
