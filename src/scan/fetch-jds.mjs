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
 *   node src/scan/fetch-jds.mjs                      # read workspace/search/pipeline.md pending URLs
 *   node src/scan/fetch-jds.mjs --input workspace/.state/batch-input.tsv
 *   node src/scan/fetch-jds.mjs --out jds --summary
 *   node src/scan/fetch-jds.mjs --json
 *
 * OUTPUT
 *   workspace/jobs/descriptions/{provider}-{slug}-{jobid}.md   one plain-text JD per role
 *   workspace/jobs/descriptions/index.tsv                      url -> file manifest (tab separated)
 *
 * Workday is deliberately NOT bulk-fetched: its per-tenant CXS endpoint needs
 * one request per job anyway, so there is no bulk win. Those URLs are reported
 * as `skipped` and the worker keeps its existing fallback path for them.
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { fetchJson as safeFetchJson } from '../../providers/_http.mjs';
import { normalizeJobText } from '../security/job-document.mjs';
import {
  publishJdCacheEntries,
  readJdManifest,
} from './jd-cache-store.mjs';
// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (f, dflt) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

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
  return safeFetchJson(url, {
    headers: { accept: 'application/json', 'user-agent': 'frontrunner/fetch-jds' },
    timeoutMs: 30_000,
    redirect: 'error',
    maxResponseBytes: 8 * 1024 * 1024,
  });
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
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  // Greenhouse: job-boards[.eu].greenhouse.io/{slug}/jobs/{id}
  //             boards.greenhouse.io/{slug}/jobs/{id}
  const greenhouseEu = host === 'job-boards.eu.greenhouse.io';
  if (
    host === 'job-boards.greenhouse.io'
    || greenhouseEu
    || host === 'boards.greenhouse.io'
  ) {
    const i = parts.indexOf('jobs');
    if (i > 0 && parts[i + 1]) {
      return { provider: 'greenhouse', slug: parts[i - 1], jobId: parts[i + 1], eu: greenhouseEu };
    }
    return null;
  }

  // Ashby: jobs.ashbyhq.com/{slug}/{uuid}
  if (host === 'jobs.ashbyhq.com') {
    if (parts.length >= 2) return { provider: 'ashby', slug: parts[0], jobId: parts[1] };
    return null;
  }

  // Lever: jobs.lever.co/{slug}/{uuid}
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (parts.length >= 2) return { provider: 'lever', slug: parts[0], jobId: parts[1] };
    return null;
  }

  return null; // Workday and everything else: no bulk win, skip.
}

// ---------------------------------------------------------------- board fetchers

