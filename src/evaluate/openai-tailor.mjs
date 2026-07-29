#!/usr/bin/env node
/**
 * OpenAI-compatible, tool-less CV tailoring.
 *
 * The model returns the shared bounded tailoring contract. Trusted code injects
 * candidate identity, renders the selected template, verifies factual claims,
 * and atomically publishes the HTML. Model output is never written as HTML.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { ROOT } from '#paths';
import { readBodyLimited } from '../../providers/_http.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import { frameUntrustedJobText } from '../security/job-document.mjs';
import {
  MAX_TAILORING_RESPONSE_BYTES,
  buildTailoringSystemPrompt,
  parseTailoringResponse,
  trustedCandidate,
} from '../cv/tailoring-contract.mjs';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_API_ENVELOPE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;

function usage() {
  return `Frontrunner OpenAI-compatible CV tailoring

Usage:
  node src/evaluate/openai-tailor.mjs --jd <path> --report <path>
  node src/evaluate/openai-tailor.mjs --url <base> --model <id> --jd <path> --report <path>

Options:
  --jd <path>      Job-description file
  --report <path>  Evaluation report
  --model <id>     Model id (OPENAI_MODEL, default gpt-4o)
  --url <base>     OpenAI-compatible base including /v1
  --key <key>      API key (OPENAI_API_KEY)
`;
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

function readBoundedFile(file, label, { required = true } = {}) {
  if (!existsSync(file)) {
    if (required) throw new Error(`${label} not found: ${file}`);
    return '';
  }
  const size = statSync(file).size;
  if (size > MAX_SOURCE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_SOURCE_BYTES} bytes`);
  }
  return readFileSync(file, 'utf8').trim();
}

export function endpointPolicy(baseUrl, apiKey) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`invalid OPENAI_BASE_URL: ${baseUrl}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('OPENAI_BASE_URL must not contain credentials');
  }
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(parsed.hostname);
  if (!loopback && parsed.protocol !== 'https:') {
    throw new Error('remote OpenAI-compatible endpoints must use HTTPS');
  }
  if (loopback && !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('local OpenAI-compatible endpoints must use HTTP(S)');
  }
  if (!loopback && !apiKey) {
    throw new Error(`an API key is required for ${parsed.hostname}`);
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/chat/completions`;
  parsed.search = '';
  parsed.hash = '';
  return { endpoint: parsed.href, host: parsed.hostname };
}

function safeDiagnostic(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300);
}

function slug(value, fallback) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 80) || fallback;
}

export async function requestTailoringPayload({
  endpoint,
  apiKey = '',
  model,
  systemPrompt,
  jobPrompt,
  reportPrompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('OPENAI_TIMEOUT_MS must be a positive integer');
  }
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    redirect: 'error',
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${reportPrompt}\n\n${jobPrompt}\n\nReturn only the required tailoring JSON.`,
        },
      ],
      max_tokens: 8192,
      stream: false,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await readBodyLimited(response, 64 * 1024).catch(() => '');
    const detail = safeDiagnostic(body);
    throw new Error(`OpenAI-compatible endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const envelopeText = await readBodyLimited(response, MAX_API_ENVELOPE_BYTES);
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new Error('OpenAI-compatible endpoint returned invalid JSON');
  }
  const raw = envelope?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('OpenAI-compatible endpoint returned an empty tailoring response');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_TAILORING_RESPONSE_BYTES) {
    throw new Error(`model tailoring response exceeds ${MAX_TAILORING_RESPONSE_BYTES} bytes`);
  }
  return parseTailoringResponse(raw);
}

export async function runOpenAiTailoring({
  jdPath,
  reportPath,
  model = process.env.OPENAI_MODEL || 'gpt-4o',
  baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey = process.env.OPENAI_API_KEY || '',
  timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
  runCode = execFileSync,
  rootDir = ROOT,
} = {}) {
  if (!jdPath || !reportPath) throw new Error('--jd and --report are required');
  const jdText = readBoundedFile(resolve(jdPath), 'JD file');
  const reportText = readBoundedFile(resolve(reportPath), 'report file');
  const cv = readBoundedFile(join(rootDir, 'cv.md'), 'cv.md');
  const profile = readBoundedFile(join(rootDir, 'config', 'profile.yml'), 'config/profile.yml');
  const proof = readBoundedFile(join(rootDir, 'article-digest.md'), 'article-digest.md', {
    required: false,
  });
  const { endpoint, host } = endpointPolicy(baseUrl.replace(/\/+$/u, ''), apiKey);
  const systemPrompt = buildTailoringSystemPrompt({
    cv,
    profile,
    proof,
    languageInstruction: outputLanguageInstruction(parseOutputLanguage(profile)),
  });
  const jobDocument = frameUntrustedJobText(jdText);
  const reportDocument = frameUntrustedJobText(reportText);
  const payload = await requestTailoringPayload({
    endpoint,
    apiKey,
    model,
    systemPrompt,
    jobPrompt: jobDocument.prompt,
    reportPrompt: reportDocument.prompt,
    timeoutMs,
    fetchImpl,
  });
  payload.candidate = trustedCandidate(profile);

  const reportFilename = basename(reportPath);
  const reportNumber = reportFilename.match(/^(\d+)-/u)?.[1]?.padStart(3, '0') ?? '000';
  const company = reportFilename.match(/^\d+-(.+?)-\d{4}-\d{2}-\d{2}\.md$/u)?.[1]
    ?? 'unknown-company';
  const filename = `cv-${slug(payload.candidate.name, 'candidate')}-${slug(company, 'company')}.html`;
  const outputDir = join(rootDir, 'output');
  const outputPath = join(outputDir, filename);
  const scratch = mkdtempSync(join(tmpdir(), 'frontrunner-openai-tailor-'));

  try {
    const payloadFile = join(scratch, 'payload.json');
    const renderedFile = join(scratch, 'rendered.html');
    writeFileSync(payloadFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    const template = runCode(
      process.execPath,
      [join(rootDir, 'src/cv/cv-templates.mjs'), 'resolve', 'cv'],
      { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim().split('\n').at(-1);
    runCode(
      process.execPath,
      [join(rootDir, 'src/cv/build-cv-html.mjs'), payloadFile, renderedFile, template],
      { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    runCode(
      process.execPath,
      [join(rootDir, 'src/cv/verify-cv-facts.mjs'), renderedFile],
      { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    mkdirSync(outputDir, { recursive: true });
    replaceFileAtomic(outputPath, readFileSync(renderedFile, 'utf8'), { mode: 0o600 });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  return {
    html: outputPath,
    reportNumber,
    provider: host,
    security: {
      contract: payload.version,
      renderer: 'deterministic',
      jobSha256: jobDocument.sha256,
      reportSha256: reportDocument.sha256,
    },
  };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      console.log(usage());
      return;
    }
    const result = await runOpenAiTailoring({
      jdPath: option(args, '--jd'),
      reportPath: option(args, '--report'),
      model: option(args, '--model', process.env.OPENAI_MODEL || 'gpt-4o'),
      baseUrl: option(args, '--url', process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      apiKey: option(args, '--key', process.env.OPENAI_API_KEY || ''),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`OpenAI-compatible tailoring failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await main();
}
