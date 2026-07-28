#!/usr/bin/env node
/**
 * career-ops OpenRouter Runner
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
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
import yaml from 'js-yaml';
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import {
  formatReportNumber, releaseReportNumbers, reserveReportNumbers,
} from '../tracker/reserve-report-num.mjs';
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
const OPENROUTER_API_URL    = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
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
  try {
    const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveBlacklist(set) {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...set], null, 2), 'utf-8');
  } catch {}
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
    const resp = await fetch(OPENROUTER_MODELS_URL, {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // A model is free when its prompt and completion pricing are both "0"
    const list = (data.data ?? [])
      .filter(m => {
        const p = m.pricing ?? {};
        return String(p.prompt) === '0' && String(p.completion) === '0';
      })
      .map(m => m.id);

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

function writeFile(relPath, content) {
  const full = path.join(__dirname, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
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

  const pinnedModel = process.env.CAREER_OPS_MODEL;
  if (pinnedModel) {
    activeModel = pinnedModel;
    process.stdout.write(`[model] ${pinnedModel} (pinned) ... `);
    const body = JSON.stringify({
      model: pinnedModel,
      messages: [
        buildCachedSystemMessage(systemPrompt),
        { role: 'user', content: userMessage },
      ],
      max_tokens: MAX_TOKENS,
    });
    const ctrl = new AbortController();
    const timerId = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
    try {
      const resp = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://github.com/santifer/career-ops',
          'X-Title':       'career-ops',
        },
        body,
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t.slice(0, 120)}`);
      }
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);
      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('Empty response');
      console.log('OK');
      const usage = normalizeOpenAIUsage(data.usage);
      return { content, usage };
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Pinned model timed out after ${MODEL_TIMEOUT_MS / 1000}s`);
      throw e;
    } finally {
      clearTimeout(timerId);
    }
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
      const body = JSON.stringify({
        model,
        messages: [
          buildCachedSystemMessage(systemPrompt),
          { role: 'user', content: userMessage },
        ],
        max_tokens: MAX_TOKENS,
      });

      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
      let data;
      try {
        const resp = await fetch(OPENROUTER_API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type':  'application/json',
            'HTTP-Referer':  'https://github.com/santifer/career-ops',
            'X-Title':       'career-ops',
          },
          body,
          signal: controller.signal,
        });
        if (!resp.ok) {
          const t = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${t.slice(0, 120)}`);
        }
        data = await resp.json();
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Timeout after ${MODEL_TIMEOUT_MS / 1000}s`);
        throw e;
      } finally {
        clearTimeout(timerId);
      }
      if (data.error) throw new Error(data.error.message);

      const content = data.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('Empty response');

      const usage = normalizeOpenAIUsage(data.usage);

      modelIndex = (modelIndex + attempt + 1) % active.length;
      console.log('OK');
      return { content, usage };

    } catch (e) {
      lastError = e;
      const msg = e.message.split('\n')[0];

          const is403     = msg.includes('HTTP 403');
      const isTimeout = msg.startsWith('Timeout');
      const is429     = msg.includes('HTTP 429') || msg.includes('rate-li') || msg.includes('rate limit') || msg.includes('temporarily rate');
      if (is403 || isTimeout) {
        blacklistedModels.add(model);
        saveBlacklist(blacklistedModels);
        console.log(`SKIP (blacklisted: ${msg})`);
      } else if (is429) {
        rateLimitCounts[model] = (rateLimitCounts[model] ?? 0) + 1;
        if (rateLimitCounts[model] >= 3) {
          blacklistedModels.add(model);
          saveBlacklist(blacklistedModels);
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

// ---------------------------------------------------------------------------
// Job page content fetcher (Playwright-first, plain fetch fallback)
// ---------------------------------------------------------------------------
// Reject unsafe fetch targets (SSRF defense-in-depth): http(s) only, never
// loopback / link-local / private / cloud-metadata hosts. URLs come from the
// user's own portals.yml / pipeline.md, but we still fail closed.
function assertSafeRemoteUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Refusing non-HTTP(S) URL: ${url}`);
  }
  const host = u.hostname.toLowerCase();
  const blocked = host === 'localhost' || host === '::1' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new Error(`Refusing private/loopback host: ${host}`);
  return u;
}

async function fetchJobPage(url) {
  assertSafeRemoteUrl(url);
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn('[fetch] Playwright unavailable — falling back to plain fetch.');
  }

  if (chromium) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2000); // wait for SPA render
      const text = await page.evaluate(() => {
        document.querySelectorAll('script,style,nav,footer,header').forEach(el => el.remove());
        return (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      });
      return text.slice(0, 16_000);
    } catch (e) {
      console.warn(`[fetch] Playwright error: ${e.message} — falling back to plain fetch.`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  // Plain HTTP fallback
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const html = await r.text();
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16_000);
  } catch (e) {
    throw new Error(`Could not fetch job page: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// portals.yml parser — reads the canonical schema with js-yaml (same library and
// field names as src/scan/scan.mjs: `title_filter.positive/negative` + `tracked_companies`),
// so it never drifts from the main scanner. The runner's no-CLI scan path covers
// companies that expose a direct JSON `api:`; careers_url-only / Playwright /
// search-query companies are handled by the full /career-ops scan pipeline.
// `rawOverride` lets tests feed YAML text directly (see test-all.mjs drift guard).
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

function addToPipeline(entries) {
  const history = readFile('data/scan-history.tsv') ?? 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n';
  const seenUrls = new Set(history.split('\n').slice(1).map(l => l.split('\t')[0]).filter(Boolean));

  const existingPipeline = readFile('data/pipeline.md') ?? '# Pipeline\n\n## Pending\n';
  const existingApps     = readFile('data/applications.md') ?? '';
  // extract URLs already tracked in applications.md (mirrors src/scan/scan.mjs dedup logic)
  const appliedUrls = new Set(
    existingApps.split('\n')
      .map(l => l.match(/https?:\/\/[^\s|)]+/))
      .filter(Boolean).map(m => m[0])
  );

  const newEntries = entries.filter(e => {
    if (seenUrls.has(e.url)) return false;
    if (appliedUrls.has(e.url)) return false;
    // skip if already queued in pipeline
    if (existingPipeline.includes(e.url)) return false;
    return true;
  });

  if (newEntries.length === 0) return 0;

  const today = new Date().toISOString().split('T')[0];
  let pipeline = existingPipeline;
  let hist = history;

  for (const e of newEntries) {
    pipeline += `- [ ] ${e.url} | ${e.company} | ${e.role}\n`;
    hist     += `${e.url}\t${today}\tscan\t${e.role}\t${e.company}\tadded\t${e.location ?? ''}\n`;
  }

  writeFile('data/pipeline.md', pipeline);
  writeFile('data/scan-history.tsv', hist);
  return newEntries.length;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// -- SCAN --
async function cmdScan() {
  tracker.recordZeroToken('scan');
  tracker.recordZeroToken('evaluation');
  tracker.recordZeroToken('pdf payload');
  execFileSync(process.execPath, [path.join(__dirname, 'src/scan/scan.mjs')], {
    cwd: __dirname,
    stdio: 'inherit',
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
      return 'skipped:expired';
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

  const gate = evaluateDeterministicGate({ jdText });
  if (!gate.allowed) {
    console.log(`\n⏭️  ${formatGateRejection(gate)}`);
    return `skipped:${gate.rule}`;
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
    resultObj = await callOpenRouter(systemPrompt, `Evaluate this job listing:\n\n${jdText}`);
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

  let reservedNumbers;
  try {
    reservedNumbers = await reserveReportNumbers(1, {
      rootDir: __dirname,
      reportsDir: path.join(__dirname, 'reports'),
    });
  } catch (e) {
    console.error(`Could not reserve a report number: ${e.message}`);
    return null;
  }

  try {
    // Save report
    const today   = new Date().toISOString().split('T')[0];
    const num     = reservedNumbers[0];
    const slug    = String(scoring.company).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
    const numStr  = formatReportNumber(num);
    const relPath = `reports/${numStr}-${slug}-${today}.md`;
    const sourceUrl = jdText.match(/^\s*(?:\*\*)?URL:(?:\*\*)?\s*(https?:\/\/\S+)/mi)?.[1]
      ?? (typeof input === 'string' && /^https?:\/\//.test(input) ? input : '(pasted/cached)');

    // Extract Legitimacy from LLM output or fall back to placeholder
    const legitMatch = result.match(/\*\*Legitimacy:\*\*\s*([^\n]+)/);
    const legitLine  = legitMatch ? `**Legitimacy:** ${legitMatch[1].trim()}` : '**Legitimacy:** unconfirmed';
    writeFile(relPath, `# Evaluation: ${scoring.company} — ${scoring.role}\n\n**URL:** ${sourceUrl}\n**Score:** ${scoring.overallScore.toFixed(1)}/5\n${legitLine}\n\n${result}`);

    const scoreStr    = `${scoring.overallScore.toFixed(1)}/5`;
    const companyName = scoring.company;
    const reportLink  = `[${numStr}](reports/${numStr}-${slug}-${today}.md)`;
    const tsvSafe = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
    const tsvLine     = `${num}\t${today}\t${tsvSafe(companyName)}\t${tsvSafe(scoring.role)}\tEvaluated\t${scoreStr}\t❌\t${reportLink}\t\n`;
    const tsvFile     = `batch/tracker-additions/or-${numStr}-${slug}.tsv`;
    writeFile(tsvFile, `num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\n${tsvLine}`);
    const mergeOutput = execFileSync(process.execPath, [path.join(__dirname, 'src/tracker/merge-tracker.mjs')], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (mergeOutput.trim()) console.log(mergeOutput.trim());

    console.log(`\n✅ Report saved: ${relPath}`);
    console.log('📊 Tracker merged into data/applications.md.');
    console.log('\n─── EVALUATION ──────────────────────────────────────\n');
    console.log(result);
    console.log('\n─────────────────────────────────────────────────────\n');

    return relPath;
  } finally {
    try {
      await releaseReportNumbers(reservedNumbers, { reportsDir: path.join(__dirname, 'reports') });
    } catch (e) {
      console.warn(`Could not release report reservation: ${e.message}`);
    }
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

// Load free models list before running any AI command (skip when a model is pinned)
if (invokedDirectly && ['evaluate', 'eval', 'apply', 'models'].includes(command) && !process.env.CAREER_OPS_MODEL) {
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
    await cmdEvaluate(input, ctx);
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
career-ops OpenRouter Runner
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
  - Pin a model:  CAREER_OPS_MODEL=deepseek/deepseek-r1:free node src/evaluate/openrouter-runner.mjs eval <url>
`);
}

if (invokedDirectly && ['scan', 'evaluate', 'eval', 'pipeline', 'apply'].includes(command)) {
  const modelName = process.env.CAREER_OPS_MODEL || activeModel || 'free-rotation';
  console.log('\n' + formatBreakdown(tracker, modelName, 'openrouter'));
}
