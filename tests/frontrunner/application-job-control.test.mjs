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
  validateJobControlRequest,
} from '../../src/application/job-control.mjs';

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

test('job-control accepts only versioned CV starts and contained job reads/cancellations', () => {
  const start = validateJobControlRequest(cvRequest());
  assert.equal(start.action, 'start');
  assert.equal(start.request.operation, 'cv.build');
  assert.equal(Object.isFrozen(start), true);

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

  for (const invalid of [
    { ...cvRequest(), command: '/bin/sh' },
    { ...cvRequest(), version: '2' },
    { version: '1', action: 'read', id: '../../etc/passwd' },
    { version: '1', action: 'cancel', id: '../../etc/passwd' },
    { version: '1', action: 'cancel', id: 'cv-12-abc123', request: {} },
    {
      version: '1',
      action: 'start',
      request: { version: '1', operation: 'scan.run', input: {} },
    },
  ]) {
    assert.throws(() => validateJobControlRequest(invalid));
  }
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
        async startCvBuild() {
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
