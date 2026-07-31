/**
 * company-suggestions.ts — read the shortlist the model produced.
 *
 * A file rather than a job result, deliberately. The suggestion run is a job
 * so that its spend is deduplicated and supervised like every other model
 * call; what it produces is a document the interface reads afterwards, the
 * same way reports and the tracker work. Threading structured output back
 * through a job's log tail would make the result a side effect of process
 * plumbing.
 *
 * Everything here is model-generated and therefore untrusted: names are
 * re-validated against the same shape the follow request will accept, so a
 * suggestion that could never be followed is never offered.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './root';

const SUGGESTIONS_FILE = join(ROOT, 'workspace', '.state', 'company-suggestions.json');
const MAX_BYTES = 64 * 1024;
const MAX_SUGGESTIONS = 20;
/** Mirrors COMPANY_NAME_RE in the application contract. */
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,&'’()+/-]*$/u;

export interface CompanySuggestion {
  name: string;
  why: string;
}

export async function readCompanySuggestions(): Promise<CompanySuggestion[]> {
  let raw: string;
  try {
    raw = await readFile(SUGGESTIONS_FILE, 'utf8');
  } catch {
    return [];
  }
  if (Buffer.byteLength(raw) > MAX_BYTES) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const companies = (parsed as { companies?: unknown })?.companies;
  if (!Array.isArray(companies)) return [];

  const seen = new Set<string>();
  const out: CompanySuggestion[] = [];
  for (const entry of companies.slice(0, MAX_SUGGESTIONS)) {
    const item = entry as { name?: unknown; why?: unknown };
    if (typeof item?.name !== 'string') continue;
    const name = item.name.trim();
    if (!name || name.length > 80 || !NAME_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      why: typeof item.why === 'string' ? item.why.trim().slice(0, 200) : '',
    });
  }
  return out;
}
