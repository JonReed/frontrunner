#!/usr/bin/env node
/**
 * gemini-eval.mjs — Gemini-powered Job Offer Evaluator for career-ops
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

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TokenAccumulator, formatBreakdown } from '../lib/token-tracker.mjs';

const tracker = new TokenAccumulator();
tracker.recordZeroToken('scan');
tracker.recordZeroToken('pdf payload');
import { execFileSync } from 'child_process';
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import {
  formatReportNumber, releaseReportNumbers, reserveReportNumbers,
} from '../tracker/reserve-report-num.mjs';
import { evaluateDeterministicGate, formatGateRejection } from './evaluation-gate.mjs';
import {
  buildScoringPrompt,
  parseScoringResponse,
  renderEvaluationReport,
} from './scoring-contract.mjs';

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
  reports:     join(ROOT, 'reports'),
  tracker:     join(ROOT, 'data', 'applications.md'),
  trackerAdditions: join(ROOT, 'batch', 'tracker-additions'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Gemini Evaluator (free-tier)             ║
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

function validateEvaluationShape(text) {
  const issues = [];
  const requiredBlocks = [
    ['A', /(?:^|\n)#{1,3}\s*(?:A[).:-]?|Block A\b)/im],
    ['B', /(?:^|\n)#{1,3}\s*(?:B[).:-]?|Block B\b)/im],
    ['C', /(?:^|\n)#{1,3}\s*(?:C[).:-]?|Block C\b)/im],
    ['D', /(?:^|\n)#{1,3}\s*(?:D[).:-]?|Block D\b)/im],
    ['E', /(?:^|\n)#{1,3}\s*(?:E[).:-]?|Block E\b)/im],
    ['F', /(?:^|\n)#{1,3}\s*(?:F[).:-]?|Block F\b)/im],
    ['G', /(?:^|\n)#{1,3}\s*(?:G[).:-]?|Block G\b)/im],
  ];

  for (const [label, pattern] of requiredBlocks) {
    if (!pattern.test(text)) issues.push(`missing Block ${label}`);
  }

  const summary = text.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  if (!summary) {
    issues.push('missing SCORE_SUMMARY block');
  } else {
    const summaryBlock = summary[1];
    for (const key of ['COMPANY', 'ROLE', 'ARCHETYPE', 'LEGITIMACY']) {
      const field = summaryBlock.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi'));
      const value = field?.[1]?.trim() ?? '';
      if (!value || (key !== 'COMPANY' && value.toLowerCase() === 'unknown')) {
        issues.push(`SCORE_SUMMARY ${key} is required`);
      }
    }

    const score = summaryBlock.match(/^\s*SCORE:\s*([0-9]+(?:\.[0-9]+)?)/mi);
    const scoreValue = score ? Number(score[1]) : NaN;
    if (!Number.isFinite(scoreValue) || scoreValue < 0 || scoreValue > 5) {
      issues.push('SCORE_SUMMARY score must be a number between 0 and 5');
    }
  }

  if (issues.length > 0) {
    throw new Error(`Gemini returned an invalid career-ops report: ${issues.join('; ')}`);
  }
}

function slugifyCompany(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function tsvSafe(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function normalizedTrackerScore(value) {
  const clean = tsvSafe(value);
  if (!clean || clean === '?') return 'N/A';
  return /\/5$/i.test(clean) ? clean : `${clean}/5`;
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
try {
  const result = await model.generateContent(`JOB DESCRIPTION TO EVALUATE:\n\n${jdText}`);
  evaluationText = renderEvaluationReport(parseScoringResponse(result.response.text()));
  const usage = {
    prompt_tokens: result.response.usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: result.response.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: result.response.usageMetadata?.totalTokenCount ?? 0,
    cached_tokens: result.response.usageMetadata?.cachedContentTokenCount ?? 0
  };
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
console.log('  CAREER-OPS EVALUATION — powered by Google Gemini');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

// ---------------------------------------------------------------------------
// Parse score summary
// ---------------------------------------------------------------------------
const summaryMatch = evaluationText.match(
  /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const block = summaryMatch[1];
  const extract = (key) => {
    const prefix = `${key}:`;
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trim();
      }
    }
    return 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  let reportSaved = false;
  let reservedNumbers = [];
  try {
    try {
      if (!existsSync(PATHS.reports)) {
        mkdirSync(PATHS.reports, { recursive: true });
      }

      reservedNumbers   = await reserveReportNumbers(1, { rootDir: ROOT, reportsDir: PATHS.reports });
      const num         = formatReportNumber(reservedNumbers[0]);
      const today       = new Date().toISOString().split('T')[0];
      const companySlug = slugifyCompany(company);
      const filename    = `${num}-${companySlug}-${today}.md`;
      const reportPath  = join(PATHS.reports, filename);
      const trackerPath = join(PATHS.trackerAdditions, `${num}-${companySlug}.tsv`);

    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Gemini (${modelName})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

      writeFileSync(reportPath, reportContent, 'utf-8');
      mkdirSync(PATHS.trackerAdditions, { recursive: true });
      const trackerFields = [
        String(parseInt(num, 10)),
        today,
        tsvSafe(company),
        tsvSafe(role),
        'Evaluated',
        normalizedTrackerScore(score),
        '❌',
        `[${num}](reports/${filename})`,
        'Gemini evaluation',
      ];
      writeFileSync(trackerPath, `${trackerFields.join('\t')}\n`, 'utf-8');
      console.log(`\n✅  Report saved: reports/${filename}`);
      console.log(`📊  Tracker addition saved: batch/tracker-additions/${num}-${companySlug}.tsv`);
      reportSaved = true;
    } catch (err) {
      console.warn(`⚠️   Could not save report: ${err.message}`);
      process.exitCode = 1;
    }

    if (reportSaved) {
      try {
        const mergeOutput = execFileSync(process.execPath, [join(ROOT, 'src/tracker/merge-tracker.mjs')], {
          cwd: ROOT,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (mergeOutput.trim()) console.log(mergeOutput.trim());
        console.log('📊  Tracker merged into data/applications.md.');
      } catch (err) {
        console.warn(`⚠️   Report saved, but could not merge tracker addition into data/applications.md: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    if (reservedNumbers.length > 0) {
      try {
        await releaseReportNumbers(reservedNumbers, { rootDir: ROOT, reportsDir: PATHS.reports });
      } catch (err) {
        console.warn(`⚠️   Could not release report reservation: ${err.message}`);
      }
    }
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');

console.log(formatBreakdown(tracker, modelName, 'gemini'));
