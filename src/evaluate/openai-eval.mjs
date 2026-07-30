#!/usr/bin/env node
/**
 * openai-eval.mjs — OpenAI-compatible Job Offer Evaluator for frontrunner
 *
 * Evaluate job offers with ANY OpenAI-compatible chat endpoint instead of Claude.
 * Works with OpenAI, OpenRouter, Together, Groq, DeepSeek, Zhipu GLM, MiniMax,
 * Fireworks, and local servers that speak the OpenAI API (LM Studio, llama.cpp,
 * vLLM, Ollama's /v1). Point it at a base URL + model + key and go.
 *
 * Uses the compact, versioned scoring contract and mandatory deterministic
 * prefilter, then renders the report in code.
 *
 * Usage:
 *   node src/evaluate/openai-eval.mjs "Paste full JD text here"
 *   node src/evaluate/openai-eval.mjs --file ./workspace/jobs/descriptions/my-job.txt
 *   node src/evaluate/openai-eval.mjs --url https://openrouter.ai/api/v1 --model meta-llama/llama-3.3-70b-instruct --file ./workspace/jobs/descriptions/job.txt
 *
 * Requires (for hosted endpoints):
 *   OPENAI_API_KEY (or --key)   — your provider key
 *   OPENAI_BASE_URL (or --url)  — the provider's OpenAI-compatible base, e.g.
 *                                 https://openrouter.ai/api/v1
 *   OPENAI_MODEL (or --model)   — the model id
 *
 * Privacy: your workspace/profile/cv.md + the full JD are sent to the configured endpoint. Pick a
 * provider you trust; for fully local/private use, run a local server and point
 * --url at http://localhost:... (or use ollama-eval.mjs).
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
import {
  emitEvaluationExecutionResult,
  evaluationExecutionResult,
} from './execution-result.mjs';
import { requestModelJson } from '../security/model-http.mjs';

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
  cv:        join(ROOT, 'workspace/profile/cv.md'),
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
║       frontrunner — OpenAI-compatible Evaluator (any endpoint)     ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer with any OpenAI-compatible chat API instead of Claude.

  USAGE
    node src/evaluate/openai-eval.mjs "<JD text>"
    node src/evaluate/openai-eval.mjs --file ./workspace/jobs/descriptions/my-job.txt
    node src/evaluate/openai-eval.mjs --url <base> --model <id> --file ./workspace/jobs/descriptions/job.txt

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <id>     Model id            (env OPENAI_MODEL, default gpt-4o-mini)
    --url <base>     OpenAI-compatible base URL, including any /v1
                     (env OPENAI_BASE_URL, default https://api.openai.com/v1)
    --key <key>      API key             (env OPENAI_API_KEY)
    --no-save        Do not save report to workspace/reports/evaluations/ directory
    --help           Show this help

  ENV
    OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_TIMEOUT_MS

  PROVIDER EXAMPLES (cheap / free-tier friendly — addresses token cost)
    OpenRouter:  --url https://openrouter.ai/api/v1   --model deepseek/deepseek-chat
    Together:    --url https://api.together.xyz/v1     --model meta-llama/Llama-3.3-70B-Instruct-Turbo
    Groq:        --url https://api.groq.com/openai/v1  --model llama-3.3-70b-versatile
    DeepSeek:    --url https://api.deepseek.com/v1     --model deepseek-chat
    Zhipu GLM:   --url https://open.bigmodel.cn/api/paas/v4  --model glm-4-flash
    LM Studio:   --url http://localhost:1234/v1        --model <loaded-model>   (no key)

  EXAMPLES
    OPENAI_API_KEY=sk-... node src/evaluate/openai-eval.mjs --file ./workspace/jobs/descriptions/job.txt
    node src/evaluate/openai-eval.mjs --url http://localhost:1234/v1 --model local "<JD text>"
`);
  process.exit(0);
}

// Parse flags
let jdText     = '';
let modelName  = process.env.OPENAI_MODEL || 'gpt-4o-mini';
let baseUrl    = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
let apiKey     = process.env.OPENAI_API_KEY || '';
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
  } else if (args[i] === '--key' && args[i + 1]) {
    apiKey = args[++i];
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
// Endpoint + security guard.
// workspace/profile/cv.md + the full JD (and the API key) are sent to this endpoint, so:
//   - Non-loopback endpoints MUST use HTTPS (never leak credentials/data in
//     cleartext); plain http is allowed only for localhost dev servers.
//   - Hosted (non-loopback) endpoints require an API key.
// ---------------------------------------------------------------------------
let endpointHost;
{
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.error(`❌  Invalid OPENAI_BASE_URL: "${baseUrl}"`);
    process.exit(1);
  }
  endpointHost = parsed.hostname;
  const isLoopback = endpointHost === 'localhost' || endpointHost === '127.0.0.1' || endpointHost === '::1';

  if (!isLoopback && parsed.protocol !== 'https:') {
    console.error(`
❌  Refusing to use a non-HTTPS remote endpoint: ${baseUrl}

   Your CV, the job description, and your API key would be sent in cleartext.
   Use an https:// endpoint, or http://localhost:... for a local server.
`);
    process.exit(1);
  }

  if (!isLoopback && !apiKey) {
    console.error(`
❌  No API key for ${endpointHost}.

   Set one and re-run:
     OPENAI_API_KEY=your_key node src/evaluate/openai-eval.mjs ...
   or pass --key <key>. (Local servers at localhost may not need one.)
`);
    process.exit(1);
  }
}

// Build the chat-completions endpoint from the base URL (which already includes
// any provider version segment, e.g. ".../v1"), matching the OpenAI SDK convention.
const endpoint = `${baseUrl}/chat/completions`;

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
/**
 * Read a file and return its trimmed contents, or a placeholder if missing.
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
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const cvContent     = readFile(PATHS.cv,         'workspace/profile/cv.md');
const profileYml    = readFile(PATHS.profileYml, 'workspace/profile/profile.yml');
const profileMode   = readFile(PATHS.profileMode, 'workspace/profile/targeting.md');
const articleDigest = existsSync(PATHS.articleDigest) ? readFileSync(PATHS.articleDigest, 'utf8').trim() : '';
const customRules   = existsSync(PATHS.customRules) ? readFileSync(PATHS.customRules, 'utf8').trim() : '';
const languageInstruction = outputLanguageInstruction(parseOutputLanguage(profileYml));

// ---------------------------------------------------------------------------
// Mandatory zero-token gate. Nothing below this point may contact a model
// provider unless the deterministic classifier explicitly kept the role.
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
  profileMode,
  articleDigest,
  customRules,
  languageInstruction,
});
console.log(`📊  Compact scoring contract: ~${Math.ceil(systemPrompt.length / 4).toLocaleString()} static tokens`);

// ---------------------------------------------------------------------------
// Prompt caching (#1709) — engine 2 of the four from #1709, same shape as the
// OpenRouter runner. The large static prefix (shared + oferta + cv) is
// byte-identical across every offer, yet was re-sent and re-billed each call.
//
// Host-gated on purpose: OpenAI-compatible gateways (OpenRouter, DeepSeek, …)
// honor an ephemeral `cache_control` breakpoint on the prefix and reuse it
// across back-to-back calls within the cache TTL. api.openai.com instead caches
// long prefixes automatically and may reject the non-standard field, so it gets
// a plain-string system message. Either way the prompt TEXT is unchanged.
export function buildSystemMessage(prompt, host) {
  if (host === 'api.openai.com') return { role: 'system', content: prompt };
  return {
    role: 'system',
    content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
  };
}

// ---------------------------------------------------------------------------
// Call the OpenAI-compatible endpoint
// ---------------------------------------------------------------------------
const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || '300000', 10);
if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
  console.error(`❌  Invalid OPENAI_TIMEOUT_MS: "${process.env.OPENAI_TIMEOUT_MS}" — must be a positive integer (milliseconds).`);
  process.exit(1);
}

console.log(`\n🔒  Privacy: your workspace/profile/cv.md + JD will be sent to ${endpointHost}.`);
console.log(`🤖  Calling ${modelName} via ${endpointHost}... this may take a minute.\n`);

const headers = { 'Content-Type': 'application/json' };
if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

let evaluationText;
let scoring;
let evaluationUsage;
try {
  const data = await requestModelJson(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model:    modelName,
      messages: [
        buildSystemMessage(systemPrompt, endpointHost),
        { role: 'user', content: jobDocument.prompt },
      ],
      stream:      false,
      temperature: 0.2,
    }),
    timeoutMs,
    maxResponseBytes: 2 * 1024 * 1024,
  });

  const rawResponse = data.choices?.[0]?.message?.content?.trim();
  const usage = normalizeOpenAIUsage(data.usage);
  evaluationUsage = usage;
  tracker.record('evaluation', usage);
  if (!rawResponse) {
    console.error('❌  The endpoint returned an empty response.');
    process.exit(1);
  }
  scoring = parseScoringResponse(rawResponse);
  evaluationText = renderEvaluationReport(scoring);
} catch (err) {
  if (err.name === 'TimeoutError') {
    console.error(`❌  Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    console.error(`    Try a smaller/faster model, or increase OPENAI_TIMEOUT_MS.`);
  } else {
    console.error(`❌  API call failed: ${err.message}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log('  FRONTRUNNER EVALUATION — powered by ' + modelName + ' (' + endpointHost + ')');
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
      tool: `OpenAI-compatible (${modelName} @ ${endpointHost})`,
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

console.log(formatBreakdown(tracker, modelName, 'openai'));
emitEvaluationExecutionResult(evaluationExecutionResult({
  status: 'succeeded',
  usage: evaluationUsage,
}));
