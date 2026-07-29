#!/usr/bin/env node
/**
 * gemini-eval.mjs — Gemini-powered Job Offer Evaluator for frontrunner
 *
 * A free-tier alternative using Frontrunner's mandatory deterministic gate
 * and compact, versioned scoring contract.
 *
 * Usage:
 *   node src/evaluate/gemini-eval.mjs "Paste full JD text here"
 *   node src/evaluate/gemini-eval.mjs --file ./jds/my-job.txt
 *
 * Requires:
 *   GEMINI_API_KEY in .env (or environment variable)
 *
 * Default model: gemini-3.6-flash (GA July 2026)
 *
 * Model deprecation reference (per Google AI for Developers, May 2026):
 *   - gemini-2.0-flash       deprecated 2026-03-31  (do not use — generateContent 404)
 *   - gemini-2.0-flash-lite  deprecated 2026-03-31
 *   - gemini-2.5-flash       deprecated 2026-06-17
 *   - gemini-2.5-flash-lite  deprecated 2026-07-22
 *   - gemini-3.5-flash       prior Flash generation (still available)
 *   - gemini-3.6-flash       current default (stable)
 * Stable Gemini models follow a 12-month lifecycle from their release date.
 * Source: https://ai.google.dev/gemini-api/docs/models
 *
 * When the current default approaches its deprecation date, bump
 * `modelName` below and the `--model` examples accordingly.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { TokenAccumulator, formatBreakdown } from '../lib/token-tracker.mjs';

const tracker = new TokenAccumulator();
tracker.recordZeroToken('scan');
tracker.recordZeroToken('pdf payload');
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import { evaluateDeterministicGate, formatGateRejection } from './evaluation-gate.mjs';
import { frameUntrustedJobText } from '../security/job-document.mjs';
import {
  buildScoringPrompt,
  parseScoringResponse,
  renderEvaluationReport,
} from './scoring-contract.mjs';
import { saveEvaluation } from './save-evaluation.mjs';
import {
  emitEvaluationExecutionResult,
  evaluationExecutionResult,
} from './execution-result.mjs';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv is optional — fall back to process.env if not installed
}

import { GoogleGenerativeAI } from '@google/generative-ai';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
import { ROOT } from '#paths';
const PATHS = {
  cv:          join(ROOT, 'cv.md'),
  profile:     join(ROOT, 'modes', '_profile.md'),
  profileYml:  join(ROOT, 'config', 'profile.yml'),
  articleDigest: join(ROOT, 'article-digest.md'),
  customRules: join(ROOT, 'modes', '_custom.md'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           frontrunner — Gemini Evaluator (free-tier)             ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using Google Gemini instead of Claude.

  USAGE
    node src/evaluate/gemini-eval.mjs "<JD text>"
    node src/evaluate/gemini-eval.mjs --file ./jds/my-job.txt
    node src/evaluate/gemini-eval.mjs --model gemini-3.6-flash "<JD text>"

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Gemini model to use (default: gemini-3.6-flash)
    --no-save        Do not save report to reports/ directory
    --help           Show this help

  SETUP
    1. Get a free API key at https://aistudio.google.com/apikey
    2. Add GEMINI_API_KEY=<your-key> to .env
    3. Run: npm install   (installs @google/generative-ai + dotenv)

  EXAMPLES
    node src/evaluate/gemini-eval.mjs "We are looking for a Senior AI Engineer..."
    node src/evaluate/gemini-eval.mjs --file ./jds/openai-swe.txt
`);
  process.exit(0);
}

// Parse flags
let jdText = '';
let modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
let saveReport = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}
const jobDocument = frameUntrustedJobText(jdText);
jdText = jobDocument.text;
if (jobDocument.suspiciousSignals.length) {
  console.warn(`⚠️   Job text contains ${jobDocument.suspiciousSignals.length} instruction-like signal(s); treating all text as data.`);
}

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(`
❌  GEMINI_API_KEY not found.

   1. Get a free key at https://aistudio.google.com/apikey
   2. Add it to .env:   GEMINI_API_KEY=your_key_here
   3. Or export it:     export GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

// ---------------------------------------------------------------------------
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const cvContent      = readFile(PATHS.cv,          'cv.md');
const profileContent = readFile(PATHS.profile,     'modes/_profile.md');
const profileYml     = readFile(PATHS.profileYml,  'config/profile.yml');
const articleDigest  = existsSync(PATHS.articleDigest) ? readFileSync(PATHS.articleDigest, 'utf8').trim() : '';
const customRules    = existsSync(PATHS.customRules) ? readFileSync(PATHS.customRules, 'utf8').trim() : '';
const languageInstruction = outputLanguageInstruction(parseOutputLanguage(profileYml));

// ---------------------------------------------------------------------------
// Mandatory zero-token boundary.
// ---------------------------------------------------------------------------
const gate = evaluateDeterministicGate({
  jdText,
});
if (!gate.allowed) {
  console.log(`\n⏭️  ${formatGateRejection(gate)}`);
  console.log(JSON.stringify(gate, null, 2));
  emitEvaluationExecutionResult(evaluationExecutionResult({ status: 'skipped' }));
  process.exit(0);
}

const systemPrompt = buildScoringPrompt({
  cv: cvContent,
  profile: profileYml,
  profileMode: profileContent,
  articleDigest,
  customRules,
  languageInstruction,
});
console.log(`📊  Compact scoring contract: ~${Math.ceil(systemPrompt.length / 4).toLocaleString()} static tokens`);

// ---------------------------------------------------------------------------
// Call Gemini API
// ---------------------------------------------------------------------------
console.log(`🤖  Calling Gemini (${modelName})... this may take 30-60 seconds.\n`);

const genAI = new GoogleGenerativeAI(apiKey);
// Prompt caching (#1709) — engine 3 of the four, adapted to Gemini's shape.
// Gemini has no `cache_control` field; its lever is the large static prefix
// (shared + oferta + cv) being a stable `systemInstruction` rather than the first
// turn of `contents` — that's what its 2.5 models cache implicitly across
// back-to-back requests. So the static context moves to `systemInstruction` and
// generateContent() carries only the per-JD user turn. The prompt text is
// unchanged — just where it sits in the request.
const model = genAI.getGenerativeModel({
  model: modelName,
  systemInstruction: systemPrompt,
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 4096,
  },
});

let evaluationText;
let scoringResult;
let evaluationUsage;
try {
  const result = await model.generateContent(jobDocument.prompt);
  scoringResult = parseScoringResponse(result.response.text());
  evaluationText = renderEvaluationReport(scoringResult);
  const usage = {
    prompt_tokens: result.response.usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: result.response.usageMetadata?.totalTokenCount ?? 0,
    cached_tokens: result.response.usageMetadata?.cachedContentTokenCount ?? 0
  };
  evaluationUsage = usage;
  tracker.record('evaluation', usage);
} catch (err) {
  const sanitizedMsg = (err.message || '').split(apiKey).join('[REDACTED]');
  console.error('❌  Gemini API error:', sanitizedMsg);
  if (sanitizedMsg.includes('API_KEY')) {
    console.error('    Check your GEMINI_API_KEY in .env');
  } else if (sanitizedMsg.includes('quota') || sanitizedMsg.includes('rate')) {
    console.error('    You may have hit the free-tier rate limit. Wait 60s and retry.');
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log('  FRONTRUNNER EVALUATION — powered by Google Gemini');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

const score = scoringResult.overallScore.toFixed(1);
const archetype = scoringResult.archetype;
const legitimacy = scoringResult.legitimacy.tier;

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  try {
    const artifact = await saveEvaluation(scoringResult, {
      tool: `Gemini (${modelName})`,
      rootDir: ROOT,
    });
    console.log(`\n✅  Report saved: reports/${artifact.filename}`);
    console.log('📊  Tracker merged into data/applications.md.');
  } catch (err) {
    console.warn(`⚠️   Could not publish evaluation: ${err.message}`);
    console.warn('⚠️   Any pending publication journal will be recovered on the next evaluation.');
    process.exitCode = 1;
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');

console.log(formatBreakdown(tracker, modelName, 'gemini'));
emitEvaluationExecutionResult(evaluationExecutionResult({
  status: 'succeeded',
  usage: evaluationUsage,
}));
