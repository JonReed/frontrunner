#!/usr/bin/env node

/**
 * Bounded UI adapter for one explicit deterministic-prefilter exception.
 *
 * The browser supplies only the URL and rule it is disagreeing with. Company,
 * title and evidence are re-read from the canonical audit log, so hostile page
 * text cannot write arbitrary fields into the user's exception ledger.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { acquireFileLock } from '../lib/file-lock.mjs';
import { appendFileLocked, replaceFileAtomic } from '../lib/locked-file.mjs';
import { withPipelineLock } from '../tracker/pipeline-lock.mjs';
import { pipelineRunLockTarget } from '../pipeline/run.mjs';
import {
  PREFILTER_OVERRIDE_HEADER,
  PREFILTER_OVERRIDES_PATH,
  matchingPrefilterOverride,
  normalizeOverrideUrl,
  readPrefilterOverrides,
} from '../scan/prefilter-overrides.mjs';
import { APPLICATION_API_VERSION } from './contract.mjs';
import { readBoundedRequest } from './run.mjs';

const CONTROL_KEYS = new Set(['version', 'action', 'url', 'rule']);
const PIPELINE = join(ROOT, 'workspace', 'search', 'pipeline.md');
const REJECTS = join(ROOT, 'workspace', '.state', 'prefilter-rejects.tsv');
const ACTIVE_INPUT = join(ROOT, 'workspace', '.state', 'liveness-active.tsv');

function controlError(message, code = 'INVALID_PREFILTER_OVERRIDE_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validatePrefilterOverrideRequest(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw controlError('prefilter override request must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported prefilter override field: ${key}`);
  }
  const url = normalizeOverrideUrl(value.url);
  if (
    value.version !== APPLICATION_API_VERSION
    || value.action !== 'allow'
    || !url
    || !/^[a-z0-9][a-z0-9_:-]{0,63}$/u.test(value.rule ?? '')
    || value.rule === 'posting_expired'
  ) {
    throw controlError('unsupported prefilter override request');
  }
  return Object.freeze({
    version: APPLICATION_API_VERSION,
    action: 'allow',
    url,
    rule: value.rule,
  });
}

function cleanTsv(value, limit) {
  return String(value ?? '').replace(/[\t\r\n\0]+/gu, ' ').trim().slice(0, limit);
}

export function readRejectedRole(file, url, rule) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const [rawUrl, company, title, candidateRule, evidence] = line.split('\t');
    if (normalizeOverrideUrl(rawUrl) === url && candidateRule === rule) {
      return Object.freeze({
        url,
        company: cleanTsv(company, 300),
        title: cleanTsv(title, 500),
        rule,
        evidence: cleanTsv(evidence, 140),
      });
    }
  }
  return null;
}

function restorePipelineRole(file, url) {
  const current = readFileSync(file, 'utf8');
  let found = false;
  const next = current.split('\n').map((line) => {
    const match = line.match(/^-\s*\[([ xX])\]\s*(\S+)/u);
    if (!match || normalizeOverrideUrl(match[2]) !== url) return line;
    found = true;
    return line
      .replace(/^-\s*\[[ xX]\]/u, '- [ ]')
      .replace(/\s*\|\s*result:\s*prefilter rejected \([^)]+\)\s*$/iu, '');
  }).join('\n');
  if (!found) throw controlError('that role is no longer in the pipeline audit trail', 'PREFILTER_ROLE_MISSING');
  if (next !== current) replaceFileAtomic(file, next);
}

export async function allowRejectedRole({
  url,
  rule,
  pipeline = PIPELINE,
  rejects = REJECTS,
  overridesFile = PREFILTER_OVERRIDES_PATH,
  activeInput = ACTIVE_INPUT,
  now = () => new Date(),
} = {}) {
  const role = readRejectedRole(rejects, url, rule);
  if (!role) {
    throw controlError('that exact rejection is no longer present', 'PREFILTER_REJECTION_MISSING');
  }
  if (!existsSync(pipeline)) {
    throw controlError('the pending-role list is missing', 'PREFILTER_ROLE_MISSING');
  }

  // The canonical run owns the same lease from scan through evaluation. Taking
  // it here makes "override" and "run" mutually exclusive without bypassing
  // or racing any pipeline stage.
  const lease = await acquireFileLock(pipelineRunLockTarget(activeInput), {
    timeoutMs: 0,
    ownerFields: { operation: 'prefilter-override', url },
  });
  try {
    await withPipelineLock(pipeline, async () => restorePipelineRole(pipeline, url));

    const existing = readPrefilterOverrides(overridesFile);
    if (!matchingPrefilterOverride(url, rule, existing)) {
      const line = [
        now().toISOString(),
        role.url,
        role.company,
        role.title,
        role.rule,
        role.evidence,
      ].map((value) => cleanTsv(value, 4_096)).join('\t');
      await appendFileLocked(overridesFile, `${line}\n`, {
        header: PREFILTER_OVERRIDE_HEADER,
      });
    }
    return Object.freeze({ changed: true, role });
  } finally {
    lease.release();
  }
}

export async function main({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  try {
    const request = validatePrefilterOverrideRequest(await readBoundedRequest(input));
    const result = await allowRejectedRole(request);
    output.write(`${JSON.stringify({ version: APPLICATION_API_VERSION, ...result })}\n`);
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 500),
      code: error?.code ?? 'PREFILTER_OVERRIDE_ERROR',
    })}\n`);
    process.exitCode = 1;
    return null;
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
