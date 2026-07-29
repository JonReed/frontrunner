import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  APPLICATION_API_VERSION,
  validateApplicationRequest,
} from '../../src/application/contract.mjs';
import { resolveApplicationOperation } from '../../src/application/operations.mjs';
import { readBoundedRequest } from '../../src/application/run.mjs';
import { executeApplicationOperation } from '../../src/application/service.mjs';

function request(operation, input = {}, extra = {}) {
  return {
    version: APPLICATION_API_VERSION,
    operation,
    input,
    ...extra,
  };
}

function fakeChild(onSpawn = () => {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  queueMicrotask(() => onSpawn(child));
  return child;
}

test('contract normalizes the current CV-build inputs into frozen application data', () => {
  const normalized = validateApplicationRequest(request('cv.build', {
    roleNum: 42,
    jobUrl: 'https://jobs.example.com/roles/42?from=tracker',
    reportPath: '../reports/042-example-2026-07-29.md',
  }, { idempotencyKey: 'cv:42' }));

  assert.deepEqual(normalized, {
    version: '1',
    operation: 'cv.build',
    input: {
      roleNum: 42,
      jobUrl: 'https://jobs.example.com/roles/42?from=tracker',
      reportPath: 'reports/042-example-2026-07-29.md',
      model: null,
    },
    idempotencyKey: 'cv:42',
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.input), true);
});

test('contract rejects command injection, unknown fields, unsafe paths, and unbounded choices', () => {
  const invalid = [
    request('scan.run; touch /tmp/pwned'),
    request('scan.run', { command: '/bin/sh' }),
    request('cv.build', { roleNum: 0, jobUrl: 'https://example.com/job' }),
    request('cv.build', { roleNum: 1, jobUrl: 'file:///etc/passwd' }),
    request('cv.build', { roleNum: 1, jobUrl: 'https://user:pass@example.com/job' }),
    request('cv.build', {
      roleNum: 1,
      jobUrl: 'https://example.com/job',
      reportPath: '../../etc/passwd',
    }),
    request('pipeline.run', { engine: 'claude; rm -rf .', input: 'data/pipeline.md' }),
    request('pipeline.run', { engine: 'claude', input: '../cv.md' }),
    request('pipeline.run', { engine: 'claude', input: join(ROOT, 'data/pipeline.md') }),
    { ...request('scan.run'), cwd: '/tmp' },
  ];
  for (const candidate of invalid) {
    assert.throws(
      () => validateApplicationRequest(candidate),
      error => error?.code === 'INVALID_APPLICATION_REQUEST',
      JSON.stringify(candidate),
    );
  }

  assert.throws(
    () => validateApplicationRequest(request('scan.run', {}, { version: '2' })),
    error => error?.code === 'UNSUPPORTED_APPLICATION_API_VERSION',
  );
});

test('operation catalog fixes executable, script, cwd, flags, timeout, and spend metadata', () => {
  const cv = resolveApplicationOperation(request('cv.build', {
    roleNum: 7,
    jobUrl: 'https://jobs.example.com/7',
    reportPath: 'reports/007-example-2026-07-29.md',
    model: 'claude-sonnet-5',
  }));
  assert.equal(cv.command, process.execPath);
  assert.equal(cv.cwd, ROOT);
  assert.equal(cv.args[0], join(ROOT, 'src/cv/claude-tailor.mjs'));
  assert.deepEqual(cv.args.slice(1), [
    '--url', 'https://jobs.example.com/7',
    '--tracker', '7',
    '--report', 'reports/007-example-2026-07-29.md',
    '--model', 'claude-sonnet-5',
  ]);
  assert.equal(cv.costsTokens, true);
  assert.equal(cv.dedupeKey, 'cv.build:tracker:7');
  assert.ok(cv.timeoutMs > 0);

  const prepare = resolveApplicationOperation(request('pipeline.prepare', {
    scan: false,
    input: 'data/pipeline.md',
  }));
  assert.equal(prepare.command, process.execPath);
  assert.equal(prepare.args[0], join(ROOT, 'src/pipeline/run.mjs'));
  assert.ok(prepare.args.includes('--prepare-only'));
  assert.ok(prepare.args.includes('--skip-scan'));
  assert.equal(prepare.costsTokens, false);

  const noModel = resolveApplicationOperation(request('pipeline.run', {
    engine: 'none',
    scan: false,
  }));
  assert.equal(noModel.costsTokens, false);

  const scan = resolveApplicationOperation(request('scan.run'));
  assert.deepEqual(scan.args, [join(ROOT, 'src/scan/scan.mjs'), '--json']);
  assert.equal(scan.costsTokens, false);
});

test('service emits ordered structured events and a bounded successful result', async () => {
  const events = [];
  const calls = [];
  const result = await executeApplicationOperation(request('scan.run'), {
    runId: 'run-success',
    now: (() => {
      let value = 100;
      return () => value++;
    })(),
    onEvent: event => events.push(event),
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return fakeChild((child) => {
        child.stdout.emit('data', Buffer.from('scan started\n'));
        child.stderr.emit('data', Buffer.from('one warning\n'));
        child.emit('close', 0, null);
      });
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.runId, 'run-success');
  assert.equal(result.exitCode, 0);
  assert.match(result.outputTail, /scan started/u);
  assert.match(result.outputTail, /one warning/u);
  assert.deepEqual(events.map(event => event.type), [
    'accepted', 'started', 'output', 'output', 'finished',
  ]);
  assert.deepEqual(events.map(event => event.sequence), [0, 1, 2, 3, 4]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('service bounds emitted chunks and retained output from a hostile backend', async () => {
  const events = [];
  const payload = 'x'.repeat(40_000);
  const result = await executeApplicationOperation(request('scan.run'), {
    onEvent: event => events.push(event),
    spawn() {
      return fakeChild((child) => {
        child.stdout.emit('data', Buffer.from(payload));
        child.emit('close', 1, null);
      });
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.outputTail.length, 16 * 1024);
  const output = events.find(event => event.type === 'output');
  assert.equal(output.text.length, 4 * 1024);
  assert.equal(output.truncated, true);
});

test('cancellation and timeout terminate the child and have distinct results', async () => {
  const controller = new AbortController();
  let cancelledChild;
  const cancelledPromise = executeApplicationOperation(request('scan.run'), {
    signal: controller.signal,
    spawn() {
      cancelledChild = fakeChild();
      queueMicrotask(() => controller.abort());
      return cancelledChild;
    },
  });
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelledChild.kills, ['SIGTERM']);

  let timedChild;
  const timed = await executeApplicationOperation(request('scan.run'), {
    timeoutMs: 5,
    terminationGraceMs: 20,
    spawn() {
      timedChild = fakeChild();
      return timedChild;
    },
  });
  assert.equal(timed.status, 'timed_out');
  assert.deepEqual(timedChild.kills, ['SIGTERM']);
});

test('an already-cancelled request never launches a backend process', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawnCalls = 0;

  const result = await executeApplicationOperation(request('scan.run'), {
    signal: controller.signal,
    spawn() {
      spawnCalls += 1;
      return fakeChild();
    },
  });

  assert.equal(spawnCalls, 0);
  assert.equal(result.status, 'cancelled');
});

test('the stdin protocol rejects oversized and malformed request bodies before execution', async () => {
  await assert.rejects(
    readBoundedRequest(Readable.from([`"${'x'.repeat(70 * 1024)}"`])),
    error => error.code === 'APPLICATION_REQUEST_TOO_LARGE',
  );
  await assert.rejects(
    readBoundedRequest(Readable.from(['{"version":'])),
    SyntaxError,
  );
});

test('destructive CLI probe cannot turn an operation name into shell execution', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-application-injection-'));
  const marker = join(fixture, 'owned');
  try {
    const result = spawnSync(process.execPath, [
      join(ROOT, 'src/application/run.mjs'),
    ], {
      cwd: ROOT,
      input: JSON.stringify(request(`scan.run; touch ${marker}`)),
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false);
    const error = JSON.parse(result.stderr.trim());
    assert.equal(error.type, 'protocol_error');
    assert.match(error.error, /unsupported application operation/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
