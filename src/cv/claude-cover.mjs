#!/usr/bin/env node
/**
 * Tool-less Claude cover letter drafting.
 *
 * The sibling of claude-tailor.mjs and deliberately its mirror image: the
 * model returns a bounded render payload and can read no files, run no shell
 * commands, browse nothing and write nothing. Fixed code paths then inject the
 * candidate's identity from the trusted profile, render and produce the PDF.
 *
 * Why it exists: `cover` has been a documented mode since the beginning, the
 * template ships, and a cover letter is expected with most applications — but
 * the interface only ever offered to build a CV. Someone who reached "Ready to
 * send" had half of what they needed and no way to ask for the other half.
 *
 * Like the CV path, this reads only the cached job description. If the
 * pipeline has not fetched one, the answer is to run the pipeline — never to
 * hand a model a browser.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { outputLanguageInstruction, parseOutputLanguage } from '../lib/profile-language.mjs';
import { readBoundedRegularFileSync } from '../lib/safe-file-read.mjs';
import { recordPdfIndex } from './pdf-index-store.mjs';
import { frameUntrustedJobText } from '../security/job-document.mjs';
import {
  runBoundedSubprocess,
  runCheckedSubprocess,
} from '../security/subprocess.mjs';
import { trustedCandidate } from './tailoring-contract.mjs';
import {
  COVER_JSON_SCHEMA,
  buildCoverSystemPrompt,
  parseCoverResponse,
} from './cover-contract.mjs';

/** Covering letters, indexed separately from CVs. See the note at the render. */
export const COVER_INDEX_FILE = join(ROOT, 'workspace', '.state', 'cover-index.tsv');

function containedFile(base, candidate) {
  const root = resolve(base);
  const file = resolve(candidate);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw new Error('cached JD path escapes its directory');
  }
  return file;
}

function cachedJdFor(url) {
  const jdsDir = join(ROOT, 'workspace', 'jobs', 'descriptions');
  const index = join(jdsDir, 'index.tsv');
  if (!url) return null;
  const indexText = readBoundedRegularFileSync(index, {
    maxBytes: 5 * 1024 * 1024,
    allowMissing: true,
    label: 'JD cache index',
  });
  if (indexText === null) return null;
  for (const line of indexText.split(/\r?\n/).slice(1)) {
    const [entryUrl, file] = line.split('\t');
    if (entryUrl === url && file) {
      return readBoundedRegularFileSync(containedFile(jdsDir, file), {
        maxBytes: 2 * 1024 * 1024,
        allowMissing: true,
        label: 'cached JD',
      });
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
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'role';
}

function targetSlug(report) {
  const name = basename(String(report ?? ''));
  const match = name.match(/^\d+-(.+?)-\d{4}-\d{2}-\d{2}\.md$/);
  return slug(match?.[1] ?? 'role');
}

export function buildCoverClaudeArgs(systemPrompt, model = '') {
  const args = [
    '-p', '--safe-mode', '--strict-mcp-config', '--tools', '',
    '--no-session-persistence', '--output-format', 'json',
    '--json-schema', JSON.stringify(COVER_JSON_SCHEMA), '--system-prompt', systemPrompt,
  ];
  if (model) args.push('--model', model);
  return args;
}

function defaultModelRun(command, args, options) {
  return runBoundedSubprocess(command, args, {
    cwd: options.cwd,
    input: options.input,
    timeoutMs: options.timeout,
    maxStdoutBytes: options.maxBuffer,
    maxStderrBytes: Math.min(options.maxBuffer, 512 * 1024),
  });
}

async function defaultCodeRun(command, args, options) {
  const result = await runCheckedSubprocess(command, args, {
    cwd: options.cwd,
    timeoutMs: 120_000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
  });
  return result.stdout;
}

export async function draftCoverLetter({
  url,
  report,
  tracker,
  model = '',
  runModel = defaultModelRun,
  runCode = defaultCodeRun,
} = {}) {
  const jd = cachedJdFor(url);
  if (!jd) {
    throw new Error('No cached job description is available. Run the pipeline first; Frontrunner will not give an agent browser or filesystem access as a fallback.');
  }
  const cv = readBoundedRegularFileSync(join(ROOT, 'workspace/profile/cv.md'), {
    maxBytes: 2 * 1024 * 1024,
    label: 'workspace/profile/cv.md',
  });
  const profile = readBoundedRegularFileSync(join(ROOT, 'workspace', 'profile', 'profile.yml'), {
    maxBytes: 2 * 1024 * 1024,
    label: 'workspace/profile/profile.yml',
  });
  const proof = readBoundedRegularFileSync(join(ROOT, 'workspace/profile/article-digest.md'), {
    maxBytes: 2 * 1024 * 1024,
    allowMissing: true,
    label: 'workspace/profile/article-digest.md',
  }) ?? '[none supplied]';

  const document = frameUntrustedJobText(jd);
  const systemPrompt = buildCoverSystemPrompt({
    cv,
    profile,
    proof,
    languageInstruction: outputLanguageInstruction(parseOutputLanguage(profile)),
  });

  console.log('Reading the cached job description');
  const child = await runModel('claude', buildCoverClaudeArgs(systemPrompt, model), {
    cwd: ROOT,
    input: document.prompt,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 3 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Tool-less Claude cover drafting failed (exit ${child.status}): ${String(child.stderr ?? '').slice(-500)}`);
  }

  console.log('Writing your covering letter');
  const drafted = parseCoverResponse(JSON.stringify(claudePayload(child.stdout)));
  // Identity comes only from the trusted local profile, never from a response
  // shaped by a job advert.
  const payload = {
    candidate: trustedCandidate(profile),
    letter: drafted.letter,
  };

  const reportNum = String(report ?? tracker ?? '').match(/\d+/)?.[0]?.padStart(3, '0');
  if (!reportNum) throw new Error('a report or tracker number is required');
  const base = `${reportNum}-${targetSlug(report)}`;
  const outputDir = join(ROOT, 'workspace', 'documents');
  mkdirSync(outputDir, { recursive: true });
  const pdf = join(outputDir, `cover-${base}-${new Date().toISOString().slice(0, 10)}.pdf`);
  const scratch = mkdtempSync(join(tmpdir(), 'frontrunner-cover-'));

  try {
    const payloadFile = join(scratch, 'payload.json');
    writeFileSync(payloadFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    console.log('Building the PDF');
    /*
      Deliberately NOT --report.

      That flag records the render in the shared workspace/.state/pdf-index.tsv,
      whose writer supersedes every row for a report number when a new one
      arrives. That is right when a report owns one document — a rebuilt CV
      replaces the old one — and destructive now that it can own two: recording
      the letter there would delete the CV row for the same role, and the CV
      would disappear from the screen that had just built it.

      The letter is recorded below in its own index instead, so each kind
      supersedes only its own predecessor and every existing reader of the
      shared file keeps its exact previous meaning.
    */
    await runCode(process.execPath, [
      join(ROOT, 'src/cv/generate-cover-letter.mjs'),
      '--payload', payloadFile,
      '--out', pdf,
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    await recordPdfIndex(COVER_INDEX_FILE, {
      reportNum,
      pdf: relative(ROOT, pdf).split(sep).join('/'),
      html: '',
      format: 'a4',
      date: new Date().toISOString().slice(0, 10),
    });
    console.log(JSON.stringify({
      pdf: basename(pdf),
      security: {
        tools: false,
        inputSha256: document.sha256,
        suspiciousSignals: document.suspiciousSignals.length,
      },
    }));
    return { pdf };
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
    await draftCoverLetter({
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
