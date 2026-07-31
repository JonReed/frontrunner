import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordPdfIndex } from '../../src/cv/pdf-index-store.mjs';
import { COVER_INDEX_FILE } from '../../src/cv/claude-cover.mjs';
import { FOLLOWUP_CHANNELS } from '../../src/tracker/followup-log.mjs';
import { FOLLOWUP_CHANNELS as UI_FOLLOWUP_CHANNELS } from '../../ui/src/lib/followup-channels.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-doc-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entry = (pdf, reportNum = '007') => ({
  reportNum,
  pdf,
  html: '',
  format: 'a4',
  date: '2026-07-31',
});

test('one index supersedes every row for a report — which is why covers need their own', async (t) => {
  const file = join(scratch(t), 'pdf-index.tsv');

  await recordPdfIndex(file, entry('workspace/documents/cv-007-acme-2026-07-30.pdf'));
  await recordPdfIndex(file, entry('workspace/documents/cover-007-acme-2026-07-31.pdf'));

  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'));

  /*
    This is the behaviour, and it is correct for one document per report: a
    rebuilt CV replaces its predecessor. It is also exactly why a covering
    letter must not be written here — doing so deletes that report's CV row,
    and the CV disappears from the screen that had just built it.
  */
  assert.equal(rows.length, 1);
  assert.match(rows[0], /cover-007/u);
  assert.doesNotMatch(rows[0], /cv-007/u);
});

test('covering letters are indexed somewhere else entirely', () => {
  assert.match(COVER_INDEX_FILE, /cover-index\.tsv$/u);
  assert.doesNotMatch(COVER_INDEX_FILE, /pdf-index\.tsv$/u);
});

test('separate indexes let a CV and a letter coexist for one report', async (t) => {
  const dir = scratch(t);
  const cvIndex = join(dir, 'pdf-index.tsv');
  const coverIndex = join(dir, 'cover-index.tsv');

  await recordPdfIndex(cvIndex, entry('workspace/documents/cv-007-acme-2026-07-30.pdf'));
  await recordPdfIndex(coverIndex, entry('workspace/documents/cover-007-acme-2026-07-31.pdf'));

  assert.match(readFileSync(cvIndex, 'utf8'), /cv-007/u);
  assert.match(readFileSync(coverIndex, 'utf8'), /cover-007/u);

  // And each still supersedes its own predecessor, which is the property the
  // shared file was giving us and must not be lost by splitting it.
  await recordPdfIndex(cvIndex, entry('workspace/documents/cv-007-acme-2026-08-01.pdf'));
  const cvRows = readFileSync(cvIndex, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'));
  assert.equal(cvRows.length, 1);
  assert.match(cvRows[0], /cv-007-acme-2026-08-01/u);
});

test('the follow-up channels offered by the form are the ones the writer accepts', () => {
  /*
    The list is duplicated on purpose: the form runs in the browser and the
    writer spawns a backend process, so a client component importing the writer
    drags node:child_process into the bundle and fails the production build.
    Duplication is the price; this test is what stops it drifting into a form
    offering a channel the backend rejects.
  */
  assert.deepEqual([...UI_FOLLOWUP_CHANNELS], [...FOLLOWUP_CHANNELS]);
});
