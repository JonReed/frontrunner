import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  shouldDetachProcessTree,
  signalProcessTree,
} from '../../src/application/process-tree.mjs';
import { executeApplicationOperation } from '../../src/application/service.mjs';

test('POSIX supervision uses a dedicated process group and signals its negative PID', () => {
  const calls = [];
  const child = {
    pid: 4321,
    kill() {
      assert.fail('direct-child fallback must not run when group signalling succeeds');
    },
  };

  assert.equal(shouldDetachProcessTree('linux'), true);
  assert.equal(shouldDetachProcessTree('darwin'), true);
  assert.equal(shouldDetachProcessTree('win32'), false);
  assert.equal(signalProcessTree(child, 'SIGTERM', {
    platform: 'linux',
    processKill(pid, signal) {
      calls.push({ pid, signal });
    },
  }), true);
  assert.deepEqual(calls, [{ pid: -4321, signal: 'SIGTERM' }]);
});

test('Windows supervision invokes only fixed taskkill tree arguments', () => {
  const calls = [];
  const child = {
    pid: 987,
    kill() {
      assert.fail('direct-child fallback must not run when taskkill succeeds');
    },
  };
  const windowsTreeKill = (pid, force) => {
    calls.push({ pid, force });
    return true;
  };

  assert.equal(signalProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    windowsTreeKill,
  }), true);
  assert.equal(signalProcessTree(child, 'SIGKILL', {
    platform: 'win32',
    windowsTreeKill,
  }), true);
  assert.deepEqual(calls, [
    { pid: 987, force: false },
    { pid: 987, force: true },
  ]);
});

test('tree-signal failure degrades to direct-child termination', () => {
  const calls = [];
  const child = {
    pid: 1234,
    kill(signal) {
      calls.push(signal);
      return true;
    },
  };

  assert.equal(signalProcessTree(child, 'SIGTERM', {
    platform: 'linux',
    processKill() {
      const error = new Error('process groups unavailable');
      error.code = 'EPERM';
      throw error;
    },
  }), true);
  assert.deepEqual(calls, ['SIGTERM']);
});

test('destructive cancellation kills a grandchild before it can mutate state', {
  skip: process.platform === 'win32',
}, async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-process-tree-'));
  const parentScript = join(fixture, 'parent.mjs');
  const marker = join(fixture, 'descendant-survived');
  const grandchildCode = `
    process.on('SIGTERM', () => {});
    process.stdout.write('grandchild-ready\\\\n');
    setTimeout(
      () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'),
      250,
    );
    setInterval(() => {}, 1_000);
  `;
  let descendantStarted = false;

  try {
    writeFileSync(parentScript, `
      import { spawn } from 'node:child_process';
      const grandchild = spawn(process.execPath, [
        '-e',
        ${JSON.stringify(grandchildCode)},
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      grandchild.stdout.once('data', () => process.stdout.write('grandchild-ready\\n'));
      setInterval(() => {}, 1_000);
    `);

    const controller = new AbortController();
    const resultPromise = executeApplicationOperation({
      version: '1',
      operation: 'test.tree',
      input: {},
    }, {
      signal: controller.signal,
      terminationGraceMs: 75,
      resolveOperation(request) {
        return {
          request,
          command: process.execPath,
          args: [parentScript],
          cwd: fixture,
          timeoutMs: 5_000,
          costsTokens: true,
          dedupeKey: 'test.tree',
        };
      },
      onEvent(event) {
        if (event.type === 'output' && event.text.includes('grandchild-ready')) {
          descendantStarted = true;
          controller.abort();
        }
      },
    });

    const result = await resultPromise;
    assert.equal(descendantStarted, true);
    assert.equal(result.status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(
      existsSync(marker),
      false,
      'a descendant survived cancellation and wrote after the job was terminal',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
