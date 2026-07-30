import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  acquireFileLock,
  FileLockTimeoutError,
} from '../../src/lib/file-lock.mjs';
import { replaceFileAtomic } from '../../src/lib/locked-file.mjs';
import {
  appendPortalHealth,
  appendScanRunSummary,
  appendToScanHistory,
  PORTAL_HEALTH_HEADER,
  SCAN_RUNS_HEADER,
} from '../../src/scan/scan.mjs';

const execFileAsync = promisify(execFile);

test('file-lock timing options reject values that can busy-loop or disable timeouts', async () => {
  const target = join(tmpdir(), 'frontrunner-invalid-lock-options');
  await assert.rejects(
    acquireFileLock(target, { retryMs: 0 }),
    /retryMs must be a positive integer/u,
  );
  await assert.rejects(
    acquireFileLock(target, { timeoutMs: Number.POSITIVE_INFINITY }),
    /timeoutMs must be a non-negative integer/u,
  );
  await assert.rejects(
    acquireFileLock(target, { staleMs: -1 }),
    /staleMs must be a non-negative integer/u,
  );
});

test('dead-owner file locks recover while live owners are never stolen', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-lock-recovery-'));
  const target = join(fixture, 'state.tsv');
  const lockDir = `${target}.lock`;
  try {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }));
    const recovered = await acquireFileLock(target, {
      timeoutMs: 500,
      retryMs: 5,
      staleMs: 60_000,
    });
    assert.notEqual(
      JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token,
      'dead-owner',
    );

    await assert.rejects(
      acquireFileLock(target, {
        timeoutMs: 25,
        retryMs: 5,
        staleMs: 0,
      }),
      error => error instanceof FileLockTimeoutError,
      'a live lock owner was stolen merely because its lock was old',
    );
    recovered.release();
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('lock acquisition survives replacement between mkdir and owner publication', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-lock-publish-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'state.json');
  const lockDir = `${target}.lock`;
  let injected = false;

  const lock = await acquireFileLock(target, {
    timeoutMs: 1_000,
    retryMs: 1,
    staleMs: 0,
    afterMkdir(created) {
      if (injected) return;
      injected = true;
      rmSync(created, { recursive: true, force: true });
      mkdirSync(created);
      writeFileSync(join(created, 'owner.json'), JSON.stringify({
        pid: 999_999_999,
        token: 'replacement-owner',
      }));
    },
    ownerFields: {
      pid: 999_999_999,
      token: 'caller-must-not-override',
    },
  });

  assert.equal(injected, true);
  const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, 'replacement-owner');
  assert.notEqual(owner.token, 'caller-must-not-override');
  lock.release();
  assert.equal(existsSync(lockDir), false);
});

