#!/usr/bin/env node
/**
 * company-funded.mjs — review-first discovery of recently funded companies
 *
 * Reads a small set of structured public feeds (TechCrunch, PR Newswire, The
 * Guardian, the Hacker News search API), extracts company names from funding
 * headlines, and prints a candidate list for a human to review. It never edits
 * workspace/search/portals.yml, never probes a company website, and never
 * calls a model. Zero tokens.
 *
 * The output is a suggestion list, not a decision: a headline saying a company
 * raised money says nothing about whether that company is hiring, whether the
 * role fits, or whether the company is real. Adding a candidate to the search
 * is a separate, deliberate step (`src/scan/discover-ats.mjs --write`, or the
 * follow-employers control in the local UI).
 *
 * Ported from upstream career-ops 7ab92ab (#2117). The extraction heuristics
 * and exclusion rules are the valuable part and are kept close to the original.
 * What is NOT ported is upstream's hand-rolled egress hardening (~200 lines of
 * private-IP parsing, redirect chasing and hostname checks around global
 * fetch): this fork routes every remote read through providers/_http.mjs, which
 * already pins DNS, re-validates each redirect hop, and bounds the response.
 *
 * Trust boundary: feed content is hostile input. Company names, titles and URLs
 * are pattern-extracted, length-bounded and escaped at render time, and an
 * evidence URL is kept only when its host is on the allowlist for the source it
 * claims to come from — a TechCrunch feed cannot hand us an evidence link
 * pointing anywhere else.
 *
 * Run: node src/scan/company-funded.mjs                    (JSON to stdout)
 *      node src/scan/company-funded.mjs --summary
 *      node src/scan/company-funded.mjs --months 6 --limit 30 --sort score
 *      node src/scan/company-funded.mjs --sources techcrunch,hn
 *      node src/scan/company-funded.mjs --write            (also save a report)
 *      node src/scan/company-funded.mjs --self-test
 *
 * Exit codes: 0 discovery completed (including "no candidates"), 1 invalid
 * arguments or a fatal runtime error.
 */

import { join } from 'path';
import { pathToFileURL } from 'url';

import { decodeEntities } from '../../providers/_html-entities.mjs';
import { BROWSER_LIKE_USER_AGENT, fetchJson, fetchText } from '../../providers/_http.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { ANALYSIS_REPORTS_DIR } from '#paths';

const DEFAULT_LIMIT = 20;
const DEFAULT_MONTHS = 3;
const DEFAULT_SORT = 'date';
const DEFAULT_SOURCES = ['techcrunch', 'prnewswire', 'guardian', 'hn'];
const FEED_TIMEOUT_MS = 12_000;
const FEED_MAX_BYTES = 4 * 1024 * 1024;
const MAX_LIMIT = 200;
const MAX_MONTHS = 24;

const RSS_SOURCES = {
  techcrunch: [
    'https://techcrunch.com/feed/',
    'https://techcrunch.com/category/startups/feed/',
    'https://techcrunch.com/tag/funding/feed/',
  ],
  prnewswire: [
    'https://www.prnewswire.com/rss/news-releases-list.rss',
    'https://www.prnewswire.com/rss/venture-capital-list.rss',
  ],
  guardian: ['https://www.theguardian.com/technology/rss'],
};

// Host allowlist per source. An evidence URL is kept only if its host matches
// the source it is attributed to, so a compromised or mischievous feed cannot
// smuggle a link to an unrelated host into the report.
const SOURCE_HOSTS = {
  techcrunch: ['techcrunch.com'],
  prnewswire: ['prnewswire.com'],
  guardian: ['theguardian.com'],
  hacker_news: ['hn.algolia.com', 'news.ycombinator.com'],
};

const SOURCE_RANK = {
  techcrunch: 70,
  prnewswire: 65,
  guardian: 50,
  hacker_news: 35,
  web: 5,
};

// Names a headline yields often enough to be worth rejecting outright: the
// pattern matched, but what it captured is a category, a publisher, or a piece
// of the sentence rather than a company.
const GENERIC_NAMES = new Set([
  'ai', 'startup', 'startups', 'company', 'companies', 'founder', 'founders',
  'developer', 'developers', 'edtech platform', 'fintech platform',
  'healthcare platform', 'security platform', 'techcrunch', 'pr newswire',
  'business wire', 'globenewswire', 'crunchbase', 'hacker news', 'valuation',
  'valuations', 'bubble', 'fears', 'funding', 'fund', 'round',
]);

/* ------------------------------------------------------------------ CLI */

function usage() {
  console.log(`Usage:
  node src/scan/company-funded.mjs [options]

Options:
  --limit <n>          Max companies in the review list (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.
  --months <n>         Recent-funding window in months (1-${MAX_MONTHS}). Default: ${DEFAULT_MONTHS}.
  --sort <date|score>  Candidate ordering. Default: ${DEFAULT_SORT}.
  --sources <csv>      Sources. Default: ${DEFAULT_SOURCES.join(',')}.
  --summary            Human-readable output instead of JSON.
  --write              Also save JSON + Markdown under workspace/reports/analysis/.
  --self-test          Run the offline self-test.
  --help               Show this message.
`);
}

