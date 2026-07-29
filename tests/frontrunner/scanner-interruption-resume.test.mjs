import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkpointCompatible, loadCheckpoint, writeCheckpoint,
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
    assert.equal(existsSync(`${checkpointPath}.tmp-${process.pid}`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
