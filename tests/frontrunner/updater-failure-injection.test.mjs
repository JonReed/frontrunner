import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireUpdateLock, adoptUpdateLock } from '../../update-system.mjs';

const UPDATER_URL = new URL('../../update-system.mjs', import.meta.url).href;

function spawnLockHolder(lockFile) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireUpdateLock } from ${JSON.stringify(UPDATER_URL)};
    acquireUpdateLock(process.env.TEST_UPDATE_LOCK);
    process.stdout.write('LOCKED\\n');
    setInterval(() => {}, 1000);
  `], {
    env: { ...process.env, TEST_UPDATE_LOCK: lockFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', chunk => { stdout += chunk; });
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`lock holder did not start: ${stderr}`)), 2_000);
    proc.stdout.on('data', () => {
      if (stdout.includes('LOCKED')) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  const closed = new Promise(resolve => proc.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
  return { proc, ready, closed };
}

test('a hard-killed updater leaves a lock that the next run recovers automatically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-update-crash-'));
  const lockFile = join(dir, '.update-lock');
  try {
    const holder = spawnLockHolder(lockFile);
    await holder.ready;
    assert.equal(existsSync(lockFile), true);
    holder.proc.kill('SIGKILL');
    const killed = await holder.closed;
    assert.equal(killed.signal, 'SIGKILL');

    const recovered = acquireUpdateLock(lockFile);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, process.pid);
    recovered.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an injected updater failure releases its lock in the failure path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-update-failure-'));
  const lockFile = join(dir, '.update-lock');
  try {
    const lock = acquireUpdateLock(lockFile);
    assert.throws(() => {
      try {
        throw new Error('injected checkout failure');
      } finally {
        lock.release();
      }
    }, /injected checkout failure/);
    assert.equal(existsSync(lockFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live updater excludes a concurrent updater and stale release handles preserve replacements', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-update-contention-'));
  const lockFile = join(dir, '.update-lock');
  try {
    const first = acquireUpdateLock(lockFile);
    assert.throws(() => acquireUpdateLock(lockFile), error => error?.code === 'UPDATE_LOCKED');

    rmSync(lockFile, { force: true });
    writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      token: 'replacement-owner',
    }));
    first.release();
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).token, 'replacement-owner');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self-reexec transfers lock ownership so parent death cannot admit a third updater', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-update-handoff-'));
  const lockFile = join(dir, '.update-lock');
  let childProc = null;
  try {
    const parent = acquireUpdateLock(lockFile);
    childProc = spawn(process.execPath, ['--input-type=module', '-e', `
      import { adoptUpdateLock } from ${JSON.stringify(UPDATER_URL)};
      adoptUpdateLock(process.env.TEST_UPDATE_LOCK, process.env.PARENT_TOKEN);
      process.stdout.write('ADOPTED\\n');
      setInterval(() => {}, 1000);
    `], {
      env: {
        ...process.env,
        TEST_UPDATE_LOCK: lockFile,
        PARENT_TOKEN: parent.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    childProc.stdout.on('data', chunk => { stdout += chunk; });
    childProc.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`reexec child did not adopt: ${stderr}`)), 2_000);
      childProc.stdout.on('data', () => {
        if (stdout.includes('ADOPTED')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const adopted = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.equal(adopted.pid, childProc.pid);
    assert.notEqual(adopted.token, parent.token);
    parent.release();
    assert.equal(existsSync(lockFile), true, 'stale parent handle must preserve the child lock');
    assert.throws(() => acquireUpdateLock(lockFile), error => error?.code === 'UPDATE_LOCKED');

    childProc.kill('SIGKILL');
    await new Promise(resolve => childProc.once('close', resolve));
    childProc = null;
    const recovered = acquireUpdateLock(lockFile);
    recovered.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    if (childProc) childProc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('self-reexec refuses to adopt a lock after its ownership token changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-update-handoff-token-'));
  const lockFile = join(dir, '.update-lock');
  try {
    const lock = acquireUpdateLock(lockFile);
    assert.throws(
      () => adoptUpdateLock(lockFile, 'wrong-parent-token'),
      error => error?.code === 'UPDATE_LOCK_CHANGED',
    );
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
