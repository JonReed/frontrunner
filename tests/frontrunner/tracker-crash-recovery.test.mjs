import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openTrackerTransaction } from '../../src/tracker/tracker-utils.mjs';

const TRACKER_UTILS_URL = new URL(
  '../../src/tracker/tracker-utils.mjs',
  import.meta.url,
).href;

function child(code, env) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => proc.once('close', (exitCode, signal) => {
    resolve({ exitCode, signal, stderr });
  }));
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-tracker-crash-'));
  const tracker = join(dir, 'applications.md');
  const lockDir = join(dir, 'career-ops-merge-tracker-crash.lock');
  writeFileSync(tracker, 'original\n');
  return { dir, tracker, lockDir };
}

function assertForcedTermination(result) {
  if (process.platform === 'win32') {
    // Windows does not report POSIX signal names through ChildProcess.close;
    // process.kill(..., 'SIGKILL') is observed as a non-zero exit instead.
    assert.notEqual(result.exitCode, 0, result.stderr);
    return;
  }
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}

test('a crash after the temporary write preserves the original tracker and the next writer recovers', async () => {
  const { dir, tracker, lockDir } = fixture();
  try {
    const result = await child(`
      import { openTrackerTransaction } from ${JSON.stringify(TRACKER_UTILS_URL)};
      const tx = await openTrackerTransaction(process.env.TEST_TRACKER, {
        lockDir: process.env.TEST_LOCK,
        writeOptions: { afterWrite: () => process.kill(process.pid, 'SIGKILL') },
      });
      tx.replace('partial replacement\\n');
    `, { TEST_TRACKER: tracker, TEST_LOCK: lockDir });

    assertForcedTermination(result);
    assert.equal(readFileSync(tracker, 'utf8'), 'original\n');
    assert.equal(existsSync(lockDir), true, 'the crash should leave a realistic orphaned lock');
    assert.equal(
      readdirSync(dir).some(name => name.endsWith('.tmp')),
      true,
      'the crash should leave the pre-rename temporary file',
    );

    const tx = await openTrackerTransaction(tracker, {
      lockDir,
      timeoutMs: 1_000,
      retryMs: 10,
    });
    assert.equal(tx.read(), 'original\n');
    tx.replace('recovered\n');
    tx.close();

    assert.equal(readFileSync(tracker, 'utf8'), 'recovered\n');
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash after atomic replacement leaves a complete commit and a recoverable lock', async () => {
  const { dir, tracker, lockDir } = fixture();
  try {
    const result = await child(`
      import { openTrackerTransaction } from ${JSON.stringify(TRACKER_UTILS_URL)};
      const tx = await openTrackerTransaction(process.env.TEST_TRACKER, {
        lockDir: process.env.TEST_LOCK,
        writeOptions: { afterRename: () => process.kill(process.pid, 'SIGKILL') },
      });
      tx.replace('committed before crash\\n');
    `, { TEST_TRACKER: tracker, TEST_LOCK: lockDir });

    assertForcedTermination(result);
    assert.equal(readFileSync(tracker, 'utf8'), 'committed before crash\n');

    const tx = await openTrackerTransaction(tracker, {
      lockDir,
      timeoutMs: 1_000,
      retryMs: 10,
    });
    assert.equal(tx.read(), 'committed before crash\n');
    tx.close();
    assert.equal(existsSync(lockDir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eight concurrent tracker transactions preserve every row exactly once', async () => {
  const { dir, tracker, lockDir } = fixture();
  try {
    const workers = Array.from({ length: 8 }, (_, index) => child(`
      import { openTrackerTransaction } from ${JSON.stringify(TRACKER_UTILS_URL)};
      const tx = await openTrackerTransaction(process.env.TEST_TRACKER, {
        lockDir: process.env.TEST_LOCK,
        timeoutMs: 20000,
        retryMs: 5,
      });
      const current = tx.read();
      await new Promise(resolve => setTimeout(resolve, 15));
      tx.replace(current + 'worker-' + process.env.WORKER_ID + '\\n');
      tx.close();
    `, {
      TEST_TRACKER: tracker,
      TEST_LOCK: lockDir,
      WORKER_ID: String(index),
    }));

    const results = await Promise.all(workers);
    assert.deepEqual(
      results.map(result => result.exitCode),
      Array(8).fill(0),
      results.map(result => result.stderr).filter(Boolean).join('\n'),
    );
    const final = readFileSync(tracker, 'utf8');
    for (let index = 0; index < 8; index++) {
      assert.equal(final.match(new RegExp(`^worker-${index}$`, 'gm'))?.length, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
