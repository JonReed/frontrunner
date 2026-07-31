#!/usr/bin/env node
/**
 * Tool-less Claude employer discovery.
 *
 * The third worker in this directory and the same shape as the other two: the
 * model gets no tools, reads nothing, writes nothing, and returns a bounded
 * payload that fixed code then acts on.
 *
 * What it produces is a SHORTLIST, not a change. The names are written to
 * `workspace/.state/company-suggestions.json` for the interface to display;
 * following any of them is a separate, deliberate act by the user, resolved
 * through the zero-token ATS resolver. Nothing a model returns here reaches
 * `portals.yml`, and no model-supplied address is ever contacted.
 *
 * Unlike the CV and cover-letter workers this reads no job advert, so there is
 * no untrusted remote document in the prompt — only the user's own CV and
 * profile. That is why it can run before any role has been scanned, which is
 * the moment it is most useful.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { readBoundedRegularFileSync } from '../lib/safe-file-read.mjs';
import { runBoundedSubprocess } from '../security/subprocess.mjs';
import { readSearchConfig } from '../application/search-write.mjs';
import {
  COMPANY_JSON_SCHEMA,
  buildCompanySystemPrompt,
  parseCompanyResponse,
} from './company-contract.mjs';

export const SUGGESTIONS_FILE = join(
  ROOT, 'workspace', '.state', 'company-suggestions.json',
);

export function buildCompanyClaudeArgs(systemPrompt, model = '') {
  const args = [
    '-p', '--safe-mode', '--strict-mcp-config', '--tools', '',
    '--no-session-persistence', '--output-format', 'json',
    '--json-schema', JSON.stringify(COMPANY_JSON_SCHEMA), '--system-prompt', systemPrompt,
  ];
  if (model) args.push('--model', model);
  return args;
}

function claudePayload(stdout) {
  const envelope = JSON.parse(String(stdout ?? '').trim());
  const payload = envelope.structured_output ?? envelope.result ?? envelope;
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

function defaultModelRun(command, args, options) {
  return runBoundedSubprocess(command, args, {
    cwd: ROOT,
    input: options.input,
    timeoutMs: options.timeout,
    maxStdoutBytes: options.maxBuffer,
    maxStderrBytes: Math.min(options.maxBuffer, 512 * 1024),
  });
}

export async function suggestCompanies({
  model = '',
  runModel = defaultModelRun,
  now = () => new Date().toISOString(),
} = {}) {
  const cv = readBoundedRegularFileSync(join(ROOT, 'workspace/profile/cv.md'), {
    maxBytes: 2 * 1024 * 1024,
    label: 'workspace/profile/cv.md',
  });
  const profile = readBoundedRegularFileSync(join(ROOT, 'workspace', 'profile', 'profile.yml'), {
    maxBytes: 2 * 1024 * 1024,
    label: 'workspace/profile/profile.yml',
  });

  // The user's own search settings are the steer: what they are looking for,
  // where, and who they already follow. Suggesting employers they have already
  // added would waste the call and read as the product not paying attention.
  const search = readSearchConfig();
  const systemPrompt = buildCompanySystemPrompt({
    cv,
    profile,
    following: search.companies.map((company) => company.name),
    keywords: search.keywords,
    location: search.locations.join(', '),
  });

  console.log('Reading your CV');
  const child = await runModel('claude', buildCompanyClaudeArgs(systemPrompt, model), {
    input: '',
    timeout: 3 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Tool-less Claude employer discovery failed (exit ${child.status}): ${String(child.stderr ?? '').slice(-500)}`);
  }

  console.log('Choosing employers that match your background');
  const parsed = parseCompanyResponse(JSON.stringify(claudePayload(child.stdout)));

  // Anything already followed is dropped here as well as asked for in the
  // prompt: a model instruction is a request, not a guarantee.
  const followed = new Set(search.companies.map((company) => company.name.toLowerCase()));
  const companies = parsed.companies.filter((entry) => !followed.has(entry.name.toLowerCase()));

  mkdirSync(dirname(SUGGESTIONS_FILE), { recursive: true });
  replaceFileAtomic(
    SUGGESTIONS_FILE,
    `${JSON.stringify({ generatedAt: now(), companies }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ suggested: companies.length, security: { tools: false } }));
  return { companies };
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await suggestCompanies({ model: value(process.argv.slice(2), '--model') ?? '' });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
