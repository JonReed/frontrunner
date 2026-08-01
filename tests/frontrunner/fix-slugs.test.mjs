import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import * as yaml from 'js-yaml';

import { ROOT } from '#paths';
import { computeFixes, splitCompanyBlocks } from '../../src/scan/fix-slugs.mjs';

const FIXTURE = `# preserved header
tracked_companies:
  - name: "Acme" # quoted names are common in hand-edited YAML
    careers_url: https://boards.greenhouse.io/acme-old # preserve surrounding comments
    api: https://boards-api.greenhouse.io/v1/boards/acme-old/jobs
    notes: |
      Existing note.
      - name: This is scalar content, not another company.

  - name: Beta
    careers_url: https://jobs.ashbyhq.com/beta-old
    notes: "Quoted note" # keep this

job_boards:
  - name: Acme
    provider: cryptocurrencyjobs
`;

const RESULTS = [
  {
    name: 'Acme',
    status: 'missing',
    ats: 'greenhouse',
    slug: 'acme-old',
    url: 'https://boards-api.greenhouse.io/v1/boards/acme-old/jobs',
    suggested: { ats: 'lever', slug: 'acme' },
  },
  {
    name: 'Beta',
    status: 'missing',
    ats: 'ashby',
    slug: 'beta-old',
    url: 'https://api.ashbyhq.com/posting-api/job-board/beta-old',
    suggested: { ats: 'greenhouse', slug: 'beta' },
  },
];

test('slug repair edits only tracked companies and preserves YAML/comments', () => {
  const split = splitCompanyBlocks(FIXTURE);
  assert.deepEqual(split.blocks.map(block => block.name), ['Acme', 'Beta']);

  const { text, fixes } = computeFixes(FIXTURE, RESULTS, { dateStr: '2026-07-30' });
  assert.equal(fixes.length, 2);
  const parsed = yaml.load(text);
  assert.equal(parsed.tracked_companies[0].careers_url, 'https://jobs.lever.co/acme');
  assert.equal(parsed.tracked_companies[0].api, undefined);
  assert.match(parsed.tracked_companies[0].notes, /Existing note\./);
  assert.match(parsed.tracked_companies[0].notes, /greenhouse->lever/);
  assert.equal(parsed.tracked_companies[1].api, 'https://boards-api.greenhouse.io/v1/boards/beta/jobs');
  assert.match(text, /# preserve surrounding comments/);
  assert.match(text, /# keep this/);
  assert.match(text, /job_boards:\n  - name: Acme\n    provider: cryptocurrencyjobs/);
});

test('slug repair fails closed for duplicate names and stale verification', () => {
  const duplicate = FIXTURE.replace(
    '\njob_boards:',
    '\n  - name: Acme\n    careers_url: https://jobs.lever.co/other\n\njob_boards:',
  );
  assert.throws(() => computeFixes(duplicate, RESULTS), /duplicate tracked company name/);

  const changed = FIXTURE.replaceAll('acme-old', 'acme-new');
  assert.throws(() => computeFixes(changed, RESULTS), /changed after verification/);
});

test('--fix refuses arbitrary --file targets before network or mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-fix-slugs-'));
  const file = join(dir, 'portals.yml');
  try {
    writeFileSync(file, FIXTURE);
    assert.throws(
      () => execFileSync(process.execPath, [join(ROOT, 'src/scan/fix-slugs.mjs'), '--fix', '--file', file], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
      error => /writes are restricted/.test(String(error.stderr)),
    );
    assert.equal(readFileSync(file, 'utf8'), FIXTURE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('implementation uses the shared locked atomic mutation boundary', () => {
  const source = readFileSync(join(ROOT, 'src/scan/fix-slugs.mjs'), 'utf8');
  assert.match(source, /mutateFileLocked\(PORTALS_FILE/);
  assert.doesNotMatch(source, /\bwriteFileSync\b/);
});
