// fetch-jds.test.mjs — destructive tests for bulk JD ingestion.
//
// The bug this whole module exists to fix was invisible to unit tests:
// batch-runner.sh created an EMPTY temp file, passed it as {{JD_FILE}}, and
// every worker silently fell through to fetching a rendered HTML page. Nothing
// asserted "the JD file has content in it". So these tests care about the
// boundaries — URL parsing and HTML→text — and about not throwing on the
// hostile input real ATS boards actually return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { parseJobUrl } = await import(join(ROOT, 'fetch-jds.mjs'));

// ---------------------------------------------------------------------------
// URL parsing — a misparse sends the whole board's roles to the WebFetch
// fallback, silently restoring the 10x cost this module removes.
// ---------------------------------------------------------------------------

test('parses the real board URL shapes', () => {
  const cases = [
    ['https://job-boards.greenhouse.io/anthropic/jobs/5101173008', 'greenhouse', 'anthropic', '5101173008'],
    ['https://boards.greenhouse.io/monzo/jobs/12345', 'greenhouse', 'monzo', '12345'],
    ['https://jobs.ashbyhq.com/openai/abc-123-def', 'ashby', 'openai', 'abc-123-def'],
    ['https://jobs.lever.co/mistral/uuid-here', 'lever', 'mistral', 'uuid-here'],
  ];
  for (const [url, provider, slug, jobId] of cases) {
    const p = parseJobUrl(url);
    assert.ok(p, `failed to parse: ${url}`);
    assert.equal(p.provider, provider, url);
    assert.equal(p.slug, slug, url);
    assert.equal(p.jobId, jobId, url);
  }
});

test('detects the EU greenhouse host, which uses a different API origin', () => {
  // Getting this wrong means a 404 for every EU-hosted board. PolyAI is on it.
  const p = parseJobUrl('https://job-boards.eu.greenhouse.io/polyai/jobs/4869448101');
  assert.equal(p.provider, 'greenhouse');
  assert.equal(p.eu, true);
  assert.equal(parseJobUrl('https://job-boards.greenhouse.io/x/jobs/1').eu, false);
});

test('returns null for providers with no bulk endpoint, rather than guessing', () => {
  // Workday needs one request per job, so there is no bulk win — it must fall
  // through to the existing path, not be half-parsed into a broken lookup.
  const nulls = [
    'https://accenture.wd103.myworkdayjobs.com/AccentureCareers/job/London/Role_R001',
    'https://careers.google.com/jobs/results/123',
    'https://example.com',
    'not-a-url',
    '',
    'javascript:alert(1)',
    'file:///etc/passwd',
  ];
  for (const u of nulls) assert.equal(parseJobUrl(u), null, `should not parse: ${u}`);
});

test('malformed URLs never throw', () => {
  const nasties = [null, undefined, 'https://', 'https://jobs.ashbyhq.com', '://x', 'h'.repeat(10_000)];
  for (const u of nasties) {
    assert.doesNotThrow(() => parseJobUrl(u), String(u).slice(0, 20));
  }
});

test('a greenhouse URL without a job id is rejected, not mis-sliced', () => {
  assert.equal(parseJobUrl('https://job-boards.greenhouse.io/anthropic'), null);
  assert.equal(parseJobUrl('https://job-boards.greenhouse.io/anthropic/jobs'), null);
});

// ---------------------------------------------------------------------------
// HTML → text. Greenhouse returns entity-escaped HTML; Ashby and Lever return
// plain text. Both paths must land on readable output.
// ---------------------------------------------------------------------------

const { htmlToText } = await import(join(ROOT, 'fetch-jds.mjs'));

test('entity-escaped HTML becomes readable text', () => {
  const src = '&lt;p&gt;We want a &lt;strong&gt;Director&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Own delivery&lt;/li&gt;&lt;/ul&gt;';
  const out = htmlToText(src);
  assert.ok(!out.includes('<'), 'tags survived');
  assert.ok(out.includes('Director'));
  assert.ok(out.includes('Own delivery'));
});

test('out-of-range numeric entities do not throw', () => {
  // providers/* shipped this exact RangeError (upstream #2146): an unguarded
  // String.fromCodePoint on a malformed entity crashes the whole board.
  assert.doesNotThrow(() => htmlToText('&#99999999999; &#xFFFFFFFF; &#0;'));
});

test('script and style content is stripped, not inlined', () => {
  const out = htmlToText('&lt;script&gt;alert(1)&lt;/script&gt;Real content');
  assert.ok(!out.includes('alert'), 'script body leaked into the JD');
  assert.ok(out.includes('Real content'));
});
