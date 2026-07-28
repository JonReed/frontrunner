#!/usr/bin/env node
// @ts-check
/**
 * fetch-jds.mjs — bulk JD pre-fetcher (zero LLM tokens).
 *
 * WHY THIS EXISTS
 * ---------------
 * `batch/batch-runner.sh` creates an EMPTY temp file per offer and hands its
 * path to the worker as `{{JD_FILE}}`. Nothing ever writes to it, so every
 * worker falls through to `batch-prompt.md` step 1's fallback: "try to fetch
 * the JD from {{URL}} with WebFetch". That means one full HTML page render,
 * inside the model's context, per role — typically 5-30k tokens of markup and
 * chrome to obtain ~2k tokens of job description.
 *
 * Meanwhile the ATS list APIs the scanner already talks to will return the
 * full description for EVERY job at a company in a single request:
 *
 *   Greenhouse  /v1/boards/{slug}/jobs?content=true   -> job.content (HTML)
 *   Ashby       /posting-api/job-board/{slug}         -> job.descriptionPlain (text!)
 *   Lever       /v0/postings/{slug}?mode=json         -> job.descriptionPlain (text!)
 *
 * So: one HTTP call per BOARD instead of one page fetch per ROLE, and the
 * model receives clean text instead of a rendered page.
 *
 * USAGE
 *   node fetch-jds.mjs                      # read data/pipeline.md pending URLs
 *   node fetch-jds.mjs --input batch/batch-input.tsv
 *   node fetch-jds.mjs --out jds --summary
 *   node fetch-jds.mjs --json
 *
 * OUTPUT
 *   jds/{provider}-{slug}-{jobid}.md   one plain-text JD per role
 *   jds/index.tsv                      url -> file manifest (tab separated)
 *
 * Workday is deliberately NOT bulk-fetched: its per-tenant CXS endpoint needs
 * one request per job anyway, so there is no bulk win. Those URLs are reported
 * as `skipped` and the worker keeps its existing fallback path for them.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (f, dflt) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

if (hasFlag('-h') || hasFlag('--help')) {
  console.log(`fetch-jds.mjs — bulk JD pre-fetcher (zero LLM tokens)

Usage:
  node fetch-jds.mjs [--input <file>] [--out <dir>] [--summary|--json] [--force]

  --input <file>  Source of URLs. Default: data/pipeline.md
                  Accepts pipeline.md ("- [ ] <url> | ...") or a TSV whose
                  second column is the URL (e.g. batch/batch-input.tsv).
  --out <dir>     Output directory. Default: jds
  --force         Re-fetch even if the JD file already exists.
  --summary       Human-readable table.
  --json          Machine-readable result (default).
`);
  process.exit(0);
}

const INPUT = argVal('--input', join(ROOT, 'data/pipeline.md'));
const OUT_DIR = join(ROOT, argVal('--out', 'jds'));
const FORCE = hasFlag('--force');
const SUMMARY = hasFlag('--summary');

// ---------------------------------------------------------------- helpers

/** Decode the HTML entities that Greenhouse's `content` field is escaped with. */
const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = Number(d);
      // Guard the RangeError that bit providers/* in #2146.
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const cp = parseInt(h, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" doesn't become "<"

/** Strip HTML to readable plain text, preserving list and paragraph breaks. */
export const htmlToText = (html) =>
  decodeEntities(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|tr)\s*>/gi, '\n\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'career-ops/fetch-jds' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- url parsing

/**
 * Classify a job URL into { provider, slug, jobId }.
 * Returns null when the URL belongs to a provider we do not bulk-fetch.
 */
export function parseJobUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  // Greenhouse: job-boards[.eu].greenhouse.io/{slug}/jobs/{id}
  //             boards.greenhouse.io/{slug}/jobs/{id}
  if (host.endsWith('greenhouse.io')) {
    const i = parts.indexOf('jobs');
    if (i > 0 && parts[i + 1]) {
      return { provider: 'greenhouse', slug: parts[i - 1], jobId: parts[i + 1], eu: host.includes('.eu.') };
    }
    return null;
  }

  // Ashby: jobs.ashbyhq.com/{slug}/{uuid}
  if (host.endsWith('ashbyhq.com')) {
    if (parts.length >= 2) return { provider: 'ashby', slug: parts[0], jobId: parts[1] };
    return null;
  }

  // Lever: jobs.lever.co/{slug}/{uuid}
  if (host.endsWith('lever.co')) {
    if (parts.length >= 2) return { provider: 'lever', slug: parts[0], jobId: parts[1] };
    return null;
  }

  return null; // Workday and everything else: no bulk win, skip.
}

// ---------------------------------------------------------------- board fetchers

