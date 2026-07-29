#!/usr/bin/env node
/**
 * frontrunner OpenRouter Runner
 * No Claude Code CLI required — uses OpenRouter free models with automatic fallback.
 *
 * Usage:
 *   node src/evaluate/openrouter-runner.mjs scan              → Scan Greenhouse API companies for new listings
 *   node src/evaluate/openrouter-runner.mjs evaluate <url>    → Evaluate a job by URL
 *   node src/evaluate/openrouter-runner.mjs evaluate          → Paste job text interactively
 *   node src/evaluate/openrouter-runner.mjs pipeline          → Canonical pipeline with OpenRouter evaluation
 *   node src/evaluate/openrouter-runner.mjs apply <report_no> → Generate draft application form answers
 *   node src/evaluate/openrouter-runner.mjs models            → List available free models
 *   node src/evaluate/openrouter-runner.mjs help              → Show this help
 *
 * Setup:
 *   1. copy .env.example .env
 *   2. Add OPENROUTER_API_KEY=sk-or-v1-... to .env
 *   3. Free API key: https://openrouter.ai
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import yaml from 'js-yaml';
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import { TokenAccumulator, formatBreakdown, normalizeOpenAIUsage } from '../lib/token-tracker.mjs';
import { readJdManifest } from '../scan/jd-cache.mjs';
import { fetchJobDescriptionViaApi } from '../scan/fetch-jds.mjs';
import { createLivenessChecker } from '../scan/liveness-service.mjs';
import { evaluateDeterministicGate, formatGateRejection } from './evaluation-gate.mjs';
import {
  buildScoringPrompt,
  parseScoringResponse,
  renderEvaluationReport,
} from './scoring-contract.mjs';
import { frameUntrustedJobText } from '../security/job-document.mjs';
import { runCheckedSubprocess } from '../security/subprocess.mjs';
import {
  fetchOpenRouterModels,
  requestOpenRouterCompletion,
} from './openrouter-client.mjs';
import {
  addModelsToBlacklist,
  readModelBlacklist,
} from './model-blacklist.mjs';
import { saveEvaluation } from './save-evaluation.mjs';
import {
  emitEvaluationExecutionResult,
  evaluationExecutionResult,
} from './execution-result.mjs';

import { ROOT as __dirname } from '#paths';
const tracker = new TokenAccumulator();
let activeModel = null;

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^(['"])(.*?)\1$/, '$2');
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_TOKENS            = 8192;
const MODEL_TIMEOUT_MS      = 15_000; // abort a single model call after 15 s

// Provider priority order — models are sorted by provider prefix, not hardcoded names.
// Add, remove, or reorder providers here; model names are resolved at runtime from the API.
const PROVIDER_PRIORITY = [
  'google',
  'qwen',
  'openai',
  'meta-llama',
  'nvidia',
  'mistralai',
  'nousresearch',
  'minimax',
  'arcee-ai',
  // any unlisted provider goes last (alphabetical)
];

// In-memory model list — populated on first callOpenRouter()
let freeModels = null;   // string[]
let modelIndex = 0;      // current position in rotation

// Persistent blacklist file — survives process restarts
const BLACKLIST_FILE = path.join(__dirname, 'data', 'model-blacklist.json');
function loadPersistedBlacklist() {
  return [...readModelBlacklist(BLACKLIST_FILE)];
}
async function saveBlacklist(set) {
  const persisted = await addModelsToBlacklist(BLACKLIST_FILE, set);
  for (const model of persisted) blacklistedModels.add(model);
}

// Models that failed permanently (403, timeout, persistent 429) — never retry
const blacklistedModels = new Set(loadPersistedBlacklist());
if (blacklistedModels.size > 0) {
  console.log(`[blacklist] Loaded ${blacklistedModels.size} pre-blacklisted model(s) from disk.`);
}
// 429 failure count per model — auto-blacklist after 3 consecutive 429s
const rateLimitCounts = {};

// ---------------------------------------------------------------------------
// Fetch free models from OpenRouter API
// ---------------------------------------------------------------------------
async function loadFreeModels() {
  if (freeModels !== null) return freeModels;

  try {
    const list = await fetchOpenRouterModels({
      apiKey: process.env.OPENROUTER_API_KEY,
      timeoutMs: MODEL_TIMEOUT_MS,
    });

    if (list.length === 0) throw new Error('No free models found in API response');

    // Sort by provider priority; within the same provider sort alphabetically
    function providerOf(id) { return id.split('/')[0]; }
    function priorityOf(id) {
      const idx = PROVIDER_PRIORITY.indexOf(providerOf(id));
      return idx === -1 ? PROVIDER_PRIORITY.length : idx;
    }

    freeModels = list.sort((a, b) => {
      const diff = priorityOf(a) - priorityOf(b);
      return diff !== 0 ? diff : a.localeCompare(b);
    });

    console.log(`[models] ${freeModels.length} free models loaded from OpenRouter API.`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const hasKey = Boolean(process.env.OPENROUTER_API_KEY);
    throw new Error(
      `[models] Failed to fetch free model list: ${reason}. ` +
      (hasKey ? 'Check that your API key is valid and that network access to OpenRouter is available.'
               : 'OPENROUTER_API_KEY is not set — copy .env.example to .env and add your key.')
    );
  }

  return freeModels;
}

// List and exit (helper command)
async function cmdModels() {
  const models = await loadFreeModels();
  console.log(`\nFree models available on OpenRouter (${models.length} total):\n`);
  models.forEach((id, i) => console.log(`  ${String(i + 1).padStart(2)}. ${id}`));
  console.log('');
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readFile(relPath) {
  try { return fs.readFileSync(path.join(__dirname, relPath), 'utf-8'); }
  catch { return null; }
}

function fileExists(relPath) {
  return fs.existsSync(path.join(__dirname, relPath));
}

export function cachedJdForUrl(url, { outDir = path.join(__dirname, 'jds') } = {}) {
  const file = readJdManifest(outDir).get(url);
  if (!file) return null;
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt caching (#1709)
// ---------------------------------------------------------------------------
// The large static system prefix (shared + profile + mode + cv) is
// byte-identical across every offer in a run, yet it was re-sent and re-billed
// on each call. Send it as a structured content block with an ephemeral
// `cache_control` breakpoint — OpenRouter's documented prompt-caching mechanism.
// Providers that support caching (Anthropic, Gemini, …) reuse the prefix across
// back-to-back calls within the cache TTL; providers that don't simply ignore
// the field, so this is a safe passthrough that never changes the prompt text.
export function buildCachedSystemMessage(systemPrompt) {
  return {
    role: 'system',
    content: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
  };
}

// ---------------------------------------------------------------------------
// OpenRouter API call — automatic model rotation with fallback
// ---------------------------------------------------------------------------
async function callOpenRouter(systemPrompt, userMessage) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      'OPENROUTER_API_KEY not found.\n' +
      'Copy .env.example to .env and add your API key.\n' +
      'Free key: https://openrouter.ai'
    );
  }

  const pinnedModel = process.env.FRONTRUNNER_MODEL;
  if (pinnedModel) {
    activeModel = pinnedModel;
    process.stdout.write(`[model] ${pinnedModel} (pinned) ... `);
    const result = await requestOpenRouterCompletion({
      apiKey: key,
      model: pinnedModel,
      systemMessage: buildCachedSystemMessage(systemPrompt),
      userMessage,
      maxTokens: MAX_TOKENS,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
    console.log('OK');
    return {
      content: result.content,
      usage: normalizeOpenAIUsage(result.usage),
      requestCount: 1,
    };
  }

  const models = await loadFreeModels();
  let lastError;

  if (models.length === 0) {
    throw new Error(
      'No free OpenRouter models are available. Model loading may have failed, or your account currently has no free models.'
    );
  }
  // Build the active (non-blacklisted) model list in rotation order
  const active = models.filter(m => !blacklistedModels.has(m));
  if (active.length === 0) throw new Error('All loaded models have been blacklisted this session.');

  for (let attempt = 0; attempt < active.length; attempt++) {
    const model = active[(modelIndex % active.length + attempt) % active.length];
    activeModel = model;
    process.stdout.write(`[model] ${model} ... `);

    try {
      const data = await requestOpenRouterCompletion({
        apiKey: key,
        model,
        systemMessage: buildCachedSystemMessage(systemPrompt),
        userMessage,
        maxTokens: MAX_TOKENS,
        timeoutMs: MODEL_TIMEOUT_MS,
      });

      modelIndex = (modelIndex + attempt + 1) % active.length;
      console.log('OK');
      return {
        content: data.content,
        usage: normalizeOpenAIUsage(data.usage),
        requestCount: attempt + 1,
      };

    } catch (e) {
      lastError = e;
      const msg = e.message.split('\n')[0];

      const is403 = msg.includes('HTTP 403');
      const isTimeout = msg.startsWith('Timeout');
      const is429     = msg.includes('HTTP 429') || msg.includes('rate-li') || msg.includes('rate limit') || msg.includes('temporarily rate');
      if (is403 || isTimeout) {
        blacklistedModels.add(model);
        await saveBlacklist(blacklistedModels);
        console.log(`SKIP (blacklisted: ${msg})`);
      } else if (is429) {
        rateLimitCounts[model] = (rateLimitCounts[model] ?? 0) + 1;
        if (rateLimitCounts[model] >= 3) {
          blacklistedModels.add(model);
          await saveBlacklist(blacklistedModels);
          console.log(`SKIP (auto-blacklisted: persistent 429)`);
        } else {
          console.log(`FAILED (HTTP 429 [${rateLimitCounts[model]}/3])`);
          await new Promise(r => setTimeout(r, 800));
        }
      } else {
        console.log(`FAILED (${msg})`);
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  throw new Error(`All ${active.length} active models failed. Last error: ${lastError?.message}`);
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------
function loadContext() {
  return {
    cv:          readFile('cv.md')               ?? 'CV not found.',
    profile:     readFile('config/profile.yml')  ?? '',
    shared:      readFile('modes/_shared.md')    ?? '',
    profileMode: readFile('modes/_profile.md')   ?? '',
    articleDigest: readFile('article-digest.md') ?? '',
    customRules: readFile('modes/_custom.md')    ?? '',
  };
}

export function buildSystemPrompt(modeContent, ctx) {
  const languageInstruction = outputLanguageInstruction(parseOutputLanguage(ctx.profile));
  return [
    ctx.shared,
    ctx.profileMode,
    modeContent,
    '---',
    'CANDIDATE PROFILE (YAML):',
    ctx.profile,
    '---',
    'CV (Markdown):',
    ctx.cv,
    '---',
    'OUTPUT LANGUAGE:',
    languageInstruction,
  ].filter(Boolean).join('\n\n');
}

// Browser fallback uses the canonical liveness service so redirects, DNS and
// every subresource inherit the same remote-target policy as the scanner.
async function fetchJobPage(url) {
  const checker = createLivenessChecker();
  try {
    const extracted = await checker.extract(url);
    if (!extracted?.text) throw new Error('no readable job description');
    return extracted.text;
  } finally {
    await checker.close();
  }
}

// ---------------------------------------------------------------------------
// Compatibility-only portals parser retained for older callers. The runner's
// scan command always executes src/scan/scan.mjs and never publishes state.
// ---------------------------------------------------------------------------
function normKeywords(v) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x ?? '').toLowerCase().trim()).filter(Boolean);
}

export function parsePortals(rawOverride) {
  const raw = rawOverride ?? readFile('portals.yml');
  if (!raw) throw new Error('portals.yml not found');
  const config = yaml.load(raw) || {};

  const tf = config.title_filter || {};
  const positive = normKeywords(tf.positive);
  const negative = normKeywords(tf.negative);
  function titleMatches(title) {
    const t = String(title ?? '').toLowerCase();
    return positive.some(k => t.includes(k)) && !negative.some(k => t.includes(k));
  }

  // Companies with a direct JSON `api:` endpoint (the no-CLI scan path).
  const tracked = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const companies = tracked
    .filter(c => c && c.api && c.enabled !== false)
    .map(c => ({ name: String(c.name ?? c.company ?? 'Unknown'), api: String(c.api).trim() }));

  return { companies, titleMatches };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// -- SCAN --
async function cmdScan() {
  tracker.recordZeroToken('scan');
  tracker.recordZeroToken('evaluation');
  tracker.recordZeroToken('pdf payload');
  await runCheckedSubprocess(process.execPath, [path.join(__dirname, 'src/scan/scan.mjs')], {
    cwd: __dirname,
    timeoutMs: 10 * 60 * 1000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    onStdout: chunk => process.stdout.write(chunk),
    onStderr: chunk => process.stderr.write(chunk),
  });
}

// -- EVALUATE --
async function cmdEvaluate(input, ctx) {
  tracker.recordZeroToken('scan');
  tracker.recordZeroToken('pdf payload');
  const modeContent = readFile('modes/oferta.md') ?? readFile('modes/auto-pipeline.md') ?? '';

  let jdText = input;

  if (!input) {
    // Interactive paste mode
    console.log('Paste job description or URL, then press Enter on an empty line:\n');
    const rl = readline.createInterface({ input: process.stdin });
    const lines = [];
    try {
      for await (const line of rl) {
        if (line === '') break;
        lines.push(line);
      }
    } finally {
      rl.close();
    }
    jdText = lines.join('\n');
    if (!jdText.trim()) { console.log('No input provided.'); return null; }
  } else if (input.startsWith('http')) {
    const liveness = createLivenessChecker();
    let live;
    try {
      live = await liveness.check(input);
    } finally {
      await liveness.close();
    }
    if (live.result === 'expired') {
      console.log(`⏭️  Evaluation stopped before the model call: posting is expired (${live.reason}).`);
      return { status: 'skipped' };
    }
    if (live.result === 'uncertain') {
      console.warn(`⚠️  Liveness uncertain (${live.reason}); keeping the role to avoid a false reject.`);
    }

    const cached = cachedJdForUrl(input);
    if (cached) {
      console.log('Using cached job description...');
      jdText = cached;
    } else {
      console.log('Fetching job description...');
      try {
        let apiDescription = null;
        try {
          apiDescription = await fetchJobDescriptionViaApi(input);
        } catch (e) {
          console.warn(`Provider API failed (${e.message}); using browser fallback.`);
        }
        if (apiDescription) {
          console.log(`Using ${apiDescription.provider} API description (no browser).`);
          jdText = apiDescription.text;
        } else {
          console.log('Provider API unavailable; using browser fallback...');
          const content = await fetchJobPage(input);
          jdText = `URL: ${input}\n\n${content}`;
        }
      } catch (e) {
        console.error(e.message);
        return null;
      }
    }
  }

  const jobDocument = frameUntrustedJobText(jdText);
  jdText = jobDocument.text;
  if (jobDocument.suspiciousSignals.length) {
    console.warn(`Job text contains ${jobDocument.suspiciousSignals.length} instruction-like signal(s); treating all text as data.`);
  }
  const gate = evaluateDeterministicGate({ jdText });
  if (!gate.allowed) {
    console.log(`\n⏭️  ${formatGateRejection(gate)}`);
    return { status: 'skipped' };
  }

  console.log('\nEvaluating...');
  const languageInstruction = outputLanguageInstruction(parseOutputLanguage(ctx.profile));
  const systemPrompt = buildScoringPrompt({
    cv: ctx.cv,
    profile: ctx.profile,
    profileMode: ctx.profileMode,
    articleDigest: ctx.articleDigest,
    customRules: ctx.customRules,
    languageInstruction,
  });

  let resultObj;
  try {
    resultObj = await callOpenRouter(systemPrompt, jobDocument.prompt);
  } catch (e) {
    console.error(`OpenRouter error: ${e.message}`);
    return null;
  }
  tracker.record('evaluation', resultObj.usage);
  let result;
  let scoring;
  try {
    scoring = parseScoringResponse(resultObj.content);
    result = renderEvaluationReport(scoring);
  } catch (e) {
    console.error(`OpenRouter returned invalid scoring JSON: ${e.message}`);
    return null;
  }

  try {
    const sourceUrl = jdText.match(/^\s*(?:\*\*)?URL:(?:\*\*)?\s*(https?:\/\/\S+)/mi)?.[1]
      ?? (typeof input === 'string' && /^https?:\/\//.test(input) ? input : '(pasted/cached)');
    const artifact = await saveEvaluation(scoring, {
      tool: `OpenRouter (${activeModel ?? 'automatic fallback'})`,
      sourceUrl,
      rootDir: __dirname,
    });
    const relPath = `reports/${artifact.filename}`;

    console.log(`\n✅ Report saved: ${relPath}`);
    console.log('📊 Tracker merged into data/applications.md.');
    console.log('\n─── EVALUATION ──────────────────────────────────────\n');
    console.log(result);
    console.log('\n─────────────────────────────────────────────────────\n');

    return {
      status: 'succeeded',
      usage: resultObj.usage,
      requestCount: resultObj.requestCount,
    };
  } catch (e) {
    console.error(`Could not publish evaluation: ${e.message}`);
    console.error('Any pending publication journal will be recovered on the next evaluation.');
    return null;
  }
}

// -- PIPELINE --
async function cmdPipeline() {
  const { runCanonicalPipeline } = await import('../pipeline/run.mjs');
  const result = await runCanonicalPipeline({ engine: 'openrouter' });
  console.log('\n✅ Canonical OpenRouter pipeline complete.');
  console.log(`   ${result.inputRoles} roles → ${result.prefilter.kept} model-eligible.`);
}

// -- APPLY --
async function cmdApply(ref, ctx) {
  tracker.recordZeroToken('scan');
  tracker.recordZeroToken('evaluation');
  tracker.recordZeroToken('pdf payload');
  const modeContent = readFile('modes/apply.md') ?? '';

  let reportContent;
  if (fileExists(ref)) {
    reportContent = readFile(ref);
  } else {
    const numStr = String(ref).padStart(3, '0');
    const reportsDir = path.join(__dirname, 'reports');
    const dirEntries = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [];
    const matches = dirEntries.filter(f => f.startsWith(numStr));
    if (matches.length === 0) {
      console.error(`Report not found: ${ref}`);
      return;
    }
    reportContent = readFile(`reports/${matches[0]}`);
  }

  if (!reportContent) { console.error('Could not read report content.'); return; }

  // Score-gate: warn and confirm before applying to low-fit roles (AGENTS.md Ethical Use)
  const scoreMatch = reportContent.match(/^\s*\*?\*?\s*(?:score|puntuaci[oó]n)\s*:\s*\*?\*?\s*(\d+(?:\.\d+)?)\s*\/\s*5/im);
  const scoreValue = scoreMatch ? parseFloat(scoreMatch[1]) : NaN;
  if (isFinite(scoreValue) && scoreValue < 4.0) {
    console.log(`\n⚠️  This report scored ${scoreValue.toFixed(1)}/5 — below the 4.0/5 threshold.`);
    console.log('Strongly discourage low-fit applications. Your time and the recruiter\'s time are both valuable.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question('Proceed anyway? (yes/no): ', resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Aborted.');
      return;
    }
  }

  console.log('Generating application form answers...');
  const systemPrompt = buildSystemPrompt(modeContent, ctx);

  let resultObj;
  try {
    resultObj = await callOpenRouter(
      systemPrompt,
      `Generate application form answers based on this evaluation report:\n\n${reportContent}`
    );
  } catch (e) {
    console.error(`OpenRouter error: ${e.message}`);
    return;
  }
  tracker.record('apply', resultObj.usage);
  const result = resultObj.content;

  console.log('\n─── APPLICATION ANSWERS ─────────────────────────────\n');
  console.log(result);
  console.log('\n─────────────────────────────────────────────────────\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
// Only run the CLI when invoked directly (`node src/evaluate/openrouter-runner.mjs ...`), so the
// module can be imported (e.g. by test-all.mjs) without executing a command.
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const [,, command, ...args] = invokedDirectly ? process.argv : [];
const ctx = invokedDirectly ? loadContext() : null;
let evaluationExecution = null;

// Load free models list before running any AI command (skip when a model is pinned)
if (invokedDirectly && ['evaluate', 'eval', 'apply', 'models'].includes(command) && !process.env.FRONTRUNNER_MODEL) {
  await loadFreeModels();
}

if (invokedDirectly) switch (command) {
  case 'scan':
    await cmdScan();
    break;

  case 'evaluate':
  case 'eval': {
    let input = args.join(' ').trim() || null;
    if (args[0] === '--file') {
      if (!args[1]) {
        console.error('Usage: node src/evaluate/openrouter-runner.mjs evaluate --file <path>');
        break;
      }
      try {
        input = fs.readFileSync(path.resolve(args[1]), 'utf8').trim();
      } catch (error) {
        console.error(`Could not read JD file: ${error.message}`);
        break;
      }
    }
    evaluationExecution = await cmdEvaluate(input, ctx);
    if (!evaluationExecution) process.exitCode = 1;
    break;
  }

  case 'pipeline':
    await cmdPipeline();
    break;

  case 'apply':
    if (!args[0]) { console.error('Usage: node src/evaluate/openrouter-runner.mjs apply <report_num|report_path>'); break; }
    await cmdApply(args[0], ctx);
    break;

  case 'models':
    await cmdModels();
    break;

  default:
    console.log(`
frontrunner OpenRouter Runner
Auto-fetches free models from OpenRouter API and rotates through them with fallback.

COMMANDS:
  node src/evaluate/openrouter-runner.mjs scan              → Scan Greenhouse APIs for new matching listings
  node src/evaluate/openrouter-runner.mjs evaluate <url>    → Evaluate a listing by URL
  node src/evaluate/openrouter-runner.mjs evaluate --file <path> → Evaluate a cached JD
  node src/evaluate/openrouter-runner.mjs evaluate          → Paste a job description interactively
  node src/evaluate/openrouter-runner.mjs pipeline          → Run the canonical pipeline with OpenRouter
  node src/evaluate/openrouter-runner.mjs apply <report_no> → Generate application form answers from a report
  node src/evaluate/openrouter-runner.mjs models            → List available free models from OpenRouter

SETUP:
  1. Copy .env.example to .env
  2. Add your key: OPENROUTER_API_KEY=sk-or-v1-...
  3. Free API key: https://openrouter.ai

MODEL SELECTION:
  - Free models are fetched automatically via the OpenRouter API at runtime.
  - They are tried in sequence; if one fails the next is used automatically.
  - Pin a model:  FRONTRUNNER_MODEL=deepseek/deepseek-r1:free node src/evaluate/openrouter-runner.mjs eval <url>
`);
}

if (invokedDirectly && ['scan', 'evaluate', 'eval', 'pipeline', 'apply'].includes(command)) {
  const modelName = process.env.FRONTRUNNER_MODEL || activeModel || 'free-rotation';
  console.log('\n' + formatBreakdown(tracker, modelName, 'openrouter'));
}
if (invokedDirectly && ['evaluate', 'eval'].includes(command) && evaluationExecution) {
  emitEvaluationExecutionResult(evaluationExecutionResult(evaluationExecution));
}
