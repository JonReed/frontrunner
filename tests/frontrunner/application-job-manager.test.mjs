import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ApplicationOperationBusyError,
  createApplicationJobManager,
} from '../../src/application/job-manager.mjs';

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

function storedScanJob(id, status, startedAt, finishedAt) {
  return {
    id,
    operation: 'scan.run',
    kind: 'scan',
    dedupeKey: 'scan.run',
    costsTokens: false,
    status,
    startedAt,
    staleAt: startedAt + (15 * 60_000) + 10_000,
    stage: 'Starting the scan',
    ...(finishedAt === undefined ? {} : { finishedAt, exitCode: 0 }),
  };
}

test('job retention settings reject disabled bounds', () => {
  assert.throws(
    () => createApplicationJobManager({ terminalJobRetentionMs: -1 }),
    /non-negative integer/u,
  );
  assert.throws(
    () => createApplicationJobManager({ maxTerminalJobs: 0 }),
    /positive integer/u,
  );
  assert.throws(
    () => createApplicationJobManager({ orphanArtifactRetentionMs: 0 }),
    /positive integer/u,
  );
});

test('terminal job retention removes exact old/excess artifacts and preserves running work', async t => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-job-retention-'));
  t.after(() => rmSync(jobsDir, { recursive: true, force: true }));
  const now = 100_000;
  const jobs = [
    storedScanJob('job-scan-running', 'running', 1),
    storedScanJob('job-scan-newest', 'done', 90_000, 99_900),
    storedScanJob('job-scan-recent', 'failed', 89_000, 99_800),
    storedScanJob('job-scan-excess', 'done', 88_000, 99_700),
    storedScanJob('job-scan-expired', 'done', 1, 2),
  ];
  for (const job of jobs) {
    writeFileSync(join(jobsDir, `${job.id}.json`), `${JSON.stringify(job)}\n`);
    writeFileSync(join(jobsDir, `${job.id}.log`), 'bounded log\n');
    writeFileSync(join(jobsDir, `${job.id}.cancel`), '{}\n');
    writeFileSync(join(jobsDir, `${job.id}.progress.json`), '{}\n');
  }
  writeFileSync(join(jobsDir, 'job-scan-expired.log.keep'), 'must survive\n');

  const manager = createApplicationJobManager({
    jobsDir,
    now: () => now,
    terminalJobRetentionMs: 1_000,
    maxTerminalJobs: 2,
  });
  const result = await manager.pruneJobs();

  assert.deepEqual(result, {
    removed: 2,
    retained: 3,
    orphanArtifactsRemoved: 0,
  });
  for (const id of ['job-scan-expired', 'job-scan-excess']) {
    assert.equal(
      readdirSync(jobsDir).some(name => name === `${id}.json`
        || name === `${id}.log`
        || name === `${id}.cancel`
        || name === `${id}.progress.json`),
      false,
    );
  }
  for (const id of ['job-scan-running', 'job-scan-newest', 'job-scan-recent']) {
    assert.equal(existsSync(join(jobsDir, `${id}.json`)), true);
  }
  assert.equal(existsSync(join(jobsDir, 'job-scan-expired.log.keep')), true);
});

test('retention cleanup failure cannot block a valid backend start', async t => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-job-retention-failure-'));
  t.after(() => rmSync(jobsDir, { recursive: true, force: true }));
  const old = storedScanJob('job-scan-oldstate', 'done', 1, 2);
  writeFileSync(join(jobsDir, `${old.id}.json`), `${JSON.stringify(old)}\n`);
  mkdirSync(join(jobsDir, `${old.id}.log`));
  const cleanupErrors = [];
  let supervisedCompletion;
  const manager = createApplicationJobManager({
    jobsDir,
    now: () => 100_000,
    terminalJobRetentionMs: 1,
    idFactory: () => 'job-scan-newstate',
    onCleanupError(error) { cleanupErrors.push(error); },
    onOperation(operation) { supervisedCompletion = operation; },
    execute: async () => terminal({
      runId: 'job-scan-newstate',
      operation: 'scan.run',
      startedAt: 100_000,
      finishedAt: 100_001,
    }),
  });

  const started = await manager.start({
    version: '1',
    operation: 'scan.run',
    input: {},
  });
  await supervisedCompletion;
  assert.equal(started.id, 'job-scan-newstate');
  assert.equal(cleanupErrors.length, 1);
  assert.equal(existsSync(join(jobsDir, 'job-scan-oldstate.json')), true);
});