class UsageError extends Error {}

function parseSources(value) {
  const names = String(value || '')
    .split(',')
    .map((part) => normalizeSourceName(part))
    .filter(Boolean);
  const unknown = names.filter((name) => !['techcrunch', 'prnewswire', 'guardian', 'hn'].includes(name));
  if (unknown.length) throw new UsageError(`unknown source(s): ${unknown.join(', ')}`);
  if (!names.length) throw new UsageError('--sources needs at least one source');
  return [...new Set(names)];
}

function normalizeSourceName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name === 'hacker_news' || name === 'hackernews' || name === 'hn') return 'hn';
  return name;
}

function positiveInt(raw, flag, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new UsageError(`${flag} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function parseArgs(argv) {
  const opts = {
    limit: DEFAULT_LIMIT,
    months: DEFAULT_MONTHS,
    sort: DEFAULT_SORT,
    sources: [...DEFAULT_SOURCES],
    summary: false,
    write: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') opts.summary = true;
    else if (arg === '--write') opts.write = true;
    else if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--limit') opts.limit = positiveInt(argv[++i], '--limit', MAX_LIMIT);
    else if (arg === '--months') opts.months = positiveInt(argv[++i], '--months', MAX_MONTHS);
    else if (arg === '--sort') {
      const sort = String(argv[++i] || '').trim().toLowerCase();
      if (sort !== 'date' && sort !== 'score') throw new UsageError('--sort must be date or score');
      opts.sort = sort;
    } else if (arg === '--sources') opts.sources = parseSources(argv[++i]);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

/* -------------------------------------------------------------- text utils */

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function cdataValue(text) {
  const match = String(text || '').match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return match ? match[1] : text;
}

function xmlText(text) {
  return compact(decodeEntities(cdataValue(String(text || ''))));
}

export function matchesDomain(hostname, domain) {
  const host = String(hostname || '').toLowerCase();
  const suffix = String(domain || '').toLowerCase();
  return host === suffix || host.endsWith(`.${suffix}`);
}

function parseHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

/** The source a URL belongs to, or '' when it is on no allowlist. */
export function sourceFromUrl(raw) {
  const url = parseHttpUrl(raw);
  if (!url) return '';
  for (const [source, domains] of Object.entries(SOURCE_HOSTS)) {
    if (domains.some((domain) => matchesDomain(url.hostname, domain))) return source;
  }
  return '';
}

/**
 * An evidence URL is kept only when its host is on the allowlist for the
 * source the item claims to come from. Anything else is dropped rather than
 * downgraded, because a report line without a link is honest and a report line
 * linking somewhere unexpected is not.
 */
export function trustedEvidenceUrl(raw, source) {
  const url = parseHttpUrl(raw);
  if (!url) return '';
  const derived = sourceFromUrl(url.href);
  if (!derived) return '';
  if (source && derived !== source) return '';
  return url.href;
}

/** The feed URLs this script fetches are constants, but assert that anyway. */
function assertAllowedFeedUrl(url, source) {
  if (!trustedEvidenceUrl(url, source)) {
    throw new Error(`feed URL is not on the ${source} allowlist: ${url}`);
  }
}

/* ------------------------------------------------- company-name extraction */

function stripPublisher(title) {
  return compact(title)
    .replace(/\s+\|\s+.*$/i, '')
    .replace(/\s+-\s+(TechCrunch|Crunchbase|Forbes|Reuters|Bloomberg|BusinessWire|PR Newswire|SiliconANGLE|VentureBeat|The Guardian).*$/i, '')
    .replace(/^Show HN:\s*/i, '')
    .replace(/^Ask HN:\s*/i, '');
}

export function cleanCompanyName(raw) {
  let s = stripPublisher(xmlText(raw))
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/'s$/i, '')
    .replace(/’s$/i, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s*,.*$/g, '')
    .trim();

  const afterStartup = s.match(/\bstartup\s+(.+)$/i);
  if (afterStartup?.[1]) s = afterStartup[1].trim();
  // "<person>'s startup" and "<person>'s AI company" name a founder, not a
  // company. Dropping them is the difference between a review list and a list
  // of people's names.
  if (/\bstartup$/i.test(s) && /['’]s\b/i.test(s)) return '';
  if (/['’]s\b.*\b(company|startup)\b/i.test(s)) return '';
  s = s.replace(/\s+in talks to$/i, '');
  s = s.replace(/\s+reportedly$/i, '');
  s = s.replace(/\s+defies\s+.+$/i, '');
  s = s.replace(/^[A-Z][A-Za-z0-9&.-]+-backed\s+/i, '');
  s = s.replace(/\b(?:maker|creator)\s+of\s+.+$/i, '');
  s = s.replace(/^(?:the\s+)?(?:(?:ai|genai|agentic|coding|developer tools|developer|data|security|fintech|startup|software|robotics|defense|healthcare|biotech|open-source|enterprise|infrastructure|crypto|climate)\s+)+(?:startup|company|platform)?\s+/i, '');
  s = s.replace(/^.+\bmaker\s+/i, '');
  s = s.replace(/^(?:startup|company|platform)\s+/i, '');
  s = compact(s);

  if (s.length < 2 || s.length > 70) return '';
  if (/[<>]/.test(s)) return '';
  // A headline about a person who raised money ("Repeat founder Ryan Williams
  // raises $10M seed for an AI startup...") names the founder, not the company.
  // Upstream's guard only catches the possessive form, so the person's name
  // ends up in the review list as an employer to follow.
  // The optional middle token covers "Ex-Google exec ..." and "Former Stripe
  // founder ...", where the descriptor is not the first word.
  if (/^(?:(?:repeat|serial|ex|former|veteran)[\s-]+)?(?:[\w&.-]+\s+)?(?:co-)?(?:founder|founders|entrepreneur|investor|exec|executive|alum|alumni|duo|trio|team)\b/i.test(s)) return '';
  if (GENERIC_NAMES.has(s.toLowerCase())) return '';
  if (/^(ai|genai|agentic|edtech|fintech|security|healthcare|biotech|robotics|climate|crypto|developer tools?)\s+(startup|company|platform)$/i.test(s)) return '';
  if (/\b(valuation|valuations|bubble|fears|earnings|fund)\b/i.test(s)) return '';
  if (!/[a-z0-9]/i.test(s)) return '';
  return s;
}

export function extractCompanyFromFundingTitle(title) {
  let t = stripPublisher(xmlText(title));
  if (/^(ask hn|tell hn|who is hiring|launch hn)\b/i.test(t)) return '';
  // A leading scene-setting clause ("Fresh off its Wiz payout, Index Ventures
  // raises...") otherwise becomes the company name, because the sentence-initial
  // patterns below capture everything up to the funding verb. Drop it only when
  // the remainder still carries the funding language, so a company name that
  // legitimately contains a comma is untouched.
  const afterClause = t.match(/^[^,]{1,80},\s+(.+)$/)?.[1];
  if (afterClause && hasFundingLanguage(afterClause)) t = afterClause;

  const patterns = [
    /\b(?:raises?|raised|lands|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged)\s+(?:an?\s+|over\s+|more\s+than\s+|up\s+to\s+)?\$[\d.,]+\s*(?:billion|million|bn|[bkmt])?\s+for\s+(?:an?\s+)?(?:ai\s+)?startup\s+(.+?)$/i,
    /\bstartup\s+(.+?)\s+(?:reportedly\s+)?(?:raises?|raised|lands|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged)\b/i,
    /(?:startup|company|agency|platform)\s+(.+?)\s+hits\s+unicorn\s+status\b.*\braises?\b/i,
    /^(.+?)\s+(?:raises?|raised|lands|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged)\s+(?:an?\s+|over\s+|more\s+than\s+|up\s+to\s+)?\$[\d.,]+\s*(?:billion|million|bn|[bkmt])?\b/i,
    /^(.+?)\s+(?:raises?|raised|lands|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged)\s+(?:an?\s+)?(?:\w+\s+){0,4}(?:funding|round|series\s+[a-h]|seed|pre-seed|investment|financing|valuation)\b/i,
    /^(.+?)\s+(?:announces?|announced)\s+(?:\$[\d.,]+\s*(?:billion|million|bn|[bkmt])?\s+)?(?:\w+\s+){0,4}(?:funding|round|series\s+[a-h]|seed|pre-seed|financing)\b/i,
    /^(.+?)\s+(?:gets|got|receives?|received)\s+(?:\$[\d.,]+\s*(?:billion|million|bn|[bkmt])?\s+)?(?:in\s+)?(?:funding|investment|financing)\b/i,
    /^(.+?)\s+(?:hits?|hit|reaches?|reached)\s+(?:a\s+)?\$[\d.,]+(?:\.\d+)?\s*(?:billion|million|bn|[bkmt])?\s+valuation\b/i,
    /^(.+?)\s+valued\s+at\s+\$[\d.,]+(?:\.\d+)?\s*(?:billion|million|bn|[bkmt])?\b/i,
    /^(.+?)\s+emerges? from stealth\b/i,
    /^(.+?)\s+in\s+talks\s+to\s+raise\b/i,
  ];

  for (const re of patterns) {
    const match = t.match(re);
    if (match?.[1]) return cleanCompanyName(match[1]);
  }
  return '';
}

export function extractFundingDetails(text) {
  const raw = xmlText(text);
  const amount = raw.match(/\$[\d,.]+(?:\.\d+)?\s*(?:billion|million|bn|m|b|k)?/i)?.[0] || '';
  const round = raw.match(/\b(?:pre-seed|seed|series\s+[a-h]|strategic|venture|growth)\b/i)?.[0] || '';
  return {
    amount: compact(amount),
    round: round ? round.replace(/\s+/g, ' ').replace(/\bseries\b/i, 'Series') : '',
  };
}

function companyKey(name) {
  return compact(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/* --------------------------------------------------------------- feed read */

function diagnostic(source) {
  return {
    source,
    status: 'ok',
    fetched_items: 0,
    funding_like_items: 0,
    candidate_count: 0,
    blocked: false,
    errors: [],
  };
}

function markDiagnosticError(diag, message, { blocked = false } = {}) {
  if (!message) return;
  diag.errors.push(message);
  if (blocked) diag.blocked = true;
  if (diag.status !== 'blocked') diag.status = blocked ? 'blocked' : 'error';
}

/**
 * A CDN challenge page answers 200 with HTML that parses to zero items, which
 * would otherwise read as "this source had no funding news today". Naming it as
 * blocked is the difference between a quiet false negative and a diagnosable
 * one.
 */
export function detectBlockedContent(text) {
  const raw = String(text || '').slice(0, 20_000);
  if (!/<html/i.test(raw)) return false;
  return /\b(access denied|captcha|cloudflare|attention required|verify you are human|enable javascript|unusual traffic|temporarily blocked|bot detection|ddos-guard|akamai|perimeterx)\b/i.test(raw);
}

function tagValue(xml, names) {
  for (const name of names) {
    const escaped = name.replace(':', '\\:');
    const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const match = String(xml || '').match(re);
    if (match?.[1]) return xmlText(match[1]);
  }
  return '';
}

function attrValue(xml, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, 'i');
  return xmlText(String(xml || '').match(re)?.[1] || '');
}

function categoriesFromXml(xml) {
  return [...String(xml || '').matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)]
    .map((match) => xmlText(match[1]))
    .filter(Boolean);
}

function parsePublishedDate(value) {
  const raw = compact(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return { value: date.toISOString().slice(0, 10), precision: 'day', date };
}

export function parseRssItems(xml, { source = '' } = {}) {
  const out = [];
  const raw = String(xml || '');
  const blocks = [
    ...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...raw.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];
  for (const blockMatch of blocks) {
    const block = blockMatch[1];
    const title = tagValue(block, ['title']);
    const description = tagValue(block, ['description', 'summary', 'content:encoded', 'content']);
    const link = compact(tagValue(block, ['link'])) || attrValue(block, 'link', 'href');
    const observedDate = parsePublishedDate(tagValue(block, ['pubDate', 'published', 'updated', 'dc:date']));
    const sourceCompany = tagValue(block, ['dc:contributor', 'dc:creator', 'author', 'source']);
    if (!title && !link) continue;
    out.push({
      source,
      title,
      url: trustedEvidenceUrl(link, source),
      published_at: observedDate?.date?.toISOString() || '',
      observedDate,
      text: compact(`${title} ${description}`),
      categories: categoriesFromXml(block),
      source_company: sourceCompany,
    });
  }
  return out;
}

function hasFundingLanguage(text) {
  return /\b(funding|funded|raises?|raised|raise|series\s+[a-h]|seed\s+round|pre-seed|venture\s+round|investment|financing|valuation|valued\s+at|lands?|landed|secures?|secured|closes?|closed|nabs?|nabbed|bags?|bagged|emerges?\s+from\s+stealth|in\s+talks\s+to\s+raise)\b/i.test(text);
}

/**
 * Rejects items that use funding vocabulary for something that is not a company
 * raising money: acquisitions, IPOs, a VC firm closing its own fund, grants, and
 * explainer articles about fundraising.
 */
export function isExcludedFundingItem(item) {
  const text = `${item.title || ''} ${item.text || ''} ${item.categories?.join(' ') || ''}`;
  const exclusions = [
    /\b(acquires?|acquired|acquisition|merger|spac|ipo|bankruptcy|layoffs?|cuts?\s+\d+%|earnings|quarterly results)\b/i,
    /\b(public offering|registered direct offering|private placement|atm offering|offering of common stock)\b/i,
    // A VC closing its own vehicle is not a company that just got funded.
    // Upstream matched only the singular "raises $X fund"; live TechCrunch
    // headlines say "raises $2B across three funds".
    /\b(?:raises?|raised|closes?|closed|lands?|landed|secures?|secured)\s+(?:an?\s+|its\s+|their\s+)?\$?[\d,.]+(?:\.\d+)?\s*(?:billion|million|bn|m|b|k)?\s+(?:across\s+)?(?:\w+\s+){0,2}funds?\b/i,
    /\bfor\s+(?:its|their|the)\s+(?:\w+\s+){0,2}funds?\b/i,
    /\b(venture fund|vc fund|investment fund|private equity fund|capital fund|fund ii|fund iii|fund iv|new fund)\b/i,
    /\b(grant|grants|scholarship|scholarships|award|awards|donation|donates?)\b/i,
    /\b(how to raise|ways to raise|guide to fundraising|startup valuations|bubble fears)\b/i,
  ];
  if (exclusions.some((re) => re.test(text))) return true;
  return !hasFundingLanguage(text);
}

function inferredDateFromText(text, now) {
  const raw = String(text || '');
  const year = raw.match(/\b(20\d{2})\b/)?.[1];
  if (year) {
    const currentYear = now.getUTCFullYear();
    const date = Number(year) === currentYear ? new Date(now.getTime()) : new Date(`${year}-01-01T00:00:00Z`);
    return { value: String(year), precision: 'year', date };
  }
  return { value: now.toISOString().slice(0, 10), precision: 'observed', date: now };
}

function bestObservedDate(item, now) {
  if (item.observedDate?.date instanceof Date && !Number.isNaN(item.observedDate.date.getTime())) return item.observedDate;
  if (item.published_at) {
    const parsed = parsePublishedDate(item.published_at);
    if (parsed) return parsed;
  }
  return inferredDateFromText(`${item.title || ''} ${item.text || ''}`, now);
}

function withinMonths(date, months, now) {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return date >= cutoff && date <= now;
}

function confidenceFor(item, details) {
  const sourceStrong = ['techcrunch', 'prnewswire', 'guardian'].includes(item.source);
  const detailStrong = Boolean(details.amount || details.round);
  if (sourceStrong && detailStrong) return 'high';
  if (sourceStrong || detailStrong) return 'medium';
  return 'low';
}

function bestConfidence(a, b) {
  const rank = { low: 1, medium: 2, high: 3 };
  return rank[b] > rank[a] ? b : a;
}

function candidateFromItem(item, { now }) {
  if (isExcludedFundingItem(item)) return null;
  const observed = bestObservedDate(item, now);
  const details = extractFundingDetails(`${item.title || ''} ${item.text || ''}`);
  // PR Newswire releases name the issuing company in a metadata field, which is
  // more reliable than the headline. No other source's author field is a company.
  const sourceCompany = item.source === 'prnewswire' ? cleanCompanyName(item.source_company || '') : '';
  const company = extractCompanyFromFundingTitle(item.title) || sourceCompany;
  if (!company) return null;
  return {
    company,
    amount: details.amount,
    round: details.round,
    source: item.source || '',
    title: compact(item.title || ''),
    url: trustedEvidenceUrl(item.url || '', item.source || ''),
    observedDate: observed,
    confidence: confidenceFor(item, details),
  };
}

export function buildCandidates(items, {
  months = DEFAULT_MONTHS,
  sort = DEFAULT_SORT,
  limit = DEFAULT_LIMIT,
  now = new Date(),
  diagnostics = [],
} = {}) {
  const grouped = new Map();
  for (const item of items || []) {
    const candidate = candidateFromItem(item, { now });
    if (!candidate) continue;
    if (!withinMonths(candidate.observedDate.date, months, now)) continue;
    const key = companyKey(candidate.company);
    if (!key) continue;
    const current = grouped.get(key) || {
      company: candidate.company,
      amount: '',
      round: '',
      funding: { status: 'recent_funding', confidence: 'low', sources: [] },
      discovery_score: 0,
      suggested_action: 'review_company_manually',
    };
    if (!current.amount && candidate.amount) current.amount = candidate.amount;
    if (!current.round && candidate.round) current.round = candidate.round;
    const evidence = {
      source: candidate.source,
      title: candidate.title,
      url: candidate.url,
      observed_date: candidate.observedDate.value,
      date_precision: candidate.observedDate.precision,
    };
    const evidenceKey = `${evidence.source}\n${evidence.title}\n${evidence.url}\n${evidence.observed_date}`;
    const duplicate = current.funding.sources.some(
      (src) => `${src.source}\n${src.title}\n${src.url}\n${src.observed_date}` === evidenceKey,
    );
    if (!duplicate) {
      current.funding.sources.push(evidence);
      const sourceRank = SOURCE_RANK[candidate.source] || SOURCE_RANK.web;
      const detailBonus = (candidate.amount ? 10 : 0) + (candidate.round ? 8 : 0);
      const confidenceBonus = candidate.confidence === 'high' ? 15 : candidate.confidence === 'medium' ? 8 : 0;
      current.discovery_score += sourceRank + detailBonus + confidenceBonus;
      current.funding.confidence = bestConfidence(current.funding.confidence, candidate.confidence);
    }
    grouped.set(key, current);
  }

  const candidates = [...grouped.values()].map((candidate) => {
    candidate.funding.sources.sort((a, b) => String(b.observed_date || '').localeCompare(String(a.observed_date || '')));
    return candidate;
  });

  candidates.sort((a, b) => {
    if (sort === 'score') return b.discovery_score - a.discovery_score || a.company.localeCompare(b.company);
    const ad = a.funding.sources[0]?.observed_date || '';
    const bd = b.funding.sources[0]?.observed_date || '';
    return bd.localeCompare(ad) || b.discovery_score - a.discovery_score || a.company.localeCompare(b.company);
  });
  const finalCandidates = candidates.slice(0, limit);

  for (const diag of diagnostics) {
    const name = sourceNameForDiagnostic(diag.source);
    diag.candidate_count = finalCandidates.filter((c) => c.funding.sources.some((s) => s.source === name)).length;
  }

  return finalCandidates;
}

function sourceNameForDiagnostic(source) {
  return source === 'hn' ? 'hacker_news' : source;
}

const FEED_HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  accept: 'application/rss+xml,application/xml,text/xml,application/json,text/plain,*/*',
};

function defaultHttp() {
  return {
    fetchText: (url) => fetchText(url, {
      timeoutMs: FEED_TIMEOUT_MS,
      maxResponseBytes: FEED_MAX_BYTES,
      headers: FEED_HEADERS,
      redirect: 'follow',
    }),
    fetchJson: (url) => fetchJson(url, {
      timeoutMs: FEED_TIMEOUT_MS,
      maxResponseBytes: FEED_MAX_BYTES,
      headers: FEED_HEADERS,
      redirect: 'follow',
    }),
  };
}

async function fetchRssDiscovery(source, diagnostics, http) {
  const diag = diagnostics.find((d) => d.source === source) || diagnostic(source);
  const out = [];
  for (const url of RSS_SOURCES[source] || []) {
    assertAllowedFeedUrl(url, source);
    let text = '';
    try {
      text = await http.fetchText(url);
    } catch (err) {
      markDiagnosticError(diag, `${url}: ${err?.message || 'fetch failed'}`);
      continue;
    }
    if (detectBlockedContent(text)) {
      markDiagnosticError(diag, `${url}: blocked/challenge page`, { blocked: true });
      continue;
    }
    const items = parseRssItems(text, { source });
    diag.fetched_items += items.length;
    for (const item of items) {
      if (isExcludedFundingItem(item)) continue;
      diag.funding_like_items += 1;
      out.push(item);
    }
  }
  if (diag.fetched_items === 0 && diag.errors.length === 0) markDiagnosticError(diag, 'no RSS items fetched');
  return out;
}

const HN_QUERIES = [
  'AI startup raises funding',
  'Series A AI startup',
  'developer tools startup funding',
  'infrastructure startup raises funding',
  'agentic AI raises seed',
];

async function fetchHnDiscovery({ months, diagnostics, http, now }) {
  const diag = diagnostics.find((d) => d.source === 'hn') || diagnostic('hn');
  const cutoff = Math.floor(now.getTime() / 1000) - months * 31 * 24 * 60 * 60;
  const out = [];
  for (const query of HN_QUERIES) {
    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
      `&tags=story&hitsPerPage=50&numericFilters=created_at_i>${cutoff}`;
    assertAllowedFeedUrl(url, 'hacker_news');
    let json = null;
    try {
      json = await http.fetchJson(url);
    } catch (err) {
      markDiagnosticError(diag, `${url}: ${err?.message || 'fetch failed'}`);
      continue;
    }
    const hits = Array.isArray(json?.hits) ? json.hits : [];
    diag.fetched_items += hits.length;
    for (const hit of hits) {
      const title = compact(hit.title || hit.story_title || '');
      if (!title) continue;
      const fallbackUrl = `https://news.ycombinator.com/item?id=${encodeURIComponent(String(hit.objectID || ''))}`;
      const item = {
        source: 'hacker_news',
        title: xmlText(title),
        // A submitted story usually links off-site, and off-site is by
        // definition not on the allowlist, so fall back to the HN item page.
        url: trustedEvidenceUrl(hit.url || '', 'hacker_news') || trustedEvidenceUrl(fallbackUrl, 'hacker_news'),
        // Both date fields go through the one validating parser. Constructing
        // a Date straight from remote text and calling .toISOString() on it
        // throws RangeError for anything unparseable, which would take the
        // whole run down over one malformed record — the opposite of the
        // per-source diagnostics this module is built around. An unusable
        // date is not fatal: bestObservedDate() falls back to the item text.
        published_at: parsePublishedDate(hit.created_at)?.date?.toISOString() || '',
        observedDate: parsePublishedDate(hit.created_at),
        text: xmlText(hit.story_text || ''),
        categories: [],
        source_company: '',
      };
      if (isExcludedFundingItem(item)) continue;
      diag.funding_like_items += 1;
      out.push(item);
    }
  }
  if (diag.fetched_items === 0 && diag.errors.length === 0) markDiagnosticError(diag, 'no HN items fetched');
  return out;
}