test('a delayed file-lock release cannot delete a replacement owner', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-lock-token-'));
  const target = join(fixture, 'state.tsv');
  const lockDir = `${target}.lock`;
  try {
    const original = await acquireFileLock(target);
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      token: 'replacement-owner',
    }));

    original.release();
    assert.equal(existsSync(lockDir), true);
    assert.equal(
      JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token,
      'replacement-owner',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('failure injection preserves the original file and removes the temporary write', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-atomic-state-'));
  const target = join(fixture, 'state.tsv');
  try {
    writeFileSync(target, 'original\n');
    assert.throws(
      () => replaceFileAtomic(target, 'replacement\n', {
        afterWrite() {
          throw new Error('injected crash before rename');
        },
      }),
      /injected crash/u,
    );
    assert.equal(readFileSync(target, 'utf8'), 'original\n');
    assert.deepEqual(readdirSync(fixture), ['state.tsv']);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('concurrent scanner audit writes retain every row with exactly one header', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-scan-state-'));
  const runs = join(fixture, 'scan-runs.tsv');
  const health = join(fixture, 'portal-health.tsv');
  const history = join(fixture, 'scan-history.tsv');
  const count = 20;

  try {
    await Promise.all(Array.from({ length: count }, (_, index) => Promise.all([
      appendScanRunSummary({
        timestamp: `2026-07-29T10:00:${String(index).padStart(2, '0')}Z`,
        status: 'completed',
        companies: index,
        boards: 1,
        found: 1,
        filteredTitle: 0,
        filteredTier: 0,
        filteredLocation: 0,
        filteredPostingAge: 0,
        filteredSalary: 0,
        filteredContent: 0,
        filteredCooldown: 0,
        dupes: 0,
        newAdded: 1,
        errors: 0,
      }, runs),
      appendPortalHealth([{
        timestamp: `2026-07-29T10:00:${String(index).padStart(2, '0')}Z`,
        company: `Company ${index}`,
        status: 'reachable',
      }], health),
      appendToScanHistory([{
        url: `https://jobs.example.com/${index}`,
        portal: 'fixture',
        title: `Role ${index}`,
        company: `Company ${index}`,
        location: 'Remote',
      }], '2026-07-29', 'added', history),
    ])));

    const runLines = readFileSync(runs, 'utf8').trim().split('\n');
    const healthLines = readFileSync(health, 'utf8').trim().split('\n');
    const historyLines = readFileSync(history, 'utf8').trim().split('\n');
    assert.equal(runLines[0], SCAN_RUNS_HEADER.trim());
    assert.equal(healthLines[0], PORTAL_HEALTH_HEADER.trim());
    assert.match(historyLines[0], /^url\tfirst_seen\t/u);
    assert.equal(runLines.length, count + 1);
    assert.equal(healthLines.length, count + 1);
    assert.equal(historyLines.length, count + 1);
    for (let index = 0; index < count; index++) {
      assert.equal(runLines.filter(line => line.includes(`\t${index}\t1\t1\t`)).length, 1);
      assert.equal(healthLines.filter(line => line.includes(`\tCompany ${index}\t`)).length, 1);
      assert.equal(historyLines.filter(line => line.startsWith(`https://jobs.example.com/${index}\t`)).length, 1);
    }
    assert.equal(readdirSync(fixture).some(name => name.endsWith('.lock')), false);
    assert.equal(readdirSync(fixture).some(name => name.endsWith('.tmp')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('destructive cross-process inbox race retains every queued request', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-inbox-race-'));
  const inbox = join(fixture, 'agent-inbox.md');
  const cli = join(ROOT, 'src/tracker/agent-inbox.mjs');
  const count = 16;

  try {
    await Promise.all(Array.from({ length: count }, (_, index) => execFileAsync(
      process.execPath,
      [cli, 'add', `concurrent request ${index}`],
      {
        cwd: ROOT,
        env: { ...process.env, FRONTRUNNER_INBOX: inbox },
        timeout: 10_000,
      },
    )));

    const content = readFileSync(inbox, 'utf8');
    assert.equal((content.match(/^# Agent Inbox$/gmu) ?? []).length, 1);
    assert.equal((content.match(/^- \[ \]/gmu) ?? []).length, count);
    for (let index = 0; index < count; index++) {
      assert.equal(
        content.split('\n').filter(line => line.endsWith(`concurrent request ${index}`)).length,
        1,
      );
    }
    assert.equal(existsSync(`${inbox}.lock`), false);
    assert.equal(readdirSync(fixture).some(name => name.endsWith('.tmp')), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('destructive cross-process pipeline race retains both writers atomically', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-race-'));
  const scanModule = pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href;
  const runWriter = (index) => execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { appendToPipeline } = await import(${JSON.stringify(scanModule)});
       await appendToPipeline([{
         url: ${JSON.stringify(`https://jobs.example.com/race-${index}`)},
         company: ${JSON.stringify(`Race Company ${index}`)},
         title: ${JSON.stringify(`Race Role ${index}`)},
         location: 'Remote'
       }]);`,
    ],
    {
      cwd: fixture,
      env: { ...process.env },
      timeout: 10_000,
    },
  );

  try {
    await Promise.all([runWriter(1), runWriter(2)]);
    const pipeline = readFileSync(join(fixture, 'workspace', 'search', 'pipeline.md'), 'utf8');
    assert.equal((pipeline.match(/^# Pipeline — Pending URLs$/gmu) ?? []).length, 1);
    assert.equal((pipeline.match(/https:\/\/jobs\.example\.com\/race-1/gmu) ?? []).length, 1);
    assert.equal((pipeline.match(/https:\/\/jobs\.example\.com\/race-2/gmu) ?? []).length, 1);
    assert.equal(existsSync(join(fixture, 'workspace', 'search', 'pipeline.md.lock')), false);
    assert.equal(
      readdirSync(join(fixture, 'workspace', 'search')).some(name => name.endsWith('.tmp')),
      false,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
