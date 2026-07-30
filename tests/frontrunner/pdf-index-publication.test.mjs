import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  PDF_INDEX_HEADER,
  pdfIndexLine,
  recordPdfIndex,
} from '../../src/cv/pdf-index-store.mjs';

const WORKER = join(ROOT, 'tests/fixtures/pdf-index-worker.mjs');

function runWorker(file, reportNum) {
  const child = spawn(process.execPath, [WORKER, file, reportNum], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => child.once('close', code => resolve({ code, stderr })));
}

test('destructive concurrency retains every generated PDF manifest row', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pdf-index.tsv');
  const count = 16;

  const results = await Promise.all(
    Array.from({ length: count }, (_, index) => runWorker(file, String(index + 1))),
  );
  assert.deepEqual(
    results.map(result => result.code),
    Array(count).fill(0),
    results.map(result => result.stderr).join('\n'),
  );

  const content = readFileSync(file, 'utf8');
  assert.equal(content.startsWith(PDF_INDEX_HEADER), true);
  const rows = content.split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(rows.length, count);
  assert.equal(new Set(rows.map(row => row.split('\t')[0])).size, count);
});

test('interrupted PDF index replacement preserves prior bytes and cleans debris', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-index-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pdf-index.tsv');
  const original = `${PDF_INDEX_HEADER}1\toutput/one.pdf\toutput/one.html\ta4\t2026-07-28\r\n`;
  writeFileSync(file, original);

  await assert.rejects(
    recordPdfIndex(file, {
      reportNum: '2',
      pdf: 'workspace/documents/two.pdf',
      html: 'workspace/documents/two.html',
      format: 'a4',
      date: '2026-07-29',
    }, {
      writeOptions: {
        afterWrite() {
          throw new Error('injected PDF index interruption');
        },
      },
    }),
    /injected PDF index interruption/,
  );
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readdirSync(dir), ['pdf-index.tsv']);
});

test('PDF index schema rejects field and path injection before publication', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-index-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pdf-index.tsv');

  assert.throws(
    () => pdfIndexLine({
      reportNum: '1\t999',
      pdf: '../../outside.pdf',
      html: '',
      format: 'a4',
      date: '2026-07-29',
    }),
    /invalid/,
  );
  await assert.rejects(
    recordPdfIndex(file, {
      reportNum: '1',
      pdf: '../outside.pdf',
      html: '',
      format: 'a4',
      date: '2026-02-30',
    }),
    /contained relative path|date is invalid/,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test('PDF index bounds validate the option and the complete merged artifact', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-index-bounds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pdf-index.tsv');
  const entry = {
    reportNum: '1',
    pdf: 'workspace/documents/one.pdf',
    html: 'workspace/documents/one.html',
    format: 'a4',
    date: '2026-07-29',
  };

  await assert.rejects(
    recordPdfIndex(file, entry, { maxBytes: Number.NaN }),
    /maxBytes must be a positive integer/,
  );
  await assert.rejects(
    recordPdfIndex(file, entry, { maxBytes: PDF_INDEX_HEADER.length + 5 }),
    /would exceed the safe limit/,
  );
  assert.deepEqual(readdirSync(dir), []);
});
