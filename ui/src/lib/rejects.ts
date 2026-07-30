/**
 * rejects.ts — roles the prefilter rejected before any model call.
 *
 * These were never scored. A deterministic rule from workspace/search/prefilter.yml
 * matched and the role was dropped, which is the whole point: it is how the
 * pipeline avoids spending the user's AI allowance on roles that cannot fit.
 *
 * Until now this file was written and never read, so 107 roles disappeared
 * with no way to see them or disagree. That is the wrong default for a
 * judgement made by a config file: the user should be able to see the rule
 * that fired, the evidence that triggered it, and overrule it.
 *
 * Everything here is untrusted. The TSV is assembled from job-board content,
 * so URLs go through safeExternalUrl and text is rendered by React as text.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { WORKSPACE } from './root';
import { safeExternalUrl } from './urls';

export interface RejectedRole {
  url: string;
  company: string;
  role: string;
  /** The rule that fired, e.g. `ic_role_family`. */
  rule: string;
  /** What in the posting matched it, e.g. "Software Engineer". */
  evidence: string;
}

/**
 * Rule names are config keys, not English. The user never chose them and
 * should not have to learn them, so each one is stated as the judgement it
 * actually represents.
 */
const RULE_LABEL: Record<string, string> = {
  ic_role_family: 'Hands-on role, not a leadership one',
  wrong_function: 'Wrong function for your targets',
  below_level: 'Below your level',
  comp_below_floor: 'Pay below your floor',
  hard_blocker: 'Ruled out by one of your hard limits',
};

export function describeRule(rule: string): string {
  return RULE_LABEL[rule] ?? rule.replace(/_/g, ' ');
}

export async function readRejects(): Promise<RejectedRole[]> {
  const file = WORKSPACE.rejects;
  if (!existsSync(file)) return [];

  const [raw, overrideRaw] = await Promise.all([
    readFile(file, 'utf8'),
    readFile(WORKSPACE.prefilterOverrides, 'utf8').catch(() => ''),
  ]);
  const overrides = new Set<string>();
  for (const line of overrideRaw.split(/\r?\n/u)) {
    if (!line.trim() || line.startsWith('recorded_at\t')) continue;
    const [, rawUrl, , , rule] = line.split('\t');
    const safe = safeExternalUrl(rawUrl);
    if (safe && rule) overrides.add(`${safe}\t${rule}`);
  }
  const out: RejectedRole[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [url, company, role, rule, evidence] = line.split('\t');
    if (!url || url === 'url') continue;          // header
    const safe = safeExternalUrl(url);
    if (!safe) continue;
    if (overrides.has(`${safe}\t${(rule ?? '').trim()}`)) continue;
    out.push({
      url: safe,
      company: (company ?? '').trim(),
      role: (role ?? '').trim(),
      rule: (rule ?? '').trim(),
      evidence: (evidence ?? '').trim(),
    });
  }
  return out;
}

/** Rejections grouped by rule, most-blocking first — the shape the UI shows. */
export function groupByRule(rejects: RejectedRole[]) {
  const map = new Map<string, RejectedRole[]>();
  for (const r of rejects) {
    const list = map.get(r.rule);
    if (list) list.push(r);
    else map.set(r.rule, [r]);
  }
  return [...map.entries()]
    .map(([rule, roles]) => ({ rule, label: describeRule(rule), roles }))
    .sort((a, b) => b.roles.length - a.roles.length);
}
