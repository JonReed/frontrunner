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

const CONTROL_KEYS = new Set(['version', 'action', 'url', 'company', 'role']);
const PIPELINE = join(ROOT, 'workspace', 'search', 'pipeline.md');

/** Written when someone adds the first role by hand and no scan has ever run. */
const PIPELINE_HEADER = '# Pipeline\n\nRoles waiting to be assessed.\n';

const MAX_LABEL = 120;

/**
 * Strip anything that would change the shape of a pipeline row.
 *
 * `|` separates the cells and a newline ends the row, so a company name
 * containing either would silently move the role's location into its title, or
 * split one role into two. This text is typed by the user, but it is typed
 * from a job advert they are looking at — so it is copy-paste from a hostile
 * page as often as not.
 */
function label(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw controlError(`${field} must be text`);
  const clean = value.replace(/[|\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (clean.length > MAX_LABEL) throw controlError(`${field} is too long`);
  return clean;
}

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
    || !['remove', 'restore', 'add'].includes(value.action)
  ) {
    throw controlError('unsupported inbox-control request');
  }
  if (value.action !== 'add' && (value.company !== undefined || value.role !== undefined)) {
    throw controlError('only add accepts a company or role');
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
  // Labels belong only to `add`. Returning empty ones for remove and restore
  // would put fields on a request that has no use for them, and any consumer
  // reading them would be reading something this action never carried.
  return Object.freeze(
    value.action === 'add'
      ? {
          version: APPLICATION_API_VERSION,
          action: 'add',
          url: parsed.href,
          company: label(value.company, 'company'),
          role: label(value.role, 'role'),
        }
      : {
          version: APPLICATION_API_VERSION,
          action: value.action,
          url: parsed.href,
        },
  );
}

/**
 * Add one job link the user found themselves.
 *
 * The whole product could only ever see roles its own scanner turned up, so
 * "a friend sent me this" — the most ordinary thing that happens in a job
 * search — had nowhere to go. This is the same list the scanner writes to, in
 * the same format, so everything downstream treats a pasted role identically
 * to a discovered one.
 *
 * Idempotent by URL, including against roles already dismissed: re-adding
 * something the user removed on purpose would quietly undo that decision, so
 * it reports the duplicate instead.
 */
export async function appendPendingUrl(filePath, url, { company = '', role = '' } = {}) {
  // Sanitised here as well as in the request validator. This is an exported
  // mutation primitive: a caller that reached it without going through the
  // control would otherwise be able to write a label containing the cell
  // separator, and the row it produced would parse as a different role
  // entirely. The boundary that owns the file format has to own the escaping.
  const safeCompany = label(company, 'company');
  const safeRole = label(role, 'role');
  let duplicate = false;
  await mutateFileLocked(filePath, current => {
    const text = current ?? '';
    for (const line of text.split('\n')) {
      const match = line.match(/^-\s*\[[ xX]\]\s*(\S+)/u);
      if (!match) continue;
      try {
        if (new URL(match[1]).href === url) duplicate = true;
      } catch {
        // A malformed row cannot collide with a URL that already parsed.
      }
    }
    if (duplicate) return text;
    // Trailing cells are kept even when empty: readers treat the row as
    // positional, so dropping them would make `posted:` parse as a location.
    const row = `- [ ] ${url} | ${safeCompany} | ${safeRole} |  | `;
    const body = text.trimEnd();
    return `${body ? `${body}\n` : PIPELINE_HEADER}${row}\n`;
  }, { initial: PIPELINE_HEADER });
  return Object.freeze({ added: !duplicate, duplicate, url });
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
    const result = request.action === 'add'
      ? await appendPendingUrl(PIPELINE, request.url, {
          company: request.company,
          role: request.role,
        })
      : await setPendingUrlDismissed(
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
