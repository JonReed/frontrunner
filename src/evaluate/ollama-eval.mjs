#!/usr/bin/env node
/**
 * ollama-eval.mjs — Ollama-powered Job Offer Evaluator for frontrunner
 *
 * Local, free, private evaluator using Frontrunner's mandatory deterministic
 * gate and compact, versioned scoring contract.
 *
 * Usage:
 *   node src/evaluate/ollama-eval.mjs "Paste full JD text here"
 *   node src/evaluate/ollama-eval.mjs --file ./workspace/jobs/descriptions/my-job.txt
 *   node src/evaluate/ollama-eval.mjs --model qwen2.5:72b --file ./workspace/jobs/descriptions/my-job.txt
 *
 * Requires:
 *   Ollama running locally — https://ollama.com
 *   A model pulled:  ollama pull llama3.3
 *
 * Context window guidance:
 *   The prompt (cv + modes + JD) is ~10K-15K tokens.
 *   Recommended models (32K+ context): llama3.3, mistral-nemo, qwen2.5, gemma3
 *   Smaller models (llama3.2:3b, phi3) may produce incomplete evaluations.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import { TokenAccumulator, formatBreakdown, normalizeOpenAIUsage } from '../lib/token-tracker.mjs';
import { evaluateDeterministicGate, formatGateRejection } from './evaluation-gate.mjs';
import { frameUntrustedJobText } from '../security/job-document.mjs';
import {
  buildScoringPrompt,
  parseScoringResponse,
  renderEvaluationReport,
} from './scoring-contract.mjs';
import { saveEvaluation } from './save-evaluation.mjs';
import { isLoopbackModelUrl, requestModelJson } from '../security/model-http.mjs';

const tracker = new TokenAccumulator();
tracker.recordZeroToken('scan');
tracker.recordZeroToken('pdf payload');

try {
  const { config } = await import('dotenv');
  config();
} catch { /* dotenv optional */ }