async function collectDiscoveryItems({ sources, months, http, now, diagnostics }) {
  const requested = new Set(sources);
  const hits = [];
  for (const source of ['techcrunch', 'prnewswire', 'guardian']) {
    if (requested.has(source)) hits.push(...await fetchRssDiscovery(source, diagnostics, http));
  }
  if (requested.has('hn')) hits.push(...await fetchHnDiscovery({ months, diagnostics, http, now }));
  return hits;
}

/* ----------------------------------------------------------------- output */

function markdownText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\r?\n/g, ' ');
}

function safeReportUrl(value) {
  const url = parseHttpUrl(value);
  if (!url) return '';
  return url.href.replace(/[<>\s]/g, encodeURIComponent);
}

export function renderReport(result) {
  const lines = [];
  lines.push(`# Funded Company Discovery — ${markdownText(result.generated_at)}`);
  lines.push('');
  lines.push('Review-first output. Nothing was added to workspace/search/portals.yml and no company website was probed. A funding headline is not evidence that the company is hiring.');
  lines.push('');
  lines.push(`Window: ${result.window_months} months`);
  lines.push(`Sort: ${markdownText(result.sort)}`);
  lines.push(`Sources: ${result.sources.map(markdownText).join(', ')}`);
  lines.push(`Candidates: ${result.companies.length}`);
  lines.push('');
  lines.push('## Source health');
  lines.push('');
  lines.push('| Source | Status | Fetched | Funding-like | Candidates | Notes |');
  lines.push('|--------|--------|---------|--------------|------------|-------|');
  for (const diag of result.diagnostics) {
    lines.push(`| ${markdownText(diag.source)} | ${markdownText(diag.status)} | ${diag.fetched_items} | ${diag.funding_like_items} | ${diag.candidate_count} | ${markdownText(diag.errors.join('; '))} |`);
  }
  lines.push('');
  lines.push('## Candidates');
  lines.push('');
  lines.push('| # | Company | Funding | Date | Source | Action |');
  lines.push('|---|---------|---------|------|--------|--------|');
  result.companies.forEach((candidate, idx) => {
    const src = candidate.funding.sources?.[0] || {};
    const funding = [candidate.round, candidate.amount, candidate.funding.status].filter(Boolean).join(' / ');
    lines.push(`| ${idx + 1} | ${markdownText(candidate.company)} | ${markdownText(funding)} | ${markdownText(src.observed_date || '')} | ${markdownText(src.source || '')} | ${markdownText(candidate.suggested_action)} |`);
  });
  lines.push('');
  for (const candidate of result.companies) {
    lines.push(`### ${markdownText(candidate.company)}`);
    lines.push('');
    lines.push(`- Funding signal: ${markdownText(candidate.funding.status)} (${markdownText(candidate.funding.confidence)})`);
    if (candidate.round || candidate.amount) {
      lines.push(`- Round/amount: ${markdownText([candidate.round, candidate.amount].filter(Boolean).join(', '))}`);
    }
    lines.push(`- Suggested action: ${markdownText(candidate.suggested_action)}`);
    lines.push('- Evidence:');
    for (const src of candidate.funding.sources.slice(0, 3)) {
      const url = safeReportUrl(src.url);
      const suffix = url ? ` — ${url}` : '';
      lines.push(`  - ${markdownText(src.source)}${src.observed_date ? `, ${markdownText(src.observed_date)}` : ''}: ${markdownText(src.title)}${suffix}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// Both artifacts go through the canonical atomic-replacement boundary rather
// than a bare write: a re-run on the same day overwrites the previous pair, and
// a half-written report is exactly the kind of file someone would read and act
// on. replaceFileAtomic also creates the parent directory.
function writeArtifacts(result) {
  const jsonPath = join(ANALYSIS_REPORTS_DIR, `funded-companies-${result.generated_at}.json`);
  const reportPath = join(ANALYSIS_REPORTS_DIR, `funded-companies-${result.generated_at}.md`);
  replaceFileAtomic(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  replaceFileAtomic(reportPath, renderReport(result));
  return { json: jsonPath, report: reportPath };
}

function printSummary(result) {
  console.log('='.repeat(78));
  console.log('  Funded Company Discovery — Frontrunner');
  console.log(`  ${result.generated_at} | window: ${result.window_months} months | sort: ${result.sort}`);
  console.log(`  sources: ${result.sources.join(', ')} | candidates: ${result.companies.length}`);
  console.log('='.repeat(78));
  console.log('');
  const unhealthy = result.diagnostics.filter((d) => d.status !== 'ok' || d.blocked || d.fetched_items === 0);
  if (unhealthy.length || result.companies.length === 0) {
    console.log('  Source health:');
    for (const diag of result.diagnostics) {
      const note = diag.errors.length ? ` — ${diag.errors.join('; ')}` : '';
      console.log(`    ${diag.source}: ${diag.status}, fetched ${diag.fetched_items}, funding-like ${diag.funding_like_items}, candidates ${diag.candidate_count}${note}`);
    }
    console.log('');
  }
  if (!result.companies.length) {
    console.log('  No candidates in this window.');
    return;
  }
  for (const [idx, candidate] of result.companies.entries()) {
    const src = candidate.funding.sources?.[0] || {};
    console.log(`  ${idx + 1}. ${candidate.company}`);
    console.log(`     funding: ${[candidate.round, candidate.amount, candidate.funding.status].filter(Boolean).join(' / ')} (${candidate.funding.confidence})${src.observed_date ? `, ${src.observed_date}` : ''}`);
    console.log(`     source:  ${src.source || 'n/a'} — ${src.title || 'n/a'}`);
    console.log(`     link:    ${src.url || 'n/a'}`);
    console.log('');
  }
  console.log('  Review each candidate before adding it to your search. A funding');
  console.log('  headline says nothing about open roles or fit.');
  if (result.artifacts) {
    console.log('');
    console.log(`  JSON:   ${result.artifacts.json}`);
    console.log(`  Report: ${result.artifacts.report}`);
  }
}

export async function discoverFundedCompanies(opts = {}) {
  const months = opts.months || DEFAULT_MONTHS;
  const sort = opts.sort || DEFAULT_SORT;
  const sources = [...new Set((opts.sources || DEFAULT_SOURCES).map(normalizeSourceName))];
  const now = opts.now instanceof Date ? opts.now : new Date();
  const diagnostics = sources.map(diagnostic);
  const items = Array.isArray(opts.discoveryItems)
    ? opts.discoveryItems
    : await collectDiscoveryItems({
      sources,
      months,
      now,
      diagnostics,
      http: opts.http || defaultHttp(),
    });
  const companies = buildCandidates(items, {
    months,
    sort,
    limit: opts.limit || DEFAULT_LIMIT,
    now,
    diagnostics,
  });

  return {
    generated_at: now.toISOString().slice(0, 10),
    window_months: months,
    sort,
    sources,
    diagnostics,
    companies,
  };
}

/* -------------------------------------------------------------- self-test */

async function selfTest() {
  const failures = [];
  const eq = (label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };

  for (const [title, expected] of [
    ['Prime Intellect raises $130M Series A', 'Prime Intellect'],
    ['AI coding startup Cursor maker Anysphere raises Series C funding', 'Anysphere'],
    ['Ex-DeepMind David Silver Raises $1.1B for AI Startup Ineffable', 'Ineffable'],
    ['Travis Kalanick&#8217;s robotics company raises $1.7B, led by a16z', ''],
    ['AI startup valuations raise bubble fears as funding surges', ''],
    ["Yann LeCun's AI startup raises $1B seed round", ''],
    ['Acme closes $25M Series A round', 'Acme'],
    ['Ask HN: Who is hiring?', ''],
    // Live TechCrunch headlines that upstream's heuristics mis-read.
    ['Repeat founder Ryan Williams raises $10M seed for an AI startup for private credit managers', ''],
    ['Fresh off its Wiz payout, Index Ventures raises $2B across three funds', 'Index Ventures'],
    ['Synthetic-user startup Simile raises $200M at $2B valuation', 'Simile'],
  ]) {
    eq(`extractCompanyFromFundingTitle(${JSON.stringify(title)})`, extractCompanyFromFundingTitle(title), expected);
  }

  eq('extractFundingDetails', extractFundingDetails('Acme closes $25M Series A round'), { amount: '$25M', round: 'Series A' });

  // A VC closing its own vehicle is not a funded company, however phrased.
  for (const title of [
    'Index Ventures raises $2B across three funds',
    'Convective Capital raises an $85 million fund to build disaster resilience',
    'Acme Capital raises $300M for its second fund',
  ]) {
    eq(`isExcludedFundingItem(${JSON.stringify(title)})`, isExcludedFundingItem({ title, text: title, categories: [] }), true);
  }
  eq('an ordinary round is not excluded', isExcludedFundingItem({ title: 'Acme raises $25M Series B', text: 'Acme raises $25M Series B', categories: [] }), false);

  eq('evidence URL off the allowlist is dropped', trustedEvidenceUrl('https://evil.example/post', 'techcrunch'), '');
  eq('evidence URL from the wrong source is dropped', trustedEvidenceUrl('https://techcrunch.com/x', 'guardian'), '');
  eq('evidence URL on the allowlist is kept', trustedEvidenceUrl('https://techcrunch.com/x', 'techcrunch'), 'https://techcrunch.com/x');

  const candidates = buildCandidates([
    {
      source: 'techcrunch',
      title: 'Acme raises $25M Series B',
      url: 'https://techcrunch.com/acme',
      observedDate: { value: '2026-06-10', precision: 'day', date: new Date('2026-06-10T00:00:00Z') },
      text: 'Acme raises $25M Series B funding.',
      categories: ['Startups'],
    },
    {
      source: 'hacker_news',
      title: 'Startup raises seed funding in March 2026',
      url: 'https://news.ycombinator.com/item?id=2',
      observedDate: { value: '2026-03-10', precision: 'day', date: new Date('2026-03-10T00:00:00Z') },
      text: '',
      categories: [],
    },
  ], { months: 3, now: new Date('2026-07-20T00:00:00Z') });
  eq('buildCandidates keeps the in-window named company only', candidates.map((c) => c.company), ['Acme']);

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    throw new Error(`company-funded self-test: ${failures.length} failure(s)`);
  }
  console.log('company-funded self-test OK');
}

/* ------------------------------------------------------------------- main */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`company-funded: ${err.message}`);
    usage();
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    usage();
    return;
  }
  if (opts.selfTest) {
    await selfTest();
    return;
  }
  const result = await discoverFundedCompanies(opts);
  if (opts.write) result.artifacts = writeArtifacts(result);
  if (opts.summary) printSummary(result);
  else console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`company-funded: ${err.message}`);
    process.exit(1);
  });
}
