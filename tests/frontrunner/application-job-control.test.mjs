import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  main,
  summarizeApplicationJob,
  validateJobControlRequest,
} from '../../src/application/job-control.mjs';
import { ApplicationOperationBusyError } from '../../src/application/job-manager.mjs';

function cvRequest(overrides = {}) {
  return {
    version: '1',
    action: 'start',
    request: {
      version: '1',
      operation: 'cv.build',
      input: {
        roleNum: 12,
        jobUrl: 'https://jobs.example.com/12',
        reportPath: 'reports/012-example.md',
      },
      idempotencyKey: 'cv:12',
    },
    ...overrides,
  };
}

function outputSink() {
  let body = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { stream, body: () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('job-control accepts every versioned catalog operation and contained job reads/cancellations', () => {
  const start = validateJobControlRequest(cvRequest());
  assert.equal(start.action, 'start');
  assert.equal(start.request.operation, 'cv.build');
  assert.equal(Object.isFrozen(start), true);

  for (const operation of [
    { operation: 'scan.run', input: {} },
    { operation: 'pipeline.prepare', input: { scan: true, input: 'data/pipeline.md' } },
    { operation: 'pipeline.run', input: { engine: 'claude', scan: true, input: 'data/pipeline.md' } },
  ]) {
    const generic = validateJobControlRequest({
      version: '1',
      action: 'start',
      request: { version: '1', ...operation },
    });
    assert.equal(generic.request.operation, operation.operation);
  }

  const read = validateJobControlRequest({
    version: '1',
    action: 'read',
    id: 'cv-12-abc123',
  });
  assert.equal(read.id, 'cv-12-abc123');

  const cancel = validateJobControlRequest({
    version: '1',
    action: 'cancel',
    id: 'cv-12-abc123',
  });
  assert.equal(cancel.action, 'cancel');
  assert.equal(cancel.id, 'cv-12-abc123');
  assert.equal(validateJobControlRequest({
    version: '1',
    action: 'read',
    id: 'job-pipeline-abc123',
  }).id, 'job-pipeline-abc123');

  assert.deepEqual(validateJobControlRequest({
    version: '1',
    action: 'list',
    limit: 10,
    operation: 'pipeline.run',
    status: 'running',
  }), {
    version: '1',
    action: 'list',
    limit: 10,
    operation: 'pipeline.run',
    status: 'running',
  });
  assert.deepEqual(validateJobControlRequest({
    version: '1',
    action: 'history',
    status: 'timed_out',
  }), {
    version: '1',
    action: 'history',
    limit: 20,
    operation: null,
    status: 'timed_out',
  });

  for (const invalid of [
    { ...cvRequest(), command: '/bin/sh' },
    { ...cvRequest(), version: '2' },
    { version: '1', action: 'read', id: '../../etc/passwd' },
    { version: '1', action: 'cancel', id: '../../etc/passwd' },
    { version: '1', action: 'cancel', id: 'cv-12-abc123', request: {} },
    {
      version: '1',
      action: 'start',
      request: { version: '1', operation: 'scan.run', input: { command: '/bin/sh' } },
    },
    { version: '1', action: 'read', id: 'job-unknown-abc123' },
    { version: '1', action: 'list', limit: 51 },
    { version: '1', action: 'list', status: 'succeeded' },
    { version: '1', action: 'history', status: 'running' },
    { version: '1', action: 'history', operation: 'unknown.run' },
    { ...cvRequest(), limit: 5 },
  ]) {
    assert.throws(() => validateJobControlRequest(invalid));
  }
});

test('job-control list returns bounded summaries without logs or internal claims', async () => {
  const output = outputSink();
  let pruned = 0;
  const jobs = [
    {
      id: 'job-pipeline-newest',
      operation: 'pipeline.run',
      kind: 'pipeline',
      status: 'running',
      stage: 'Evaluating the shortlist',
      startedAt: 30,
      costsTokens: true,
      tail: 'hostile model output',
      dedupeKey: 'pipeline.run',
    },
    {
      id: 'job-scan-older',
      operation: 'scan.run',
      kind: 'scan',
      status: 'done',
      startedAt: 20,
      finishedAt: 25,
      costsTokens: false,
    },
  ];
  const response = await main({
    input: Readable.from([JSON.stringify({
      version: '1',
      action: 'list',
      operation: 'pipeline.run',
      limit: 1,
    })]),
    output: output.stream,
    errorOutput: outputSink().stream,
    managerFactory() {
      return {
        async pruneJobsSafely() { pruned += 1; },
        async listJobs() { return jobs; },
      };
    },
  });

  assert.equal(response.jobs.length, 1);
  assert.equal(pruned, 1);
  assert.equal(response.jobs[0].id, 'job-pipeline-newest');
  assert.equal(response.jobs[0].stage, 'Evaluating the shortlist');
  assert.equal(response.jobs[0].costsTokens, true);
  assert.doesNotMatch(JSON.stringify(response), /hostile model output|dedupeKey/u);
  assert.deepEqual(JSON.parse(output.body()), response);
  assert.equal(Object.isFrozen(summarizeApplicationJob(jobs[0])), true);
});

test('job-control history delegates only validated bounded filters', async () => {
  const output = outputSink();
  let received;
  const record = {
    version: '1',
    runId: 'job-pipeline-history',
    operation: 'pipeline.run',
    status: 'failed',
    startedAt: 10,
    finishedAt: 20,
    durationMs: 10,
    costsTokens: true,
  };
  const response = await main({
    input: Readable.from([JSON.stringify({
      version: '1',
      action: 'history',
      operation: 'pipeline.run',
      status: 'failed',
      limit: 7,
    })]),
    output: output.stream,
    errorOutput: outputSink().stream,
    managerFactory() {
      return {};
    },
    historyReader(options) {
      received = options;
      return Object.freeze([Object.freeze(record)]);
    },
  });

  assert.deepEqual(received, {
    limit: 7,
    operation: 'pipeline.run',
    status: 'failed',
  });
  assert.deepEqual(response.records, [record]);
  assert.deepEqual(JSON.parse(output.body()), response);
});

test('job-control cancellation delegates only a validated opaque job id', async () => {
  const output = outputSink();
  const expected = {
    id: 'cv-12-abc123',
    roleNum: 12,
    kind: 'build-cv',
    status: 'running',
    startedAt: 10,
    stage: 'Cancelling',
  };
  const result = await main({
    input: Readable.from([JSON.stringify({
      version: '1',
      action: 'cancel',
      id: expected.id,
    })]),
    output: output.stream,
    errorOutput: outputSink().stream,
    managerFactory() {
      return {
        async cancelJob(id) {
          assert.equal(id, expected.id);
          return expected;
        },
      };
    },
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(JSON.parse(output.body()), expected);
});

test('job-control read returns one bounded JSON record from the persistent manager', async () => {
  const output = outputSink();
  const errorOutput = outputSink();
  const expected = {
    id: 'cv-12-abc123',
    roleNum: 12,
    kind: 'build-cv',
    status: 'running',
    startedAt: 10,
  };
  const result = await main({
    input: Readable.from([JSON.stringify({
      version: '1',
      action: 'read',
      id: expected.id,
    })]),
    output: output.stream,
    errorOutput: errorOutput.stream,
    managerFactory() {
      return {
        readJob(id) {
          assert.equal(id, expected.id);
          return expected;
        },
      };
    },
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(JSON.parse(output.body()), expected);
  assert.equal(errorOutput.body(), '');
});

test('job-control responds with the job immediately but stays alive for supervision', async () => {
  const output = outputSink();
  const completion = deferred();
  let finished = false;
  const run = main({
    input: Readable.from([JSON.stringify(cvRequest())]),
    output: output.stream,
    errorOutput: outputSink().stream,
    managerFactory(options) {
      return {
        async start(request) {
          assert.equal(request.operation, 'cv.build');
          options.onOperation(completion.promise);
          return {
            id: 'cv-12-supervised',
            roleNum: 12,
            kind: 'build-cv',
            status: 'running',
            startedAt: 10,
          };
        },
      };
    },
  }).then(() => {
    finished = true;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.match(output.body(), /cv-12-supervised/u);
  assert.equal(finished, false);
  completion.resolve();
  await run;
  assert.equal(finished, true);
});

test('job-control exposes a stable bounded busy response for conflicting operations', async () => {
  const output = outputSink();
  const errorOutput = outputSink();
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const result = await main({
      input: Readable.from([JSON.stringify({
        version: '1',
        action: 'start',
        request: {
          version: '1',
          operation: 'pipeline.run',
          input: { engine: 'claude', scan: true, input: 'data/pipeline.md' },
        },
      })]),
      output: output.stream,
      errorOutput: errorOutput.stream,
      managerFactory() {
        return {
          async start() {
            throw new ApplicationOperationBusyError('pipeline.run', {
              id: 'job-scan-active123',
              operation: 'scan.run',
              kind: 'scan',
              status: 'running',
              startedAt: 123,
              costsTokens: false,
            });
          },
        };
      },
    });

    assert.equal(result, null);
    assert.equal(output.body(), '');
    assert.equal(process.exitCode, 1);
    assert.deepEqual(JSON.parse(errorOutput.body()), {
      version: '1',
      type: 'operation_busy',
      error: 'pipeline.run cannot start while scan.run is running as job-scan-active123',
      code: 'APPLICATION_OPERATION_BUSY',
      requestedOperation: 'pipeline.run',
      activeJob: {
        id: 'job-scan-active123',
        operation: 'scan.run',
        startedAt: 123,
        costsTokens: false,
      },
    });
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('destructive job-control probe cannot turn request data into shell execution', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-job-control-injection-'));
  const marker = join(fixture, 'owned');
  try {
    const result = spawnSync(process.execPath, [
      join(ROOT, 'src/application/job-control.mjs'),
    ], {
      cwd: ROOT,
      input: JSON.stringify({
        version: '1',
        action: `read; touch ${marker}`,
        id: 'cv-1-safe',
      }),
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false);
    const error = JSON.parse(result.stderr.trim());
    assert.equal(error.type, 'protocol_error');
    assert.match(error.error, /unsupported job-control action/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
