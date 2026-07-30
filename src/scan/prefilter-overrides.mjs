/**
 * Explicit, role-scoped exceptions to the deterministic prefilter.
 *
 * A user may disagree with a rule, but an override must never become a broad
 * "disable safety" switch. Records therefore bind the exact normalized URL to
 * the exact rule that fired. If the posting later matches a different rule,
 * the new decision still stops before model spend.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';

export const PREFILTER_OVERRIDES_PATH = join(ROOT, 'workspace', 'search', 'prefilter-overrides.tsv');
export const PREFILTER_OVERRIDE_URL_ENV = 'FRONTRUNNER_PREFILTER_OVERRIDE_URL';
export const PREFILTER_OVERRIDE_HEADER = 'recorded_at\turl\tcompany\ttitle\trule\tevidence\n';

function overrideKey(url, rule) {
  return `${url}\t${rule}`;
}

export function normalizeOverrideUrl(value) {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function parsePrefilterOverrides(raw) {
  const active = new Map();
  for (const line of String(raw ?? '').split(/\r?\n/u)) {
    if (!line.trim() || line.startsWith('recorded_at\t')) continue;
    const [recordedAt, rawUrl, company, title, rule, evidence] = line.split('\t');
    const url = normalizeOverrideUrl(rawUrl);
    if (
      !url
      || !/^[a-z0-9][a-z0-9_:-]{0,63}$/u.test(rule ?? '')
      || !Number.isFinite(Date.parse(recordedAt ?? ''))
    ) {
      continue;
    }
    active.set(overrideKey(url, rule), Object.freeze({
      recordedAt,
      url,
      company: company ?? '',
      title: title ?? '',
      rule,
      evidence: evidence ?? '',
    }));
  }
  return active;
}

export function readPrefilterOverrides(file = PREFILTER_OVERRIDES_PATH) {
  if (!existsSync(file)) return new Map();
  try {
    return parsePrefilterOverrides(readFileSync(file, 'utf8'));
  } catch {
    // An unreadable optional exception file must fail closed.
    return new Map();
  }
}

export function matchingPrefilterOverride(url, rule, overrides = readPrefilterOverrides()) {
  const normalized = normalizeOverrideUrl(url);
  return normalized ? overrides.get(overrideKey(normalized, rule)) ?? null : null;
}
