import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import { parseNextOverrides } from '../../src/tracker/followup-cadence.mjs';
import { seedFollowup } from '../../src/tracker/followup-seed.mjs';

const NODE = process.execPath;
const CLI = join(ROOT, 'src/tracker/followup-seed.mjs');
const CRASH_WORKER = join(ROOT, 'tests/fixtures/followup-seed-crash-worker.mjs');

function trackerContent(count) {
  const rows = Array.from({ length: count }, (_, index) => {
    const num = index + 1;
    return `| ${num} | 2026-07-01 | Company ${num} | Engineer | 4.0/5 | Applied | ❌ | — | Applied 2026-07-01. |`;
  });
  return [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    ...rows,
    '',
  ].join('\n');
}

function runSeed(appNum, paths) {
  const child = spawn(NODE, [CLI, String(appNum), '--json'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FRONTRUNNER_TRACKER: paths.tracker,
      FRONTRUNNER_FOLLOWUPS: paths.followups,
      FRONTRUNNER_FOLLOWUPS_LOCK: paths.lock,
      FRONTRUNNER_FOLLOWUPS_LOCK_RETRY_MS: '5',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => child.once('close', code => resolve({ code, stdout, stderr })));
}

function fixture(count = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-followup-publication-'));
  const paths = {
    dir,
    tracker: join(dir, 'applications.md'),
    followups: join(dir, 'follow-ups.md'),
    lock: join(dir, 'frontrunner-followups-publication.lock'),
  };
  writeFileSync(paths.tracker, trackerContent(count));
  return paths;
}

test('destructive concurrency retains every follow-up pin exactly once', async (t) => {
  const paths = fixture(16);
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));

  const results = await Promise.all(
    Array.from({ length: 16 }, (_, index) => runSeed(index + 1, paths)),
  );
  assert.deepEqual(
    results.map(result => result.code),
    Array(16).fill(0),
    results.map(result => `${result.stdout}\n${result.stderr}`).join('\n'),
  );

  const content = readFileSync(paths.followups, 'utf8');
  const pins = content.split('\n').filter(line => line.startsWith('- next #'));
  assert.equal(pins.length, 16);
  assert.equal(new Set(pins.map(line => line.match(/#(\d+)/)?.[1])).size, 16);
  assert.equal(parseNextOverrides(content).size, 16);
});

test('SIGKILL after fsync but before rename preserves the original and retry commits', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));
  const original = '# Follow-ups\n\nkeep these exact bytes\r\n';
  writeFileSync(paths.followups, original);

  const crashed = spawnSync(NODE, [
    CRASH_WORKER,
    paths.tracker,
    paths.followups,
    paths.lock,
    '1',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(crashed.status, 0);
  assert.equal(readFileSync(paths.followups, 'utf8'), original);

  const retried = spawnSync(NODE, [CLI, '1', '--json'], {
    cwd: ROOT,
    env: {
      ...process.env,
      FRONTRUNNER_TRACKER: paths.tracker,
      FRONTRUNNER_FOLLOWUPS: paths.followups,
      FRONTRUNNER_FOLLOWUPS_LOCK: paths.lock,
      FRONTRUNNER_FOLLOWUPS_LOCK_STALE_MS: '0',
      FRONTRUNNER_FOLLOWUPS_LOCK_RETRY_MS: '5',
    },
    encoding: 'utf8',
  });
  assert.equal(retried.status, 0, `${retried.stdout}\n${retried.stderr}`);
  assert.equal(readFileSync(paths.followups, 'utf8').startsWith(original), true);
  assert.equal(parseNextOverrides(readFileSync(paths.followups, 'utf8')).has(1), true);
});

test('injected publication failure preserves bytes and removes temporary debris', async (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.dir, { recursive: true, force: true }));
  const original = '# Follow-ups\n\noriginal\n';
  writeFileSync(paths.followups, original);

  await assert.rejects(
    seedFollowup(1, {
      trackerPath: paths.tracker,
      followupsPath: paths.followups,
      lockDir: paths.lock,
      writeOptions: {
        afterWrite() {
          throw new Error('injected follow-up publication failure');
        },
      },
    }),
    /injected follow-up publication failure/,
  );
  assert.equal(readFileSync(paths.followups, 'utf8'), original);
  assert.deepEqual(readdirSync(paths.dir).sort(), ['applications.md', 'follow-ups.md']);
});
