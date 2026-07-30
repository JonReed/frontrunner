#!/usr/bin/env node

/**
 * Bounded UI adapter for removing one pending URL from workspace/search/pipeline.md.
 *
 * The request can select only an exact, uncredentialed web URL. The file
 * path and mutation primitive are fixed here, outside the browser process.
 */

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { mutateFileLocked } from '../lib/locked-file.mjs';
import { APPLICATION_API_VERSION } from './contract.mjs';
import { readBoundedRequest } from './run.mjs';

const CONTROL_KEYS = new Set(['version', 'action', 'url']);
const PIPELINE = join(ROOT, 'workspace', 'search', 'pipeline.md');

function controlError(message, code = 'INVALID_INBOX_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateInboxRequest(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw controlError('inbox-control request must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported inbox-control field: ${key}`);
  }
  if (
    value.version !== APPLICATION_API_VERSION
    || !['remove', 'restore'].includes(value.action)
  ) {
    throw controlError('unsupported inbox-control request');
  }
  if (typeof value.url !== 'string' || value.url.length > 2_048) {
    throw controlError('url must be a bounded web URL');
  }
  let parsed;
  try {
    parsed = new URL(value.url);
  } catch {
    throw controlError('url must be a valid web URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw controlError('url must be an uncredentialed web URL');
  }
  return Object.freeze({ version: APPLICATION_API_VERSION, action: value.action, url: parsed.href });
}

export async function setPendingUrlDismissed(filePath, url, dismissed) {
  let changed = false;
  let found = false;
  let matched = 0;
  await mutateFileLocked(filePath, current => {
    const lines = current.split('\n').map(line => {
      const match = line.match(/^-\s*\[([ xX])\]\s*(\S+)/u);
      if (!match) return line;
      let candidate;
      try {
        candidate = new URL(match[2]).href;
      } catch {
        return line;
      }
      if (candidate !== url) return line;
      found = true;
      matched += 1;
      const isDismissed = match[1].toLowerCase() === 'x';
      if (isDismissed === dismissed) return line;
      changed = true;
      return line.replace(/^-\s*\[[ xX]\]/u, dismissed ? '- [x]' : '- [ ]');
    });
    return lines.join('\n');
  });
  return Object.freeze({
    changed,
    found,
    matched,
    state: dismissed ? 'dismissed' : 'pending',
  });
}

export async function main({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  try {
    const request = validateInboxRequest(await readBoundedRequest(input));
    const result = await setPendingUrlDismissed(
      PIPELINE,
      request.url,
      request.action === 'remove',
    );
    output.write(`${JSON.stringify({ version: APPLICATION_API_VERSION, ...result })}\n`);
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 500),
      code: error?.code ?? 'INBOX_CONTROL_ERROR',
    })}\n`);
    process.exitCode = 1;
    return null;
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