/** Fetch every posting for one board. Returns Map<jobId, {title, location, text}>. */
async function fetchBoard(provider, slug, eu = false) {
  const out = new Map();

  if (provider === 'greenhouse') {
    const host = eu ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
    const data = await getJson(`https://${host}/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
    for (const j of data.jobs ?? []) {
      out.set(String(j.id), {
        title: j.title ?? '',
        location: j.location?.name ?? '',
        text: htmlToText(String(j.content ?? '')),
      });
    }
    return out;
  }

  if (provider === 'ashby') {
    const data = await getJson(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    );
    for (const j of data.jobs ?? []) {
      // descriptionPlain is already clean text — no HTML round-trip needed.
      const text = j.descriptionPlain?.trim()
        ? String(j.descriptionPlain)
        : htmlToText(String(j.descriptionHtml ?? ''));
      out.set(String(j.id), { title: j.title ?? '', location: j.location ?? '', text });
    }
    return out;
  }

  if (provider === 'lever') {
    const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    for (const j of data ?? []) {
      const text = j.descriptionPlain?.trim()
        ? String(j.descriptionPlain)
        : htmlToText(String(j.description ?? ''));
      out.set(String(j.id), { title: j.text ?? '', location: j.categories?.location ?? '', text });
    }
    return out;
  }

  throw new Error(`unsupported provider: ${provider}`);
}

// ---------------------------------------------------------------- input

function readUrls(file) {
  if (!existsSync(file)) {
    console.error(`fetch-jds: input not found: ${file}`);
    process.exit(1);
  }
  const raw = readFileSync(file, 'utf8');
  const urls = [];

  for (const line of raw.split('\n')) {
    // pipeline.md: "- [ ] <url> | Company | Role | ..."
    const md = line.match(/^-\s*\[\s*\]\s*(\S+)/);
    if (md) {
      urls.push(md[1]);
      continue;
    }
    // TSV: id \t url \t source \t notes
    const cols = line.split('\t');
    if (cols.length >= 2 && /^https?:\/\//.test(cols[1].trim())) urls.push(cols[1].trim());
  }
  return [...new Set(urls)];
}

// ---------------------------------------------------------------- main

async function main() {
  const urls = readUrls(INPUT);
  mkdirSync(OUT_DIR, { recursive: true });

  /** @type {Map<string, {provider:string,slug:string,eu:boolean,items:{url:string,jobId:string}[]}>} */
  const boards = new Map();
  const skipped = [];

  for (const url of urls) {
    const p = parseJobUrl(url);
    if (!p) {
      skipped.push(url);
      continue;
    }
    const key = `${p.provider}:${p.slug}:${p.eu ? 'eu' : ''}`;
    if (!boards.has(key)) {
      boards.set(key, { provider: p.provider, slug: p.slug, eu: !!p.eu, items: [] });
    }
    boards.get(key).items.push({ url, jobId: p.jobId });
  }

  const written = [];
  const missed = [];
  const errors = [];
  const manifest = [];

  for (const [, b] of boards) {
    let postings;
    try {
      postings = await fetchBoard(b.provider, b.slug, b.eu);
    } catch (err) {
      errors.push({ board: `${b.provider}/${b.slug}`, error: String(err.message ?? err), roles: b.items.length });
      continue;
    }

    for (const { url, jobId } of b.items) {
      const post = postings.get(String(jobId));
      if (!post || !post.text) {
        missed.push(url);
        continue;
      }
      const file = join(OUT_DIR, `${safe(b.provider)}-${safe(b.slug)}-${safe(jobId)}.md`);
      if (!existsSync(file) || FORCE) {
        writeFileSync(
          file,
          `# ${post.title}\n\n**Location:** ${post.location}\n**URL:** ${url}\n\n---\n\n${post.text}\n`,
        );
      }
      written.push({ url, file, chars: post.text.length });
      manifest.push(`${url}\t${file}`);
    }
  }

  if (manifest.length) writeFileSync(join(OUT_DIR, 'index.tsv'), `url\tfile\n${manifest.join('\n')}\n`);

  const totalChars = written.reduce((a, w) => a + w.chars, 0);
  const result = {
    input: INPUT,
    urls: urls.length,
    boards: boards.size,
    requests: boards.size, // one per board — the whole point
    written: written.length,
    missed: missed.length,
    skipped: skipped.length,
    errors,
    approxTokens: Math.round(totalChars / 4),
  };

  if (SUMMARY) {
    console.log('\n=== fetch-jds ===');
    console.log(`  input:        ${INPUT}`);
    console.log(`  urls:         ${urls.length}`);
    console.log(`  boards:       ${boards.size}  (${boards.size} HTTP requests total)`);
    console.log(`  JDs written:  ${written.length}  -> ${OUT_DIR}/`);
    console.log(`  not on board: ${missed.length}   (posting closed or id mismatch)`);
    console.log(`  skipped:      ${skipped.length}   (Workday/other — no bulk endpoint)`);
    if (errors.length) {
      console.log(`  board errors: ${errors.length}`);
      for (const e of errors) console.log(`    - ${e.board}: ${e.error} (${e.roles} roles)`);
    }
    console.log(`  JD text:      ~${result.approxTokens.toLocaleString()} tokens total, clean text`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error('fetch-jds failed:', err);
  process.exit(1);
});