test('job enumeration ignores oversized and symlinked state without following it', async t => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-job-poison-'));
  t.after(() => rmSync(jobsDir, { recursive: true, force: true }));
  writeFileSync(join(jobsDir, 'job-scan-oversized.json'), 'x'.repeat(40 * 1024));
  writeFileSync(
    join(jobsDir, 'job-scan-reversed.json'),
    `${JSON.stringify(storedScanJob('job-scan-reversed', 'done', 10, 9))}\n`,
  );
  const outside = join(jobsDir, 'outside.json');
  writeFileSync(outside, `${JSON.stringify(
    storedScanJob('job-scan-linked', 'done', 1, 2),
  )}\n`);
  symlinkSync(outside, join(jobsDir, 'job-scan-linked.json'));

  const manager = createApplicationJobManager({ jobsDir });
  assert.deepEqual(await manager.listJobs(), []);
});

test('destructive cleanup removes only old, exact orphan job artifacts', async t => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-job-orphans-'));
  t.after(() => rmSync(jobsDir, { recursive: true, force: true }));
  const now = 2_000_000;
  const old = new Date(now - 10_000);
  const outside = join(jobsDir, 'outside.txt');
  writeFileSync(outside, 'outside survives\n');

  for (const suffix of ['.json', '.log', '.cancel', '.progress.json']) {
    const file = join(jobsDir, `job-scan-orphan${suffix}`);
    writeFileSync(file, suffix === '.json' ? '{bad json\n' : 'debris\n');
    utimesSync(file, old, old);
  }
  const young = join(jobsDir, 'job-scan-young.log');
  writeFileSync(young, 'possibly starting\n');
  const lookalike = join(jobsDir, 'job-scan-orphan.log.keep');
  writeFileSync(lookalike, 'must survive\n');
  const linked = join(jobsDir, 'job-scan-linked.log');
  symlinkSync(outside, linked);

  const manager = createApplicationJobManager({
    jobsDir,
    now: () => now,
    orphanArtifactRetentionMs: 1_000,
  });
  const result = await manager.pruneJobs();

  assert.equal(result.orphanArtifactsRemoved, 4);
  for (const suffix of ['.json', '.log', '.cancel', '.progress.json']) {
    assert.equal(existsSync(join(jobsDir, `job-scan-orphan${suffix}`)), false);
  }
  assert.equal(readFileSync(young, 'utf8'), 'possibly starting\n');
  assert.equal(readFileSync(lookalike, 'utf8'), 'must survive\n');
  assert.equal(readFileSync(linked, 'utf8'), 'outside survives\n');
  assert.equal(readFileSync(outside, 'utf8'), 'outside survives\n');
});

test('destructive cleanup preserves old sidecars belonging to valid jobs', async t => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-job-live-artifacts-'));
  t.after(() => rmSync(jobsDir, { recursive: true, force: true }));
  const now = 2_000_000;
  const old = new Date(now - 10_000);
  const job = storedScanJob('job-scan-stillvalid', 'running', now - 100);
  for (const [suffix, content] of [
    ['.json', `${JSON.stringify(job)}\n`],
    ['.log', 'old but owned\n'],
    ['.cancel', '{}\n'],
    ['.progress.json', '{}\n'],
  ]) {
    const file = join(jobsDir, `${job.id}${suffix}`);
    writeFileSync(file, content);
    utimesSync(file, old, old);
  }

  const manager = createApplicationJobManager({
    jobsDir,
    now: () => now,
    orphanArtifactRetentionMs: 1_000,
  });
  const result = await manager.pruneJobs();

  assert.equal(result.orphanArtifactsRemoved, 0);
  for (const suffix of ['.json', '.log', '.cancel', '.progress.json']) {
    assert.equal(existsSync(join(jobsDir, `${job.id}${suffix}`)), true);
  }
});

test('destructive cleanup removes strict old atomic debris and preserves lookalikes', async t => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-job-atomic-debris-'));
  t.after(() => rmSync(jobsDir, { recursive: true, force: true }));
  const now = 2_000_000;
  const old = new Date(now - 10_000);
  const uuid = '12345678-1234-4123-8123-123456789abc';
  const debris = join(
    jobsDir,
    `.job-scan-debris.progress.json.123.${String(now - 20_000)}.${uuid}.tmp`,
  );
  const lookalike = join(jobsDir, '.job-scan-debris.log.not-a-real-temp.tmp');
  writeFileSync(debris, 'partial\n');
  writeFileSync(lookalike, 'must survive\n');
  utimesSync(debris, old, old);
  utimesSync(lookalike, old, old);

  const manager = createApplicationJobManager({
    jobsDir,
    now: () => now,
    orphanArtifactRetentionMs: 1_000,
  });
  const result = await manager.pruneJobs();

  assert.equal(result.orphanArtifactsRemoved, 1);
  assert.equal(existsSync(debris), false);
  assert.equal(readFileSync(lookalike, 'utf8'), 'must survive\n');
});

