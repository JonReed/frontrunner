import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkpointCompatible, loadCheckpoint, removeCheckpoint, writeCheckpoint,
} from '../../src/scan/scan-ats-full.mjs';

const SCANNER_URL = new URL('../../src/scan/scan-ats-full.mjs', import.meta.url).href;

test('SIGTERM writes the latest safe scanner resume point before exiting', {
  skip: process.platform === 'win32' && 'Windows does not deliver POSIX SIGTERM handlers',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-scan-interrupt-'));
  const checkpointPath = join(dir, 'checkpoint.json');
  try {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', `
      import { installCheckpointSignalHandlers } from ${JSON.stringify(SCANNER_URL)};
      const state = {
        version: 1,
        cutoffMs: 123,
        ats: ['greenhouse'],
        limit: null,
        includeUndated: false,
        completedSources: [],
        offers: [{ url: 'https://example.test/job/1', title: 'Engineer' }],
        current: {
          name: 'greenhouse',
          resumeAt: 37,
          datasetLen: 1000,
          datasetHash: 'abc123',
        },
        counters: { totalCompaniesScanned: 37, totalErrors: 2 },
      };
      installCheckpointSignalHandlers({
        snapshot: () => state,
        checkpointPath: process.env.TEST_CHECKPOINT,
      });
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1000);
    `], {
      env: { ...process.env, TEST_CHECKPOINT: checkpointPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`scanner child did not start: ${stderr}`)), 2_000);
      proc.stdout.on('data', () => {
        if (stdout.includes('READY')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    proc.kill('SIGTERM');
    const closed = await new Promise(resolve => proc.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    assert.deepEqual(closed, { exitCode: 143, signal: null });
    assert.match(stderr, /progress saved/);

    const checkpoint = loadCheckpoint(checkpointPath);
    assert.equal(checkpoint.current.resumeAt, 37);
    assert.equal(checkpoint.counters.totalCompaniesScanned, 37);
    assert.equal(checkpoint.offers.length, 1);
    assert.equal(checkpointCompatible(checkpoint, {
      ats: ['greenhouse'],
      limit: Infinity,
      includeUndated: false,
      shuffle: false,
    }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupted checkpoint replacement never exposes partial JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-scan-checkpoint-'));
  const checkpointPath = join(dir, 'checkpoint.json');
  try {
    const first = {
      version: 1,
      current: { name: 'workday', resumeAt: 20, datasetLen: 100 },
    };
    const second = {
      version: 1,
      current: { name: 'workday', resumeAt: 40, datasetLen: 100 },
    };
    assert.equal(writeCheckpoint(first, checkpointPath), true);
    assert.equal(writeCheckpoint(second, checkpointPath), true);
    assert.deepEqual(JSON.parse(readFileSync(checkpointPath, 'utf8')), second);
    assert.deepEqual(readdirSync(dir), ['checkpoint.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failure after durable temporary write preserves the previous checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-scan-checkpoint-failure-'));
  const checkpointPath = join(dir, 'checkpoint.json');
  try {
    const original = '{"version":1,"current":null}\r\n';
    writeFileSync(checkpointPath, original);
    const saved = writeCheckpoint({
      version: 1,
      current: { name: 'ashby', resumeAt: 80, datasetLen: 100 },
    }, checkpointPath, {
      afterWrite() {
        throw new Error('injected scanner checkpoint interruption');
      },
    });
    assert.equal(saved, false);
    assert.equal(readFileSync(checkpointPath, 'utf8'), original);
    assert.deepEqual(readdirSync(dir), ['checkpoint.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkpoint publication and removal enforce protected user data without preload', () => {
  const protectedRoot = mkdtempSync(join(tmpdir(), 'frontrunner-protected-checkpoint-'));
  const cache = join(protectedRoot, 'workspace', '.state', 'cache');
  const checkpointPath = join(cache, 'ats-full-checkpoint.json');
  const previousRoot = process.env.FRONTRUNNER_TEST_PROTECTED_ROOT;
  try {
    mkdirSync(cache, { recursive: true });
    writeFileSync(checkpointPath, 'must survive\n');
    process.env.FRONTRUNNER_TEST_PROTECTED_ROOT = protectedRoot;

    assert.equal(writeCheckpoint({ version: 1, current: null }, checkpointPath), false);
    assert.throws(
      () => removeCheckpoint(checkpointPath),
      error => error?.code === 'TEST_USER_DATA_WRITE_BLOCKED',
    );
    assert.equal(readFileSync(checkpointPath, 'utf8'), 'must survive\n');
    assert.deepEqual(readdirSync(cache), ['ats-full-checkpoint.json']);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.FRONTRUNNER_TEST_PROTECTED_ROOT;
    } else {
      process.env.FRONTRUNNER_TEST_PROTECTED_ROOT = previousRoot;
    }
    rmSync(protectedRoot, { recursive: true, force: true });
  }
});
