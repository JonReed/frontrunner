#!/usr/bin/env node
/**
 * Tool-less Claude CV tailoring.
 *
 * The model returns a bounded render payload. It cannot read files, run shell
 * commands, browse, or write anything. Fixed code paths then render, fact-check
 * and index the PDF.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { frameUntrustedJobText } from '../security/job-document.mjs';
import {
  TAILORING_JSON_SCHEMA,
  buildTailoringSystemPrompt,
  parseTailoringResponse,
  trustedCandidate,
} from './tailoring-contract.mjs';

function containedFile(base, candidate) {
  const root = resolve(base);
  const file = resolve(candidate);
  if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('cached JD path escapes its directory');
  return file;
}

function cachedJdFor(url) {
  const jdsDir = join(ROOT, 'jds');
  const index = join(jdsDir, 'index.tsv');
  if (!url || !existsSync(index)) return null;
  for (const line of readFileSync(index, 'utf8').split(/\r?\n/).slice(1)) {
    const [entryUrl, file] = line.split('\t');
    if (entryUrl === url && file) {
      const candidate = containedFile(jdsDir, file);
      return existsSync(candidate) ? readFileSync(candidate, 'utf8') : null;
    }
  }
  return null;
}

function claudePayload(stdout) {
  const envelope = JSON.parse(String(stdout ?? '').trim());
  const payload = envelope.structured_output ?? envelope.result ?? envelope;
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

function slug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'role';
}

function targetSlug(report) {
  const name = basename(String(report ?? ''));
  const match = name.match(/^\d+-(.+?)-\d{4}-\d{2}-\d{2}\.md$/);
  return slug(match?.[1] ?? 'role');
}

export function buildTailorClaudeArgs(systemPrompt, model = '') {
  const args = [
    '-p', '--safe-mode', '--strict-mcp-config', '--tools', '',
    '--no-session-persistence', '--output-format', 'json',
    '--json-schema', JSON.stringify(TAILORING_JSON_SCHEMA), '--system-prompt', systemPrompt,
  ];
  if (model) args.push('--model', model);
  return args;
}

export function tailorCv({
  url,
  report,
  tracker,
  model = '',
  runModel = spawnSync,
  runCode = execFileSync,
} = {}) {
  const jd = cachedJdFor(url);
  if (!jd) {
    throw new Error('No cached job description is available. Run the pipeline first; Frontrunner will not give an agent browser or filesystem access as a fallback.');
  }
  const cv = readFileSync(join(ROOT, 'cv.md'), 'utf8');
  const profile = readFileSync(join(ROOT, 'config', 'profile.yml'), 'utf8');
  const proof = existsSync(join(ROOT, 'article-digest.md'))
    ? readFileSync(join(ROOT, 'article-digest.md'), 'utf8')
    : '[none supplied]';
  const document = frameUntrustedJobText(jd);
  const systemPrompt = buildTailoringSystemPrompt({ cv, profile, proof });

  console.log('Reading the cached job description');
  const child = runModel('claude', buildTailorClaudeArgs(systemPrompt, model), {
    cwd: ROOT,
    input: document.prompt,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 3 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Tool-less Claude tailoring failed (exit ${child.status}): ${String(child.stderr ?? '').slice(-500)}`);
  }
  const payload = parseTailoringResponse(JSON.stringify(claudePayload(child.stdout)));
  // Identity, links, and local photo paths never cross the hostile-JD-facing
  // output contract. They come only from the trusted local profile.
  payload.candidate = trustedCandidate(profile);

  const reportNum = String(report ?? tracker ?? '').match(/\d+/)?.[0]?.padStart(3, '0');
  if (!reportNum) throw new Error('a report or tracker number is required');
  const base = `${reportNum}-${targetSlug(report)}`;
  const outputDir = join(ROOT, 'output');
  mkdirSync(outputDir, { recursive: true });
  const html = join(outputDir, `cv-${base}.html`);
  const pdf = join(outputDir, `cv-${base}-${new Date().toISOString().slice(0, 10)}.pdf`);
  const scratch = mkdtempSync(join(tmpdir(), 'frontrunner-cv-'));

  try {
    const payloadFile = join(scratch, 'payload.json');
    const renderedHtml = join(scratch, 'rendered.html');
    writeFileSync(payloadFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    const template = runCode(process.execPath, [join(ROOT, 'src/cv/cv-templates.mjs'), 'resolve', 'cv'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n').at(-1);
    console.log('Laying out your CV');
    runCode(process.execPath, [join(ROOT, 'src/cv/build-cv-html.mjs'), payloadFile, renderedHtml, template], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('Checking every claim against your CV');
    runCode(process.execPath, [join(ROOT, 'src/cv/verify-cv-facts.mjs'), renderedHtml], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    replaceFileAtomic(html, readFileSync(renderedHtml, 'utf8'), { mode: 0o600 });
    console.log('Building the PDF');
    runCode(process.execPath, [
      join(ROOT, 'src/cv/generate-pdf.mjs'), html, pdf,
      `--format=${payload.page_format}`, `--report=${reportNum}`,
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(JSON.stringify({
      pdf: basename(pdf),
      security: {
        tools: false,
        inputSha256: document.sha256,
        suspiciousSignals: document.suspiciousSignals.length,
      },
    }));
    return { html, pdf };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    tailorCv({
      url: value(args, '--url'),
      report: value(args, '--report'),
      tracker: value(args, '--tracker'),
      model: value(args, '--model') ?? '',
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