test('destructive race: orphan cleanup cannot remove a concurrently started job', async t => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-job-cleanup-race-'));
  t.after(() => rmSync(jobsDir, { recursive: true, force: true }));
  const now = 2_000_000;
  const oldLog = join(jobsDir, 'job-scan-racing.log');
  writeFileSync(oldLog, 'abandoned prior launch\n');
  const old = new Date(now - 10_000);
  utimesSync(oldLog, old, old);
  const completion = deferred();
  let supervisedCompletion;
  const common = {
    jobsDir,
    now: () => now,
    orphanArtifactRetentionMs: 1_000,
  };
  const starter = createApplicationJobManager({
    ...common,
    idFactory: () => 'job-scan-racing',
    execute: () => completion.promise,
    onOperation(operation) { supervisedCompletion = operation; },
  });
  const cleaner = createApplicationJobManager(common);

  const [started] = await Promise.all([
    starter.start({
      version: '1',
      operation: 'scan.run',
      input: {},
    }),
    cleaner.pruneJobs(),
  ]);

  assert.equal(started.status, 'running');
  assert.equal((await starter.readJob(started.id)).status, 'running');
  assert.equal(existsSync(join(jobsDir, `${started.id}.log`)), true);

  completion.resolve(terminal({
    runId: started.id,
    operation: 'scan.run',
    startedAt: now,
    finishedAt: now + 1,
  }));
  await supervisedCompletion;
});

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

