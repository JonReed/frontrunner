#!/usr/bin/env node
// @ts-check
/**
 * prefilter.mjs — deterministic rejection pass (zero LLM tokens).
 *
 * WHY THIS EXISTS
 * ---------------
 * Across a 123-role batch run, the reasons recorded in the reports'
 * `discard_reasons` were:
 *
 *     seniority_mismatch     35     <- decidable from the title
 *     salary_too_low         21     <- decidable when a figure is published
 *     tech_stack_mismatch    18     <- mostly decidable from the title
 *     role_family_mismatch    6     <- decidable from the title
 *     geo_restriction         4     <- scan.mjs already does this
 *     genuine judgement      ~8
 *
 * ~60% of an expensive LLM pass was spent concluding things a regex settles
 * instantly. This script makes those calls up front, so a worker is only ever
 * spawned for a role that needs judgement.
 *
 * DESIGN RULES
 *   1. Never silently drop. Every rejection records the exact rule and the
 *      matched text, so the output is auditable and tunable.
 *   2. Bias toward keeping. An unclear role passes through to the LLM. A false
 *      reject costs an opportunity; a false keep costs a few cents.
 *   3. Read config from the user layer (workspace/profile/profile.yml), never hardcode.
 *
 * USAGE
 *   node src/scan/prefilter.mjs --summary
 *   node src/scan/prefilter.mjs --input workspace/.state/batch-input.tsv --out workspace/.state/batch-input.filtered.tsv
 *   node src/scan/prefilter.mjs --json
 *   node src/scan/prefilter.mjs --explain "Staff Product Engineer, AI"
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { MAX_JOB_DOCUMENT_CHARS } from '../security/job-document.mjs';
import { assertTestUserDataWriteAllowed } from '../lib/test-user-data-policy.mjs';
import { loadPrefilterRules } from './prefilter-config.mjs';
import {
  matchingPrefilterOverride,
  readPrefilterOverrides,
} from './prefilter-overrides.mjs';
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (f, d) => {
  const i = argv.indexOf(f);
  if (i === -1) return d;
  const value = argv[i + 1];
  if (!value || value.startsWith('-')) throw new Error(`${f} requires a value`);
  return value;
};

// ---------------------------------------------------------------- config

/** Minimal YAML scalar reader — avoids a dependency for three lookups. */
function readProfile() {
  const f = join(ROOT, 'workspace/profile/profile.yml');
  const out = { minComp: 0, currency: 'GBP', clearances: [] };
  if (!existsSync(f)) return out;
  const raw = readFileSync(f, 'utf8');
  const min = raw.match(/^\s*minimum:\s*["']?([^"'\n]+)/m);
  if (min) {
    const n = min[1].replace(/[^0-9.]/g, '');
    if (n) out.minComp = /k\b/i.test(min[1]) ? Number(n) * 1000 : Number(n);
  }
  const cur = raw.match(/^\s*currency:\s*["']?([A-Z]{3})/m);
  if (cur) out.currency = cur[1];
  return out;
}

const PROFILE = readProfile();

// ---------------------------------------------------------------- rules

let defaultRules;
function getDefaultRules() {
  if (!defaultRules) {
    defaultRules = loadPrefilterRules({ override: argVal('--config', process.env.FRONTRUNNER_PREFILTER) });
  }
  return defaultRules;
}

// ---------------------------------------------------------------- classify

/**
 * Classify a role from its title (and optionally JD text).
 * @returns {{verdict:'reject'|'keep', rule:string, evidence:string}}
 */
export function classify(title, jdText = '', profile = PROFILE, rules) {
  const activeRules = rules ?? getDefaultRules();
  const t = String(title || '').slice(0, 500);
  const body = String(jdText ?? '').slice(0, MAX_JOB_DOCUMENT_CHARS);

  const hitOf = (list) => list.find((re) => re.test(t));

  // 1. Wrong function — unambiguous, check first so "Head of Marketing" dies here.
  const wrong = hitOf(activeRules.wrong);
  if (wrong) return { verdict: 'reject', rule: 'wrong_function', evidence: t.match(wrong)?.[0] ?? '' };

  // 2. Junior — but a "Director" token rescues (e.g. "Associate Director").
  const junior = hitOf(activeRules.junior);
  if (junior && !hitOf(activeRules.keep)) {
    return { verdict: 'reject', rule: 'below_level', evidence: t.match(junior)?.[0] ?? '' };
  }

  // 3. IC role family — leadership tokens rescue ("Engineering Manager").
  const ic = hitOf(activeRules.ic);
  const lead = hitOf(activeRules.keep);
  if (ic && !lead) {
    return { verdict: 'reject', rule: 'ic_role_family', evidence: t.match(ic)?.[0] ?? '' };
  }

  // 4. Hard blockers in the JD body.
  if (body) {
    for (const b of activeRules.blockers) {
      if (b.all.every((re) => re.test(body))) {
        const m = body.match(/[^.\n]{0,90}clearance[^.\n]{0,60}/i) ?? body.match(/[^.\n]{0,90}sponsor[^.\n]{0,60}/i);
        return { verdict: 'reject', rule: b.id, evidence: (m?.[0] ?? b.reason).trim().slice(0, 140) };
      }
    }

    // 5. Published comp below the floor. Only fires on an explicit currency range.
    if (activeRules.comp.enabled && profile.minComp > 0) {
      const sym = { GBP: '£', USD: '$', EUR: '€' }[profile.currency];
      if (!sym) {
        return { verdict: 'keep', rule: lead ? 'leadership_signal' : 'unclear', evidence: lead ? t.match(lead)?.[0] ?? '' : '' };
      }
      const re = new RegExp(`\\${sym}\\s?(\\d{2,3})(?:,(\\d{3}))?\\s?(k\\b)?`, 'gi');
      const vals = [];
      for (const m of body.matchAll(re)) {
        let v = Number(m[1] + (m[2] ?? ''));
        if (m[3]) v *= 1000;
        else if (v < 1000) v *= 1000;
        if (v >= 10_000 && v <= 2_000_000) vals.push(v);
      }
      if (vals.length) {
        const top = Math.max(...vals);
        // A published figure is usually BASE; the floor is TOTAL comp. Bonus,
        // equity and sign-on routinely close a 20-30% gap, so only reject when
        // the published number is far enough below the floor that no plausible
        // package closes it. (Rule 2: bias toward keeping.)
        const CLEARANCE_MARGIN = activeRules.comp.margin;
        const cutoff = profile.minComp * CLEARANCE_MARGIN;
        if (top < cutoff) {
          return {
            verdict: 'reject',
            rule: 'comp_below_floor',
            evidence: `max published ${sym}${top.toLocaleString()} < ${Math.round(
              CLEARANCE_MARGIN * 100,
            )}% of floor ${sym}${profile.minComp.toLocaleString()} (=${sym}${cutoff.toLocaleString()})`,
          };
        }
      }
    }
  }

  // 6. No rule fired — this needs judgement. Send it to the model.
  return { verdict: 'keep', rule: lead ? 'leadership_signal' : 'unclear', evidence: lead ? t.match(lead)?.[0] ?? '' : '' };
}

// ---------------------------------------------------------------- io

function readRoles(file) {
  const raw = readFileSync(file, 'utf8');
  const roles = [];
  for (const line of raw.split('\n')) {
    const md = line.match(/^-\s*\[\s*\]\s*(\S+)(.*)$/);
    if (md) {
      const fields = md[2].split('|').map((value) => value.trim()).filter((_, index) => index > 0);
      roles.push({
        id: String(roles.length + 1),
        url: md[1],
        company: fields[0] ?? '',
        title: fields[1] ?? '',
        source: 'pipeline',
      });
      continue;
    }
    const c = line.split('\t');
    if (c.length >= 4 && /^https?:\/\//.test(c[1]?.trim() ?? '')) {
      const note = c[3] ?? '';
      const divider = note.includes('—') ? '—' : note.includes(' - ') ? ' - ' : null;
      const [company = '', title = note] = divider ? note.split(divider, 2).map((s) => s.trim()) : ['', note.trim()];
      roles.push({
        id: c[0]?.trim() || String(roles.length + 1),
        url: c[1].trim(),
        company,
        title,
        source: c[2]?.trim() || 'scan',
      });
    }
  }
  return roles;
}

function loadJdIndex(dir) {
  const idx = new Map();
  const f = join(dir, 'index.tsv');
  if (!existsSync(f)) return idx;
  for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) {
    const [url, file] = line.split('\t');
    if (url && file) idx.set(url.trim(), file.trim());
  }
  return idx;
}

function atomicWriteBatch(entries) {
  // This legacy two-file transaction has its own rollback protocol. Apply the
  // universal stale-test barrier to every final destination before creating
  // any temporary or backup file; transaction replacement is a later slice.
  for (const { file } of entries) assertTestUserDataWriteAllowed(file);
  const token = `${process.pid}-${randomUUID()}`;
  const staged = entries.map(({ file, contents }, index) => ({
    file,
    contents,
    tmp: `${file}.tmp-${token}-${index}`,
    backup: `${file}.bak-${token}-${index}`,
    existed: existsSync(file),
    published: false,
    restoreFailed: false,
  }));

  try {
    for (const entry of staged) {
      mkdirSync(dirname(entry.file), { recursive: true });
      if (entry.existed && !lstatSync(entry.file).isFile()) {
        throw new Error(`prefilter: output target is not a file: ${entry.file}`);
      }
      writeFileSync(entry.tmp, entry.contents);
      if (entry.existed) copyFileSync(entry.file, entry.backup);
    }

    for (const entry of staged) {
      renameSync(entry.tmp, entry.file);
      entry.published = true;
    }
  } catch (error) {
    for (const entry of [...staged].reverse()) {
      try {
        if (entry.published) {
          if (entry.existed && existsSync(entry.backup)) copyFileSync(entry.backup, entry.file);
          else rmSync(entry.file, { force: true });
        }
      } catch {
        // Preserve the original error. A surviving .bak file remains recoverable.
        entry.restoreFailed = true;
      }
    }
    for (const entry of staged) {
      try { rmSync(entry.tmp, { force: true }); } catch {}
      if (!entry.restoreFailed) {
        try { rmSync(entry.backup, { force: true }); } catch {}
      }
    }
    throw error;
  }

  for (const entry of staged) {
    try { rmSync(entry.backup, { force: true }); } catch {}
  }
}

export function sanitizeTsvField(value, maxChars = 4_096) {
  const normalized = String(value ?? '')
    .replace(/[\u0000\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const guarded = /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  return guarded.slice(0, maxChars);
}

/**
 * Run the destructive I/O portion against explicit paths.
 * Keeping this callable lets tests exercise the same filesystem behavior as the
 * CLI without touching a user's pipeline, cache, or audit log.
 */
export function runPrefilter({
  input,
  jdsDir,
  out = '',
  rejects,
  profile = PROFILE,
  rules,
  overrides = new Map(),
}) {
  if (!existsSync(input)) throw new Error(`prefilter: input not found: ${input}`);
  const pathRoles = [
    ['input', resolve(input)],
    ['rejects', resolve(rejects)],
    ...(out ? [['out', resolve(out)]] : []),
  ];
  for (let index = 0; index < pathRoles.length; index += 1) {
    for (let other = index + 1; other < pathRoles.length; other += 1) {
      if (pathRoles[index][1] === pathRoles[other][1]) {
        throw new Error(
          `prefilter: ${pathRoles[index][0]} and ${pathRoles[other][0]} must use different paths`,
        );
      }
    }
  }
  const activeRules = rules ?? getDefaultRules();
  const roles = readRoles(input);
  const jdIndex = loadJdIndex(jdsDir);

  const kept = [];
  const rejected = [];

  for (const r of roles) {
    let jd = '';
    const f = jdIndex.get(r.url);
    if (f && existsSync(f)) {
      try {
        jd = readFileSync(f, 'utf8');
      } catch {
        /* unreadable JD is not a reason to reject */
      }
    }
    const res = classify(r.title, jd, profile, activeRules);
    const override = res.verdict === 'reject'
      ? matchingPrefilterOverride(r.url, res.rule, overrides)
      : null;
    if (res.verdict === 'reject' && !override) rejected.push({ ...r, ...res });
    else if (override) {
      kept.push({
        ...r,
        verdict: 'keep',
        rule: 'user_override',
        evidence: res.evidence,
        overrideRule: res.rule,
      });
    } else kept.push({ ...r, ...res });
  }

  const writes = [{
    file: rejects,
    contents: `url\tcompany\ttitle\trule\tevidence\n${rejected
      .map((r) => [
        sanitizeTsvField(r.url, 4_096),
        sanitizeTsvField(r.company, 300),
        sanitizeTsvField(r.title, 500),
        sanitizeTsvField(r.rule, 64),
        sanitizeTsvField(r.evidence, 140),
      ].join('\t'))
      .join('\n')}\n`,
  }];

  if (out) {
    writes.push({
      file: out,
      contents: `id\turl\tsource\tnotes\n${kept
        .map((r, i) => {
          const src = r.source || (r.url.includes('greenhouse')
            ? 'Greenhouse'
            : r.url.includes('ashby')
              ? 'Ashby'
              : r.url.includes('myworkdayjobs')
                ? 'Workday'
                : 'scan');
          return [
            sanitizeTsvField(r.id || i + 1, 64),
            sanitizeTsvField(r.url, 4_096),
            sanitizeTsvField(src, 100),
            sanitizeTsvField(`${r.company} — ${r.title}`, 1_000),
          ].join('\t');
        })
        .join('\n')}\n`,
    });
  }
  // Prepare every artifact before replacing any of them. If one destination is
  // invalid or unwritable, the prior audit and filtered batch remain paired.
  atomicWriteBatch(writes);

  const byRule = {};
  for (const r of rejected) byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;

  const result = {
    input,
    roles: roles.length,
    kept: kept.length,
    rejected: rejected.length,
    rejectedPct: roles.length ? Math.round((rejected.length / roles.length) * 100) : 0,
    byRule,
    jdsAvailable: jdIndex.size,
    rejectsLog: rejects,
    out: out || null,
  };
  return { result, kept, rejected };
}

function main() {
  if (hasFlag('-h') || hasFlag('--help')) {
    console.log(`prefilter.mjs — deterministic rejection pass (zero LLM tokens)

Usage:
  node src/scan/prefilter.mjs [--input <file>] [--out <file>] [--jds <dir>] [--summary|--json]
  node src/scan/prefilter.mjs --explain "<job title>"

  --input <file>   Default: workspace/search/pipeline.md. Also accepts a TSV (col 2 = url).
  --out <file>     Write surviving roles as a batch-input TSV.
  --jds <dir>      JD text dir from fetch-jds.mjs. Default: jds
  --rejects <file> Write rejected roles + reasons as TSV. Default: workspace/.state/prefilter-rejects.tsv
  --config <file>  Explicit prefilter YAML. Default: workspace/search/prefilter.yml, then example
  --explain <t>    Show how one title classifies, then exit.
`);
    return;
  }

  if (hasFlag('--explain')) {
    const t = argVal('--explain', '');
    const r = classify(t);
    console.log(`title:    ${t}`);
    console.log(`verdict:  ${r.verdict.toUpperCase()}`);
    console.log(`rule:     ${r.rule}`);
    console.log(`evidence: ${r.evidence || '(none)'}`);
    return;
  }

  const input = resolve(ROOT, argVal('--input', 'workspace/search/pipeline.md'));
  const jdsDir = resolve(ROOT, argVal('--jds', 'workspace/jobs/descriptions'));
  const outArg = argVal('--out', '');
  const out = outArg ? resolve(ROOT, outArg) : '';
  const rejects = resolve(ROOT, argVal('--rejects', 'workspace/.state/prefilter-rejects.tsv'));
  const summary = hasFlag('--summary');
  const { result, kept, rejected } = runPrefilter({
    input,
    jdsDir,
    out,
    rejects,
    overrides: readPrefilterOverrides(),
  });

  if (summary) {
    console.log('\n=== prefilter ===');
    console.log(`  roles in:   ${result.roles}`);
    console.log(`  kept:       ${kept.length}  (sent to the LLM)`);
    console.log(`  rejected:   ${rejected.length}  (${result.rejectedPct}% — zero tokens)`);
    console.log('\n  by rule:');
    for (const [k, v] of Object.entries(result.byRule).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(4)}  ${k}`);
    }
    console.log(`\n  audit trail: ${rejects}`);
    if (out) console.log(`  batch input: ${out}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  try {
    main();
  } catch (err) {
    console.error(err.message ?? err);
    process.exitCode = 1;
  }
}
