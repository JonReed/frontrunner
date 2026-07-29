import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createApplicationJobManager } from '../../src/application/job-manager.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, '..', 'fixtures', 'application-job-worker.mjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function terminal(overrides = {}) {
  return {
    version: '1',
    runId: 'run',
    operation: 'cv.build',
    status: 'succeeded',
    startedAt: 10,
    finishedAt: 20,
    exitCode: 0,
    signal: null,
    outputTail: 'PDF generated\n',
    error: null,
    ...overrides,
  };
}

test('destructive concurrency: simultaneous paid CV requests launch exactly one operation', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-ui-jobs-'));
  const completion = deferred();
  const calls = [];
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      idFactory: () => 'cv-42-concurrent',
      execute(request, options) {
        calls.push({ request, options });
        return completion.promise;
      },
    });

    const [first, second] = await Promise.all([
      manager.startCvBuild(42, 'https://jobs.example.com/42', 'reports/042-example.md'),
      manager.startCvBuild(42, 'https://jobs.example.com/42', 'reports/042-example.md'),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(first.id, second.id);
    assert.equal(first.status, 'running');
    assert.equal(calls[0].request.operation, 'cv.build');
    assert.equal(calls[0].request.idempotencyKey, 'cv:42');

    completion.resolve(terminal({ runId: first.id }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await manager.readJob(first.id)).status, 'done');
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('invalid role data is rejected before a claim, job file, or backend call exists', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-ui-invalid-'));
  const jobsDir = join(fixture, 'jobs');
  let calls = 0;
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      execute() {
        calls += 1;
        return Promise.resolve(terminal());
      },
    });

    await assert.rejects(
      manager.startCvBuild('../escape', 'https://jobs.example.com/42', null),
      /positive safe tracker number/u,
    );
    assert.equal(calls, 0);
    assert.equal(existsSync(jobsDir), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('hostile lifecycle output is bounded on disk and cannot corrupt persisted job state', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-ui-output-'));
  const completion = deferred();
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      idFactory: () => 'cv-9-output',
      execute(_request, options) {
        options.onEvent({
          type: 'output',
          text: `${'x'.repeat(100_000)}\nBuilding the PDF\n`,
        });
        return completion.promise;
      },
    });

    const job = await manager.startCvBuild(9, 'https://jobs.example.com/9', null);
    const log = readFileSync(join(jobsDir, `${job.id}.log`), 'utf8');
    assert.ok(log.length <= 64 * 1024);
    assert.match(log, /Building the PDF/u);
    assert.equal((await manager.readJob(job.id)).stage, 'Building the PDF');

    completion.resolve(terminal({
      runId: job.id,
      status: 'failed',
      exitCode: 1,
      outputTail: `${'untrusted\n'.repeat(20)}last six lines survive`,
      error: 'Backend operation exited with code 1.',
    }));
    await new Promise(resolve => setImmediate(resolve));
    const failed = await manager.readJob(job.id);
    assert.equal(failed.status, 'failed');
    assert.ok(failed.tail.split('\n').length <= 6);
    assert.ok(failed.tail.length <= 16 * 1024);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('restart recovery reaps orphaned jobs and ignores malformed state', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-ui-recovery-'));
  const completion = deferred();
  let supervisedCompletion;
  let time = 1_000;
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      now: () => time,
      idFactory: () => 'cv-7-orphaned',
      execute: () => completion.promise,
      onOperation(operation) {
        supervisedCompletion = operation;
      },
    });
    const job = await manager.startCvBuild(7, 'https://jobs.example.com/7', null);

    time += (5 * 60_000) + 10_001;
    const recovered = await manager.readJob(job.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.error, /stopped unexpectedly/u);

    writeFileSync(join(jobsDir, 'cv-8-corrupt.json'), '{"status":"running"}');
    assert.equal(await manager.readJob('cv-8-corrupt'), null);
    assert.equal(await manager.readJob('../../etc/passwd'), null);

    completion.resolve(terminal({ runId: job.id }));
    await supervisedCompletion;
    assert.equal(
      (await manager.readJob(job.id)).status,
      'failed',
      'late process completion resurrected a job already reaped as failed',
    );
  } finally {
    completion.resolve(terminal());
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('durable cancellation marker aborts an operation owned by another manager', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-ui-cancel-'));
  let supervisedCompletion;
  let operationSignal;
  try {
    const owner = createApplicationJobManager({
      jobsDir,
      cancelPollMs: 5,
      idFactory: () => 'cv-15-cancelled',
      execute(_request, options) {
        operationSignal = options.signal;
        return new Promise(resolve => {
          options.signal.addEventListener('abort', () => resolve(terminal({
            runId: 'cv-15-cancelled',
            status: 'cancelled',
            exitCode: null,
            signal: 'SIGTERM',
            error: 'Operation cancelled.',
          })), { once: true });
        });
      },
      onOperation(operation) {
        supervisedCompletion = operation;
      },
    });
    const job = await owner.startCvBuild(15, 'https://jobs.example.com/15', null);
    const remote = createApplicationJobManager({ jobsDir });
    const requested = await remote.cancelJob(job.id);

    assert.equal(requested.status, 'running');
    assert.equal(requested.stage, 'Cancelling');
    await supervisedCompletion;
    assert.equal(operationSignal.aborted, true);
    const finished = await remote.readJob(job.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'The CV build was cancelled.');
    assert.equal(existsSync(join(jobsDir, `${job.id}.cancel`)), false);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('destructive cross-process cancellation reaches the owner without signalling a PID', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-ui-cross-process-cancel-'));
  const child = spawn(process.execPath, [worker, jobsDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    let stdout = '';
    const job = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`worker did not publish its job: ${stderr}`)),
        5_000,
      );
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(stdout.slice(0, newline)));
        } catch (error) {
          reject(error);
        }
      });
      child.once('error', reject);
    });

    const remote = createApplicationJobManager({ jobsDir });
    const requested = await remote.cancelJob(job.id);
    assert.equal(requested.stage, 'Cancelling');
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`worker ignored cancellation: ${stderr}`)),
        5_000,
      );
      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 0, stderr);
    const finished = await remote.readJob(job.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'The CV build was cancelled.');
    assert.equal(
      readdirSync(jobsDir).some(name =>
        name.endsWith('.cancel') || name.endsWith('.lock') || name.endsWith('.tmp')),
      false,
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(jobsDir, { recursive: true, force: true });
  }
});
