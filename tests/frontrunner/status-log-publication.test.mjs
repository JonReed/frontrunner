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
  appendStatusTransition,
  statusTransitionLine,
} from '../../src/tracker/status-log.mjs';

const NODE = process.execPath;
const WORKER = join(ROOT, 'tests/fixtures/status-log-worker.mjs');

function runWorker(args) {
  const child = spawn(NODE, [WORKER, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => child.once('close', code => resolve({ code, stderr })));
}

test('destructive concurrency retains every complete status transition exactly once', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-status-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'status-log.tsv');
  const count = 12;

  const results = await Promise.all(Array.from({ length: count }, (_, index) => (
    runWorker([
      log,
      String(index + 1),
      `2026-07-${String(index + 1).padStart(2, '0')}`,
      'Evaluated',
      'Applied',
    ])
  )));
  assert.deepEqual(results.map(result => result.code), Array(count).fill(0));

  const rows = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(rows.length, count);
  assert.equal(new Set(rows).size, count);
  for (let index = 0; index < count; index++) {
    assert.equal(
      rows.includes(`${index + 1}\t2026-07-${String(index + 1).padStart(2, '0')}\tEvaluated\tApplied\tset-status\t`),
      true,
    );
  }
});

test('failure after the temporary ledger write preserves the original and removes debris', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-status-log-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'status-log.tsv');
  const original = '1\t2026-07-01\tEvaluated\tApplied\tset-status\t\n';
  writeFileSync(log, original);

  await assert.rejects(
    appendStatusTransition(log, {
      trackerNum: 2,
      date: '2026-07-02',
      from: 'Applied',
      to: 'Responded',
    }, {
      writeOptions: {
        afterWrite() {
          throw new Error('injected status-log interruption');
        },
      },
    }),
    /injected status-log interruption/,
  );
  assert.equal(readFileSync(log, 'utf8'), original);
  assert.deepEqual(readdirSync(dir).sort(), ['status-log.tsv']);
});

test('transition schema rejects injected fields before creating a file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-status-log-schema-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'status-log.tsv');

  assert.throws(
    () => statusTransitionLine({
      trackerNum: 1,
      date: '2026-07-01',
      from: 'Applied\t999',
      to: 'Responded',
    }),
    /source state is invalid/,
  );
  await assert.rejects(
    appendStatusTransition(log, {
      trackerNum: 1,
      date: '2026-02-30',
      from: 'Applied',
      to: 'Responded',
    }),
    /date is invalid/,
  );
  assert.deepEqual(readdirSync(dir), []);
});
