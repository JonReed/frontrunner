/**
 * company-funded.mjs — hostile-feed and review-first guarantees.
 *
 * Ported from upstream career-ops 7ab92ab (#2117). Upstream's own tests cover
 * the extraction heuristics; these cover the properties this fork adds and the
 * ones a careless edit would quietly break:
 *
 *   - every remote read goes through providers/_http.mjs (never global fetch),
 *   - an RSS feed cannot smuggle an evidence link to an unrelated host,
 *   - feed text reaches the rendered report escaped, so a headline cannot
 *     forge a table row or a link,
 *   - the script only ever suggests: no portals.yml write, no model call.
 *
 * A funding feed is remote content authored by strangers and it is rendered
 * into a Markdown file the user reads and clicks. That is the whole threat.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCandidates,
  cleanCompanyName,
  detectBlockedContent,
  discoverFundedCompanies,
  extractCompanyFromFundingTitle,
  isExcludedFundingItem,
  matchesDomain,
  parseArgs,
  parseRssItems,
  renderReport,
  sourceFromUrl,
  trustedEvidenceUrl,
} from '../../src/scan/company-funded.mjs';

const SOURCE = readFileSync(new URL('../../src/scan/company-funded.mjs', import.meta.url), 'utf-8');
const NOW = new Date('2026-07-20T00:00:00Z');

const item = (over = {}) => ({
  source: 'techcrunch',
  title: 'Acme raises $25M Series B',
  url: 'https://techcrunch.com/acme',
  observedDate: { value: '2026-07-10', precision: 'day', date: new Date('2026-07-10T00:00:00Z') },
  text: '',
  categories: [],
  source_company: '',
  ...over,
});

/* ------------------------------------------------------------ egress path */