import { ROOT } from '#paths';
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const PATHS = {
  cv:      join(ROOT, 'workspace/profile/cv.md'),
  profileYml: join(ROOT, 'workspace', 'profile', 'profile.yml'),
  profileMode: join(ROOT, 'workspace', 'profile', 'targeting.md'),
  articleDigest: join(ROOT, 'workspace/profile/article-digest.md'),
  customRules: join(ROOT, 'workspace', 'profile', 'preferences.md'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           frontrunner — Ollama Evaluator (local / free)          ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using a local Ollama model instead of Claude.

  USAGE
    node src/evaluate/ollama-eval.mjs "<JD text>"
    node src/evaluate/ollama-eval.mjs --file ./workspace/jobs/descriptions/my-job.txt
    node src/evaluate/ollama-eval.mjs --model qwen2.5:72b "<JD text>"

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Ollama model to use (default: llama3.3)
    --url <url>      Ollama base URL (default: http://localhost:11434)
    --no-save        Do not save report to workspace/reports/evaluations/ directory
    --help           Show this help

  SETUP
    1. Install Ollama:  https://ollama.com
    2. Pull a model:    ollama pull llama3.3
    3. Start server:    ollama serve   (or it auto-starts)
    4. Run this script

  EXAMPLES
    node src/evaluate/ollama-eval.mjs "We are looking for a Senior AI Engineer..."
    node src/evaluate/ollama-eval.mjs --file ./workspace/jobs/descriptions/openai-swe.txt
    OLLAMA_MODEL=mistral-nemo node src/evaluate/ollama-eval.mjs --file ./workspace/jobs/descriptions/job.txt
`);
  process.exit(0);
}

// Parse flags
let jdText    = '';
let modelName = process.env.OLLAMA_MODEL || 'llama3.3';
let baseUrl   = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
let saveReport = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    try {
      jdText = readFileSync(filePath, 'utf-8').trim();
    } catch (err) {
      console.error(`❌  Could not read file: ${filePath}`);
      console.error(`    ${err.message}`);
      process.exit(1);
    }
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--url' && args[i + 1]) {
    baseUrl = args[++i].replace(/\/$/, '');
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

const gate = evaluateDeterministicGate({ jdText });
if (!gate.allowed) {
  console.log(`\n⏭️  ${formatGateRejection(gate)}`);
  console.log(JSON.stringify(gate, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
/**
 * Read a file and return its trimmed contents, or a placeholder if missing.
 * Emits a console warning when the file is absent so the user knows context is incomplete.
 * @param {string} path - Absolute path to the file.
 * @param {string} label - Human-readable label used in the warning and placeholder.
 * @returns {string} File contents or a "[label not found]" placeholder.
 */
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

// ---------------------------------------------------------------------------
// Loopback guard — workspace/profile/cv.md + full JD are sent to this endpoint.
// A remote URL would silently exfiltrate private data.
// ---------------------------------------------------------------------------
{
  try {
    new URL(baseUrl);
  } catch {
    console.error(`❌  Invalid OLLAMA_BASE_URL: "${baseUrl}"`);
    process.exit(1);
  }
  const isLoopback = isLoopbackModelUrl(baseUrl);
  if (!isLoopback && process.env.OLLAMA_ALLOW_REMOTE !== '1') {
    console.error(`
❌  Remote Ollama endpoint detected: ${baseUrl}

   Your CV and job description would be sent to a remote server.
   This tool is designed for local use only.

   If you intentionally want to use a remote endpoint (e.g. tunnelled
   Ollama on a home server), set:
     OLLAMA_ALLOW_REMOTE=1 node src/evaluate/ollama-eval.mjs ...
`);
    process.exit(1);
  }
  if (!isLoopback && new URL(baseUrl).protocol !== 'https:') {
    console.error(`❌  Remote Ollama endpoints must use HTTPS: ${baseUrl}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Check Ollama is reachable before burning time on prompt assembly
// ---------------------------------------------------------------------------
try {
  await requestModelJson(`${baseUrl}/api/tags`, {
    timeoutMs: 5_000,
    maxResponseBytes: 2 * 1024 * 1024,
  });
} catch (err) {
  console.error(`
❌  Ollama not reachable at ${baseUrl}

   1. Install Ollama: https://ollama.com
   2. Start server:   ollama serve
   3. Pull a model:   ollama pull ${modelName}
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const cvContent     = readFile(PATHS.cv,     'workspace/profile/cv.md');
const profileYml    = readFile(PATHS.profileYml, 'workspace/profile/profile.yml');
const profileMode   = readFile(PATHS.profileMode, 'workspace/profile/targeting.md');
const articleDigest = existsSync(PATHS.articleDigest) ? readFileSync(PATHS.articleDigest, 'utf8').trim() : '';
const customRules   = existsSync(PATHS.customRules) ? readFileSync(PATHS.customRules, 'utf8').trim() : '';
const languageInstruction = outputLanguageInstruction(parseOutputLanguage(profileYml));

// ---------------------------------------------------------------------------
// Build system prompt
// ---------------------------------------------------------------------------
const systemPrompt = buildScoringPrompt({
  cv: cvContent,
  profile: profileYml,
  profileMode,
  articleDigest,
  customRules,
  languageInstruction,
});

// ---------------------------------------------------------------------------
// Call Ollama
// ---------------------------------------------------------------------------
const endpoint = `${baseUrl}/v1/chat/completions`;
const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS || '300000', 10);
if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
  console.error(`❌  Invalid OLLAMA_TIMEOUT_MS: "${process.env.OLLAMA_TIMEOUT_MS}" — must be a positive integer (milliseconds).`);
  process.exit(1);
}

console.log(`🤖  Calling Ollama (${modelName})... this may take a minute.\n`);

let evaluationText;
let scoring;
try {
  const data = await requestModelJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:    modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: jobDocument.prompt },
      ],
      stream: false,
      // Ollama's /api/chat reads generation params from `options` only — a
      // top-level `temperature` is silently ignored, so the eval was running at
      // Ollama's default (0.8) instead of the intended 0.4. Keep it deterministic
      // (matching the openai/gemini engines) by putting it where Ollama reads it.
      options: { temperature: 0.2, num_ctx: 32768 },
    }),
    timeoutMs,
    maxResponseBytes: 2 * 1024 * 1024,
  });

  const rawResponse = data.choices?.[0]?.message?.content?.trim();
  const usage = normalizeOpenAIUsage(data.usage);
  tracker.record('evaluation', usage);
  if (!rawResponse) {
    console.error('❌  Ollama returned an empty response.');
    process.exit(1);
  }
  scoring = parseScoringResponse(rawResponse);
  evaluationText = renderEvaluationReport(scoring);
} catch (err) {
  if (err.name === 'TimeoutError') {
    console.error(`❌  Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    console.error(`    Try a smaller/faster model, or increase OLLAMA_TIMEOUT_MS.`);
  } else {
    console.error(`❌  Ollama API call failed: ${err.message}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log('  FRONTRUNNER EVALUATION — powered by Ollama (' + modelName + ')');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

const score = scoring.overallScore.toFixed(1);
const archetype = scoring.archetype;
const legitimacy = scoring.legitimacy.tier;

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  try {
    const artifact = await saveEvaluation(scoring, {
      tool: `Ollama (${modelName})`,
      rootDir: ROOT,
    });
    console.log(`\n✅  Report saved: workspace/reports/evaluations/${artifact.filename}`);
    console.log('📊  Tracker merged into workspace/applications/tracker.md.');
  } catch (err) {
    console.warn(`⚠️   Could not publish evaluation: ${err.message}`);
    console.warn('⚠️   Any pending publication journal will be recovered on the next evaluation.');
    process.exitCode = 1;
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');

console.log(formatBreakdown(tracker, modelName, 'ollama'));