test('destructive concurrency: simultaneous pipeline requests launch exactly one durable operation', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-jobs-'));
  const completion = deferred();
  const calls = [];
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      idFactory: () => 'job-pipeline-concurrent',
      execute(request, options) {
        calls.push({ request, options });
        return completion.promise;
      },
    });
    const request = {
      version: '1',
      operation: 'pipeline.run',
      input: {
        engine: 'claude',
        scan: true,
        input: 'data/pipeline.md',
      },
    };
    const [first, second] = await Promise.all([
      manager.start({ ...request, idempotencyKey: 'caller-one' }),
      manager.start({ ...request, idempotencyKey: 'caller-two' }),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(first.id, second.id);
    assert.equal(first.operation, 'pipeline.run');
    assert.equal(first.kind, 'pipeline');
    assert.equal(first.dedupeKey, 'pipeline.run');
    assert.equal(first.costsTokens, true);
    assert.equal(first.roleNum, undefined);
    assert.ok(first.staleAt - first.startedAt > 30 * 60_000);
    assert.equal((await manager.runningJobForDedupeKey('pipeline.run')).id, first.id);

    completion.resolve(terminal({
      runId: first.id,
      operation: 'pipeline.run',
      outputTail: 'Scanning\nCaching\nLiveness\nPrefilter\nEvaluating\nComplete\n',
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await manager.readJob(first.id)).status, 'done');
  } finally {
    completion.resolve(terminal({ operation: 'pipeline.run' }));
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('poisoned generic state cannot invent a dedupe key or shorten recovery time', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-poisoned-job-'));
  try {
    const base = {
      id: 'job-pipeline-poisoned',
      operation: 'pipeline.run',
      kind: 'pipeline',
      dedupeKey: 'attacker-selected',
      costsTokens: true,
      status: 'running',
      startedAt: 1,
      staleAt: 2,
      stage: 'Starting the pipeline',
    };
    writeFileSync(
      join(jobsDir, `${base.id}.json`),
      `${JSON.stringify(base)}\n`,
    );
    const manager = createApplicationJobManager({ jobsDir, now: () => 10 });
    assert.equal(await manager.readJob(base.id), null);

    writeFileSync(
      join(jobsDir, `${base.id}.json`),
      `${JSON.stringify({
        ...base,
        dedupeKey: 'pipeline.run',
        staleAt: undefined,
      })}\n`,
    );
    assert.equal(await manager.readJob(base.id), null);
  } finally {
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('destructive concurrency: scan and pipeline operations share one resource claim', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-operation-jobs-'));
  const completion = deferred();
  const calls = [];
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      idFactory: () => 'job-scan-exclusive',
      execute(request) {
        calls.push(request.operation);
        return completion.promise;
      },
    });
    const scan = await manager.start({
      version: '1',
      operation: 'scan.run',
      input: {},
      idempotencyKey: 'caller-scan-label',
    });
    await assert.rejects(
      manager.start({
        version: '1',
        operation: 'pipeline.prepare',
        input: { scan: false, input: 'data/pipeline.md' },
        idempotencyKey: 'caller-tries-to-split-the-claim',
      }),
      error => {
        assert.equal(error instanceof ApplicationOperationBusyError, true);
        assert.equal(error.code, 'APPLICATION_OPERATION_BUSY');
        assert.equal(error.requestedOperation, 'pipeline.prepare');
        assert.deepEqual(error.activeJob, {
          id: scan.id,
          operation: 'scan.run',
          startedAt: scan.startedAt,
          costsTokens: false,
        });
        assert.equal(Object.isFrozen(error.activeJob), true);
        return true;
      },
    );

    assert.deepEqual(calls, ['scan.run']);
    assert.equal(scan.costsTokens, false);

    completion.resolve(terminal({ operation: 'scan.run' }));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    completion.resolve(terminal({ operation: 'scan.run' }));
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('destructive concurrency: simultaneous different pipeline operations launch only one', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-shared-resource-race-'));
  const completion = deferred();
  const calls = [];
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      idFactory: request => request.operation === 'scan.run'
        ? 'job-scan-race'
        : 'job-pipeline-race',
      execute(request) {
        calls.push(request.operation);
        return completion.promise;
      },
    });
    const results = await Promise.allSettled([
      manager.start({ version: '1', operation: 'scan.run', input: {} }),
      manager.start({
        version: '1',
        operation: 'pipeline.run',
        input: { engine: 'claude', scan: true, input: 'data/pipeline.md' },
      }),
    ]);

    const started = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    assert.equal(started.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(rejected[0].reason.code, 'APPLICATION_OPERATION_BUSY');
    assert.equal(rejected[0].reason.activeJob.id, started[0].value.id);
    assert.equal(rejected[0].reason.activeJob.operation, started[0].value.operation);

    completion.resolve(terminal({ operation: calls[0] }));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    completion.resolve(terminal());
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('independent CV resources can run beside pipeline state and each other', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-independent-resources-'));
  const completions = new Map();
  const calls = [];
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      idFactory(request) {
        if (request.operation === 'scan.run') return 'job-scan-withcvs';
        return `cv-${String(request.input.roleNum)}-independent`;
      },
      execute(request) {
        calls.push(request.operation === 'cv.build'
          ? `${request.operation}:${String(request.input.roleNum)}`
          : request.operation);
        const pending = deferred();
        completions.set(calls.at(-1), pending);
        return pending.promise;
      },
    });
    const scan = await manager.start({
      version: '1',
      operation: 'scan.run',
      input: {},
    });
    const firstCv = await manager.start({
      version: '1',
      operation: 'cv.build',
      input: { roleNum: 41, jobUrl: 'https://jobs.example.com/41' },
    });
    const secondCv = await manager.start({
      version: '1',
      operation: 'cv.build',
      input: { roleNum: 42, jobUrl: 'https://jobs.example.com/42' },
    });

    assert.deepEqual(calls, ['scan.run', 'cv.build:41', 'cv.build:42']);
    assert.equal(scan.costsTokens, false);
    assert.equal(firstCv.costsTokens, true);
    assert.equal(secondCv.costsTokens, true);

    for (const [key, pending] of completions) {
      pending.resolve(terminal({
        operation: key.startsWith('cv.build') ? 'cv.build' : key,
      }));
    }
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    for (const pending of completions.values()) pending.resolve(terminal());
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('terminal pipeline state no longer blocks a related operation', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-terminal-resource-'));
  let now = 10;
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      now: () => now,
      idFactory: request => request.operation === 'scan.run'
        ? 'job-scan-terminal'
        : 'job-prepare-afterscan',
      execute(request) {
        return Promise.resolve(terminal({
          operation: request.operation,
          startedAt: now,
          finishedAt: now + 1,
        }));
      },
    });
    const scan = await manager.start({
      version: '1',
      operation: 'scan.run',
      input: {},
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await manager.readJob(scan.id)).status, 'done');

    now = 20;
    const prepare = await manager.start({
      version: '1',
      operation: 'pipeline.prepare',
      input: { scan: false, input: 'data/pipeline.md' },
    });
    assert.equal(prepare.operation, 'pipeline.prepare');
    assert.notEqual(prepare.id, scan.id);
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

test('invalid pipeline data is rejected before a claim, job file, or backend call exists', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-invalid-'));
  const jobsDir = join(fixture, 'jobs');
  let calls = 0;
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      execute() {
        calls += 1;
        return Promise.resolve(terminal({ operation: 'pipeline.run' }));
      },
    });
    await assert.rejects(
      manager.start({
        version: '1',
        operation: 'pipeline.run',
        input: {
          engine: 'claude',
          scan: true,
          input: '../cv.md',
        },
      }),
      /escapes its allowed directory/u,
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

test('structured pipeline progress survives reload and outranks hostile log prose', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-progress-'));
  const completion = deferred();
  let supervisedCompletion;
  let emit;
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      idFactory: () => 'job-pipeline-progress',
      execute(_request, options) {
        emit = options.onEvent;
        options.onEvent({
          type: 'progress',
          stage: 'cache',
          state: 'started',
          at: 100,
        });
        options.onEvent({
          type: 'output',
          text: 'evaluation complete according to malicious human-readable output\n',
        });
        return completion.promise;
      },
      onOperation(operation) {
        supervisedCompletion = operation;
      },
    });
    const job = await manager.start({
      version: '1',
      operation: 'pipeline.run',
      input: { engine: 'claude', scan: true, input: 'data/pipeline.md' },
    });
    assert.equal((await manager.readJob(job.id)).stage, 'Caching job descriptions');

    emit({ type: 'progress', stage: 'liveness', state: 'started', at: 110 });
    emit({ type: 'progress', stage: 'cache', state: 'started', at: 120 });
    const reloaded = createApplicationJobManager({ jobsDir });
    assert.equal(
      (await reloaded.readJob(job.id)).stage,
      'Checking which roles are still live',
      'out-of-order progress regressed after reload',
    );

    completion.resolve(terminal({
      runId: job.id,
      operation: 'pipeline.run',
    }));
    await supervisedCompletion;
    assert.equal(existsSync(join(jobsDir, `${job.id}.progress.json`)), false);
  } finally {
    completion.resolve(terminal({ operation: 'pipeline.run' }));
    rmSync(jobsDir, { recursive: true, force: true });
  }
});

