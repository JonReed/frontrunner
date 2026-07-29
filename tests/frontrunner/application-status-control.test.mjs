import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  buildRestoreStatusArgs,
  buildSetStatusArgs,
  main,
  runSetStatus,
  validateStatusRequest,
} from '../../src/application/status-control.mjs';

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

test('status control accepts only an honest bounded tracker decision', () => {
  const request = validateStatusRequest({
    version: '1',
    action: 'set',
    roleNum: 42,
    state: 'Applied',
    note: 'sent via referral',
  }, new Set(['Evaluated', 'Applied', 'Responded', 'Discarded', 'SKIP']));
  assert.deepEqual(request, {
    version: '1',
    action: 'set',
    roleNum: 42,
    state: 'Applied',
    note: 'sent via referral',
  });
  assert.equal(Object.isFrozen(request), true);

  for (const state of ['Evaluated', 'Responded']) {
    assert.equal(validateStatusRequest({
      version: '1',
      action: 'set',
      roleNum: 42,
      state,
    }, new Set(['Evaluated', 'Responded'])).state, state);
  }

  for (const hostile of [
    null,
    [],
    { ...request, command: '/bin/sh' },
    { ...request, roleNum: '../data/applications.md' },
    { ...request, state: 'Hired' },
    { ...request, note: 'break | the row' },
    { ...request, note: 'line one\nline two' },
    { ...request, note: 'x'.repeat(301) },
  ]) {
    assert.throws(() => validateStatusRequest(
      hostile,
      new Set(['Evaluated', 'Applied', 'Responded', 'Discarded', 'SKIP']),
    ));
  }
});

test('status control builds one fixed canonical writer invocation', () => {
  const args = buildSetStatusArgs({
    roleNum: 42,
    state: 'Applied',
    note: 'sent via referral',
  });
  assert.deepEqual(args, [
    join(ROOT, 'src', 'tracker', 'set-status.mjs'),
    '42',
    'Applied',
    '--json',
    '--note',
    'sent via referral',
  ]);
});

test('status restore derives the prior state from the tracker, not the request', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-status-restore-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const tracker = join(fixture, 'applications.md');
  writeFileSync(tracker, `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 42 | 2026-07-29 | Acme | Director | 4.2/5 | Discarded | ❌ | — | [frontrunner-before:Interview:active] |
`);
  const previous = process.env.FRONTRUNNER_TRACKER;
  process.env.FRONTRUNNER_TRACKER = tracker;
  try {
    assert.deepEqual(
      validateStatusRequest({ version: '1', action: 'restore', roleNum: 42 }),
      { version: '1', action: 'restore', roleNum: 42 },
    );
    assert.deepEqual(
      buildRestoreStatusArgs(42, new Set(['Interview'])),
      [
        join(ROOT, 'src', 'tracker', 'set-status.mjs'),
        '42',
        'Interview',
        '--json',
      ],
    );
  } finally {
    if (previous === undefined) delete process.env.FRONTRUNNER_TRACKER;
    else process.env.FRONTRUNNER_TRACKER = previous;
  }
});

test('an already-cancelled status request never launches the tracker writer', async () => {
  const controller = new AbortController();
  controller.abort();
  let launched = 0;
  await assert.rejects(
    runSetStatus(['fixed'], {
      signal: controller.signal,
      spawn() {
        launched += 1;
      },
    }),
    error => error?.code === 'STATUS_CANCELLED',
  );
  assert.equal(launched, 0);
});

test('hostile status-writer output stops the complete process tree', async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  const result = runSetStatus(['fixed'], {
    spawn() {
      queueMicrotask(() => child.stdout.write('x'.repeat(70 * 1024)));
      return child;
    },
    platform: 'linux',
    processKill(pid, signal) {
      signals.push({ pid, signal });
    },
    terminationGraceMs: 1,
    timeoutMs: 5_000,
  });

  await assert.rejects(
    result,
    error => error?.code === 'STATUS_OUTPUT_TOO_LARGE',
  );
  assert.deepEqual(signals, [
    { pid: -4321, signal: 'SIGTERM' },
    { pid: -4321, signal: 'SIGKILL' },
  ]);
});

test('destructive timeout kills status-writer descendants before they mutate state', {
  skip: process.platform === 'win32',
}, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-status-tree-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const parentScript = join(fixture, 'parent.mjs');
  const marker = join(fixture, 'late-tracker-write');
  const grandchildCode = `
    process.on('SIGTERM', () => {});
    setTimeout(
      () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'),
      450,
    );
    setInterval(() => {}, 1_000);
  `;
  writeFileSync(parentScript, `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {
      stdio: 'ignore',
    });
    setInterval(() => {}, 1_000);
  `);

  let spawnOptions;
  await assert.rejects(
    runSetStatus(['request-data-never-becomes-this-command'], {
      timeoutMs: 150,
      terminationGraceMs: 100,
      spawn(_command, _args, options) {
        spawnOptions = options;
        return nodeSpawn(process.execPath, [parentScript], options);
      },
    }),
    error => error?.code === 'STATUS_TIMEOUT',
  );
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.cwd, ROOT);

  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(
    existsSync(marker),
    false,
    'a descendant changed tracker state after status-control reported a timeout',
  );
});

test('status-control emits a stable operational error and no success on timeout', async () => {
  const output = outputSink();
  const errorOutput = outputSink();
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const result = await main({
      input: Readable.from([JSON.stringify({
        version: '1',
        action: 'set',
        roleNum: 42,
        state: 'Applied',
      })]),
      output: output.stream,
      errorOutput: errorOutput.stream,
      async runStatus(_args, options) {
        assert.equal(options.signal.aborted, false);
        const error = new Error('the tracker did not respond in time');
        error.code = 'STATUS_TIMEOUT';
        throw error;
      },
    });

    assert.equal(result, null);
    assert.equal(output.body(), '');
    assert.equal(process.exitCode, 1);
    assert.deepEqual(JSON.parse(errorOutput.body()), {
      version: '1',
      type: 'status_error',
      error: 'the tracker did not respond in time',
      code: 'STATUS_TIMEOUT',
    });
  } finally {
    process.exitCode = previousExitCode;
  }
});