/** Fetch every posting for one board. Returns Map<jobId, {title, location, text}>. */
async function fetchBoard(provider, slug, eu = false, fetchJson = getJson) {
  const out = new Map();

  if (provider === 'greenhouse') {
    const host = eu ? 'boards-api.eu.greenhouse.io' : 'boards-api.greenhouse.io';
    const data = await fetchJson(`https://${host}/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`);
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
    const data = await fetchJson(
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
    const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
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

/**
 * Fetch one clean description through the provider's public board API.
 * Returns null for unsupported providers or a posting no longer on the board,
 * allowing callers to use a browser strictly as the fallback.
 */
export async function fetchJobDescriptionViaApi(rawUrl, fetchJson = getJson) {
  const parsed = parseJobUrl(rawUrl);
  if (!parsed) return null;
  const postings = await fetchBoard(parsed.provider, parsed.slug, !!parsed.eu, fetchJson);
  const post = postings.get(String(parsed.jobId));
  if (!post?.text) return null;
  return {
    source: 'api',
    provider: parsed.provider,
    title: post.title,
    location: post.location,
    text: normalizeJobText(
      `# ${post.title}\n\n**Location:** ${post.location}\n**URL:** ${rawUrl}\n\n---\n\n${post.text}\n`,
    ),
  };
}

// ---------------------------------------------------------------- input

function readUrls(file) {
  if (!existsSync(file)) throw new Error(`fetch-jds: input not found: ${file}`);
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

/**
 * Fetch and persist JDs using explicit paths and an injectable JSON transport.
 * Existing valid manifest entries are merged so a transient board failure
 * cannot make already-cached JDs disappear from the batch pipeline.
 */
export async function runFetchJds({
  input,
  outDir,
  force = false,
  fetchJson = getJson,
  publishOptions = {},
}) {
  const urls = readUrls(input);
  mkdirSync(outDir, { recursive: true });
  const manifest = readJdManifest(outDir);

  /** @type {Map<string, {provider:string,slug:string,eu:boolean,items:{url:string,jobId:string}[]}>} */
  const boards = new Map();
  const skipped = [];
  const cached = [];

  for (const url of urls) {
    const cachedFile = manifest.get(url);
    if (!force && cachedFile && existsSync(cachedFile)) {
      const text = readFileSync(cachedFile, 'utf8');
      if (text.trim()) {
        cached.push({ url, file: cachedFile, chars: text.length });
        continue;
      }
    }
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
  const publications = [];
  const missed = [];
  const errors = [];

  for (const [, b] of boards) {
    let postings;
    try {
      postings = await fetchBoard(b.provider, b.slug, b.eu, fetchJson);
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
      const file = join(outDir, `${safe(b.provider)}-${safe(b.slug)}-${safe(jobId)}.md`);
      publications.push({
        url,
        name: `${safe(b.provider)}-${safe(b.slug)}-${safe(jobId)}.md`,
        content: normalizeJobText(
          `# ${post.title}\n\n**Location:** ${post.location}\n**URL:** ${url}\n\n---\n\n${post.text}`,
        ),
        overwrite: force,
      });
      written.push({ url, file, chars: post.text.length });
      manifest.set(url, file);
    }
  }

  if (publications.length) {
    await publishJdCacheEntries(outDir, publications, publishOptions);
  }

  const totalChars = [...cached, ...written].reduce((a, w) => a + w.chars, 0);
  const result = {
    input,
    urls: urls.length,
    boards: boards.size,
    requests: boards.size, // one per board — the whole point
    written: written.length,
    cached: cached.length,
    available: written.length + cached.length,
    missed: missed.length,
    skipped: skipped.length,
    errors,
    approxTokens: Math.round(totalChars / 4),
  };
  return result;
}

async function main() {
  if (hasFlag('-h') || hasFlag('--help')) {
    console.log(`fetch-jds.mjs — bulk JD pre-fetcher (zero LLM tokens)

Usage:
  node src/scan/fetch-jds.mjs [--input <file>] [--out <dir>] [--summary|--json] [--force]

  --input <file>  Source of URLs. Default: workspace/search/pipeline.md
                  Accepts pipeline.md ("- [ ] <url> | ...") or a TSV whose
                  second column is the URL (e.g. workspace/.state/batch-input.tsv).
  --out <dir>     Output directory. Default: workspace/jobs/descriptions
  --force         Re-fetch even if the JD file already exists.
  --summary       Human-readable table.
  --json          Machine-readable result (default).
`);
    return;
  }

  const input = resolve(ROOT, argVal('--input', 'workspace/search/pipeline.md'));
  const outDir = resolve(ROOT, argVal('--out', 'workspace/jobs/descriptions'));
  const force = hasFlag('--force');
  const summary = hasFlag('--summary');
  const result = await runFetchJds({ input, outDir, force });

  if (summary) {
    console.log('\n=== fetch-jds ===');
    console.log(`  input:        ${input}`);
    console.log(`  urls:         ${result.urls}`);
    console.log(`  boards:       ${result.boards}  (${result.requests} HTTP requests total)`);
    console.log(`  JDs available:${String(result.available).padStart(3)}  (${result.written} fetched, ${result.cached} cached) -> ${outDir}/`);
    console.log(`  not on board: ${result.missed}   (posting closed or id mismatch)`);
    console.log(`  skipped:      ${result.skipped}   (Workday/other — no bulk endpoint)`);
    if (result.errors.length) {
      console.log(`  board errors: ${result.errors.length}`);
      for (const e of result.errors) console.log(`    - ${e.board}: ${e.error} (${e.roles} roles)`);
    }
    console.log(`  JD text:      ~${result.approxTokens.toLocaleString()} tokens total, clean text`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  main().catch((err) => {
    console.error('fetch-jds failed:', err);
    process.exitCode = 1;
  });
}