test('the module never reaches the network except through providers/_http.mjs', () => {
  assert.match(SOURCE, /from '\.\.\/\.\.\/providers\/_http\.mjs'/);
  // A bare fetch( would bypass DNS pinning, the redirect re-validation and the
  // response cap that _http.mjs enforces. The allowed occurrences are the
  // fetchText/fetchJson imports and the wrappers that call them.
  const bare = [...SOURCE.matchAll(/(?<![.\w])fetch\s*\(/g)];
  assert.equal(bare.length, 0, 'global fetch( is forbidden in a provider/ingestion path');
  assert.doesNotMatch(SOURCE, /globalThis\.fetch|require\(['"]node-fetch/);
});

test('discovery with injected items performs no I/O at all', async () => {
  // The hermetic suite blocks outbound network; this asserts the injection
  // seam that makes the module testable stays wired to the same code path.
  const result = await discoverFundedCompanies({
    discoveryItems: [item()],
    now: NOW,
    http: {
      fetchText: () => { throw new Error('network used'); },
      fetchJson: () => { throw new Error('network used'); },
    },
  });
  assert.equal(result.companies.length, 1);
  assert.equal(result.companies[0].company, 'Acme');
});

/* ------------------------------------------------------- evidence linking */

test('an evidence URL is kept only when its host matches the claimed source', () => {
  assert.equal(trustedEvidenceUrl('https://techcrunch.com/x', 'techcrunch'), 'https://techcrunch.com/x');
  assert.equal(trustedEvidenceUrl('https://sub.techcrunch.com/x', 'techcrunch'), 'https://sub.techcrunch.com/x');
  assert.equal(trustedEvidenceUrl('https://techcrunch.com.evil.test/x', 'techcrunch'), '');
  assert.equal(trustedEvidenceUrl('https://evil.test/x', 'techcrunch'), '');
  assert.equal(trustedEvidenceUrl('https://theguardian.com/x', 'techcrunch'), '');
  assert.equal(trustedEvidenceUrl('javascript:alert(1)', 'techcrunch'), '');
  assert.equal(trustedEvidenceUrl('file:///etc/passwd', 'techcrunch'), '');
  assert.equal(trustedEvidenceUrl('', 'techcrunch'), '');
});

test('domain matching is suffix-anchored, not substring', () => {
  assert.equal(matchesDomain('techcrunch.com', 'techcrunch.com'), true);
  assert.equal(matchesDomain('feeds.techcrunch.com', 'techcrunch.com'), true);
  assert.equal(matchesDomain('nottechcrunch.com', 'techcrunch.com'), false);
  assert.equal(matchesDomain('techcrunch.com.evil.test', 'techcrunch.com'), false);
  assert.equal(sourceFromUrl('https://news.ycombinator.com/item?id=1'), 'hacker_news');
  assert.equal(sourceFromUrl('https://example.test/'), '');
});

test('an RSS item linking off-host loses its link but not its headline', () => {
  const xml = `<rss><channel><item>
    <title>Acme raises $25M Series B</title>
    <link>https://evil.test/payload</link>
    <pubDate>Fri, 10 Jul 2026 00:00:00 GMT</pubDate>
  </item></channel></rss>`;
  const items = parseRssItems(xml, { source: 'techcrunch' });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, '', 'an off-allowlist link must be dropped, not carried through');
  const [candidate] = buildCandidates(items, { months: 3, now: NOW });
  assert.equal(candidate.company, 'Acme');
  assert.equal(candidate.funding.sources[0].url, '');
});

/* ------------------------------------------------------- report rendering */

test('a hostile evidence title cannot forge table rows, links or markup', () => {
  // renderReport is the escaping boundary. Feed the fields the shapes a feed
  // could realistically push through extraction — pipes, newlines, a fake link,
  // raw markup — and assert none of them survive as Markdown structure.
  const hostile = 'Row\n|---|\n| forged | cells | <script>alert(1)</script> [click](https://evil.test)';
  const report = renderReport({
    generated_at: '2026-07-20',
    window_months: 3,
    sort: 'date',
    sources: ['techcrunch'],
    diagnostics: [{ source: 'techcrunch', status: 'ok', fetched_items: 1, funding_like_items: 1, candidate_count: 1, blocked: false, errors: [hostile] }],
    companies: [{
      company: hostile,
      amount: '$1M',
      round: 'Series A',
      funding: {
        status: 'recent_funding',
        confidence: 'low',
        sources: [{ source: 'techcrunch', title: hostile, url: 'https://techcrunch.com/x', observed_date: '2026-07-10', date_precision: 'day' }],
      },
      discovery_score: 1,
      suggested_action: 'review_company_manually',
    }],
  });
  const forgedSeparator = report.split('\n').some((line) => line.trim() === '|---|');
  assert.equal(forgedSeparator, false, 'a newline in feed text must not open a new table');
  assert.ok(!report.includes('<script'), 'raw markup must be escaped');
  assert.ok(!report.includes('[click]'), 'a feed-supplied Markdown link must not render as a link');
  assert.match(report, /\\\|/, 'pipes must be escaped');
});

test('a headline whose company name is a publisher-suffixed injection yields nothing', () => {
  // "Acme | evil | row ..." — everything from the first pipe is publisher
  // furniture, so extraction is left with a bare name and no funding verb.
  assert.equal(extractCompanyFromFundingTitle('Acme | evil | row raises $1M Series A'), '');
  assert.equal(buildCandidates([item({
    title: 'Acme | evil | row\n|---|\n| injected raises $1M Series A',
    text: 'raises $1M Series A funding',
  })], { months: 3, now: NOW }).length, 0);
});

test('company names carrying markup are rejected outright', () => {
  assert.equal(cleanCompanyName('<img src=x onerror=alert(1)>'), '');
  assert.equal(cleanCompanyName('a'), '', 'one character is not a company name');
  assert.equal(cleanCompanyName('x'.repeat(71)), '', 'an unbounded name is not a company name');
  assert.equal(extractCompanyFromFundingTitle('<b>Acme</b> raises $25M Series B'), '');
});

test('the report states that nothing was written and nothing was probed', () => {
  const report = renderReport({
    generated_at: '2026-07-20',
    window_months: 3,
    sort: 'date',
    sources: ['techcrunch'],
    diagnostics: [],
    companies: [],
  });
  assert.match(report, /Review-first/);
  assert.match(report, /portals\.yml/);
  assert.match(report, /not evidence that the company is hiring/);
});

/* ------------------------------------------------------------- suggestion */

test('the module suggests and never acts', () => {
  assert.doesNotMatch(SOURCE, /PORTALS_FILE|portals\.yml['"]/);
  // No model transport, no evaluation import: discovery is zero-token.
  assert.doesNotMatch(SOURCE, /from\s+'[^']*(evaluate|openrouter|claude|anthropic|openai|ollama)[^']*'/i);
  assert.doesNotMatch(SOURCE, /spawn|execFile|exec\(/);
  // The only write path is the opt-in --write report under the analysis dir,
  // and it goes through the canonical atomic-replacement boundary.
  assert.doesNotMatch(SOURCE, /writeFileSync\(|appendFileSync\(|createWriteStream\(/);
  assert.equal([...SOURCE.matchAll(/replaceFileAtomic\(/g)].length, 2, 'exactly the JSON + Markdown report');
  assert.match(SOURCE, /import \{ replaceFileAtomic \} from '\.\.\/lib\/locked-file\.mjs'/);
  assert.match(SOURCE, /ANALYSIS_REPORTS_DIR/);
  assert.doesNotMatch(SOURCE, /dirname\(fileURLToPath\(import\.meta\.url\)\)/);
});

test('every candidate carries a manual-review action', () => {
  const candidates = buildCandidates([item(), item({ title: 'Beta raises $5M seed' })], { months: 3, now: NOW });
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.equal(candidate.suggested_action, 'review_company_manually');
    assert.equal(candidate.funding.status, 'recent_funding');
  }
});

/* ------------------------------------------------------------- filtering */

test('funding vocabulary used for something other than a raise is excluded', () => {
  const excluded = [
    'Acme acquires Beta for $2B',
    'Acme announces IPO pricing',
    'Sequoia raises $900M fund IV',
    'Acme wins $2M research grant',
    'How to raise a seed round: a guide to fundraising',
    'AI startup valuations raise bubble fears',
  ];
  for (const title of excluded) {
    assert.equal(isExcludedFundingItem(item({ title, text: title })), true, `should exclude: ${title}`);
  }
  assert.equal(isExcludedFundingItem(item({ title: 'Acme raises $25M Series B', text: 'Acme raises $25M Series B' })), false);
  assert.equal(isExcludedFundingItem(item({ title: 'Acme launches a new dashboard', text: '' })), true, 'no funding language at all');
});

test('a person who raised money is not offered as a company to follow', () => {
  // Live TechCrunch, 2026-07-31. Upstream's guard only covers the possessive
  // form ("<person>'s startup raises"), so this shape put a founder's name in
  // the review list as an employer.
  assert.equal(
    extractCompanyFromFundingTitle('Repeat founder Ryan Williams raises $10M seed for an AI startup for private credit managers'),
    '',
  );
  assert.equal(cleanCompanyName('Serial entrepreneur Jane Doe'), '');
  assert.equal(cleanCompanyName('Ex-Google exec Sam Smith'), '');
  // A real company keeps working: the guard is anchored, not a substring match.
  assert.equal(cleanCompanyName('Founda Health'), 'Founda Health');
  assert.equal(extractCompanyFromFundingTitle('Ex-DeepMind David Silver Raises $1.1B for AI Startup Ineffable'), 'Ineffable');
});

test('a leading scene-setting clause does not become the company name', () => {
  assert.equal(
    extractCompanyFromFundingTitle('Fresh off its Wiz payout, Index Ventures raises $2B across three funds'),
    'Index Ventures',
  );
  assert.equal(
    extractCompanyFromFundingTitle('After two years in stealth, Acme raises $25M Series B'),
    'Acme',
  );
});

test('a VC closing its own vehicle is excluded however the headline phrases it', () => {
  for (const title of [
    'Index Ventures raises $2B across three funds',
    'Sequoia raises $900M fund IV',
    'Acme Capital raises $300M for its second fund',
    'Convective Capital raises an $85 million fund to build disaster resilience',
  ]) {
    assert.equal(isExcludedFundingItem(item({ title, text: title })), true, `should exclude: ${title}`);
  }
  // The fund exclusion must not swallow an operating company whose name
  // happens to start with "Fund", or an ordinary round.
  assert.equal(isExcludedFundingItem(item({ title: 'Fundify raises $4M seed', text: 'Fundify raises $4M seed' })), false);
  assert.equal(isExcludedFundingItem(item({ title: 'Acme closes $25M Series A round', text: 'Acme closes $25M Series A round' })), false);
});

test('items outside the window are dropped rather than dated to today', () => {
  const stale = item({
    title: 'Ancient raises $9M Series A',
    observedDate: { value: '2025-01-05', precision: 'day', date: new Date('2025-01-05T00:00:00Z') },
  });
  assert.equal(buildCandidates([stale], { months: 3, now: NOW }).length, 0);
  assert.equal(buildCandidates([stale], { months: 24, now: NOW }).length, 1);
});

test('evidence for the same company merges and does not double-count', () => {
  const one = item({ url: 'https://techcrunch.com/acme-1' });
  const duplicate = item({ url: 'https://techcrunch.com/acme-1' });
  const second = item({ source: 'guardian', url: 'https://theguardian.com/acme', title: 'Acme raises $25M Series B' });
  const [candidate] = buildCandidates([one, duplicate, second], { months: 3, now: NOW });
  assert.equal(candidate.funding.sources.length, 2, 'identical evidence must not be counted twice');
  assert.equal(candidate.funding.confidence, 'high');
});

/* ----------------------------------------------------------- diagnostics */

test('a challenge page is reported as blocked, not as a quiet zero', () => {
  const challenge = '<html><head><title>Attention Required!</title></head><body>Cloudflare: verify you are human</body></html>';
  assert.equal(detectBlockedContent(challenge), true);
  assert.equal(detectBlockedContent('<rss><channel></channel></rss>'), false);
  assert.equal(detectBlockedContent(''), false);
});

test('a source that fails is named in the diagnostics rather than silently empty', async () => {
  const result = await discoverFundedCompanies({
    sources: ['techcrunch'],
    now: NOW,
    http: {
      fetchText: () => { throw new Error('HTTP 429 Too Many Requests'); },
      fetchJson: () => { throw new Error('unused'); },
    },
  });
  assert.equal(result.companies.length, 0);
  const [diag] = result.diagnostics;
  assert.equal(diag.source, 'techcrunch');
  assert.equal(diag.status, 'error');
  assert.ok(diag.errors.join(' ').includes('429'), 'the underlying failure must survive into the report');
});

test('a malformed remote date degrades the item, it does not kill the run', async () => {
  // `new Date(<hostile text>).toISOString()` throws RangeError, so one bad
  // created_at from the HN API used to take down the entire discovery run —
  // the opposite of the per-source diagnostics this module is built around.
  const hits = [
    { title: 'Acme raises $25M Series A', created_at: 'not-a-date', objectID: '1' },
    { title: 'Beta raises $5M seed', created_at: null, objectID: '2' },
    { title: 'Gamma raises $1M seed', created_at: {}, objectID: '3' },
    { title: 'Delta raises $2M seed', created_at: '2026-07-10T00:00:00Z', objectID: '4' },
  ];
  const result = await discoverFundedCompanies({
    sources: ['hn'],
    now: NOW,
    http: { fetchText: () => '', fetchJson: () => ({ hits }) },
  });
  assert.deepEqual(
    result.companies.map((candidate) => candidate.company).sort(),
    ['Acme', 'Beta', 'Delta', 'Gamma'],
    'an unparseable date must fall back to the item text, not drop or crash the item',
  );
  for (const candidate of result.companies) {
    const [evidence] = candidate.funding.sources;
    assert.match(evidence.observed_date, /^\d{4}(-\d{2}-\d{2})?$/, 'every candidate needs a usable date');
  }
});

test('a blocked feed is distinguishable from an empty one', async () => {
  const result = await discoverFundedCompanies({
    sources: ['techcrunch'],
    now: NOW,
    http: {
      fetchText: () => '<html>Access denied — bot detection</html>',
      fetchJson: () => { throw new Error('unused'); },
    },
  });
  assert.equal(result.diagnostics[0].status, 'blocked');
  assert.equal(result.diagnostics[0].blocked, true);
});

/* ------------------------------------------------------------------ args */

test('arguments are validated instead of coerced', () => {
  assert.throws(() => parseArgs(['--limit', '0']), /--limit/);
  assert.throws(() => parseArgs(['--limit', '9999']), /--limit/);
  assert.throws(() => parseArgs(['--limit', 'abc']), /--limit/);
  assert.throws(() => parseArgs(['--months', '-3']), /--months/);
  assert.throws(() => parseArgs(['--sort', 'random']), /--sort/);
  assert.throws(() => parseArgs(['--sources', 'crunchbase']), /unknown source/);
  assert.throws(() => parseArgs(['--sources', '']), /at least one source/);
  // The repo-wide gotcha: a CLI that treats a stray flag as data.
  assert.throws(() => parseArgs(['workspace/profile/cv.md']), /unknown argument/);
  assert.throws(() => parseArgs(['--dry-run']), /unknown argument/);

  const opts = parseArgs(['--sources', 'hn,techcrunch,HN', '--months', '6', '--sort', 'score', '--summary']);
  assert.deepEqual(opts.sources, ['hn', 'techcrunch']);
  assert.equal(opts.months, 6);
  assert.equal(opts.sort, 'score');
  assert.equal(opts.summary, true);
  assert.equal(opts.write, false, 'writing must stay opt-in');
});