test('restart recovery reaps orphaned jobs and ignores malformed state', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-ui-recovery-'));
  const completion = deferred();
  const audits = [];
  let supervisedCompletion;
  let time = 1_000;
  try {
    const manager = createApplicationJobManager({
      jobsDir,
      now: () => time,
      idFactory: () => 'cv-7-orphaned',
      execute: () => completion.promise,
      auditWriter(record) {
        audits.push(record);
      },
      onOperation(operation) {
        supervisedCompletion = operation;
      },
    });
    const job = await manager.startCvBuild(7, 'https://jobs.example.com/7', null);

    time += (5 * 60_000) + 10_001;
    const recovered = await manager.readJob(job.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.error, /stopped unexpectedly/u);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].runId, job.id);
    assert.equal(audits[0].status, 'timed_out');
    assert.equal(audits[0].costsTokens, true);

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
    assert.equal(audits.length, 1, 'late completion duplicated the terminal audit');
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

test('durable cancellation works for a non-CV operation without sharing a PID', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-scan-cancel-'));
  let supervisedCompletion;
  let operationSignal;
  try {
    const owner = createApplicationJobManager({
      jobsDir,
      cancelPollMs: 5,
      idFactory: () => 'job-scan-cancelled',
      execute(_request, options) {
        operationSignal = options.signal;
        return new Promise(resolve => {
          options.signal.addEventListener('abort', () => resolve(terminal({
            runId: 'job-scan-cancelled',
            operation: 'scan.run',
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
    const job = await owner.start({
      version: '1',
      operation: 'scan.run',
      input: {},
    });
    const remote = createApplicationJobManager({ jobsDir });
    assert.equal((await remote.cancelJob(job.id)).stage, 'Cancelling');
    await supervisedCompletion;
    assert.equal(operationSignal.aborted, true);
    const finished = await remote.readJob(job.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'The backend operation was cancelled.');
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

test('destructive cross-process pipeline cancellation reaches its owner through durable state', async () => {
  const jobsDir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-cross-process-cancel-'));
  const child = spawn(process.execPath, [worker, jobsDir, 'pipeline.run'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    let stdout = '';
    const job = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`pipeline worker did not publish its job: ${stderr}`)),
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

    assert.equal(job.operation, 'pipeline.run');
    assert.equal(job.costsTokens, true);
    const remote = createApplicationJobManager({ jobsDir });
    assert.equal((await remote.cancelJob(job.id)).stage, 'Cancelling');
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`pipeline worker ignored cancellation: ${stderr}`)),
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
    assert.equal(finished.error, 'The backend operation was cancelled.');
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
