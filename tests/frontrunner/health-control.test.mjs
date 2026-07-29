/**
 * health-control.test.mjs
 *
 * The read-only boundary that answers "can Frontrunner work right now?".
 *
 * Two things matter: it must never leak fields the interface has no business
 * rendering, and every way of failing must resolve to a state rather than
 * throw. A health check that can crash is worse than none — it takes down the
 * page whose job is to still work when the engine does not.
 */

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
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  validateHealthRequest,
  summariseAuth,
  notInstalled,
  readAuthStatus,
  startSignIn,
} from '../../src/application/health-control.mjs';

/** Minimal stand-in for a spawned child. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

const spawnReturning = (stdout, { exitCode = 0, error } = {}) => () => {
  const child = fakeChild();
  queueMicrotask(() => {
    if (error) { child.emit('error', error); return; }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode);
  });
  return child;
};

test('accepts only a read request at the current version', () => {
  assert.equal(validateHealthRequest({ version: '1', action: 'read' }).action, 'read');
  assert.throws(() => validateHealthRequest({ version: '1', action: 'login' }), /unsupported/);
  assert.throws(() => validateHealthRequest({ version: '2', action: 'read' }), /unsupported/);
  assert.throws(() => validateHealthRequest({ version: '1', action: 'read', cmd: 'x' }), /unsupported/);
  assert.throws(() => validateHealthRequest(null), /plain object/);
  assert.throws(() => validateHealthRequest([]), /plain object/);
});

test('only read and connect are actions — nothing else', () => {
  for (const action of ['login', 'signin', 'auth', 'setup', 'write', 'logout']) {
    assert.throws(() => validateHealthRequest({ version: '1', action }), /unsupported/, action);
  }
  assert.equal(validateHealthRequest({ version: '1', action: 'connect' }).action, 'connect');
});

test('sign-in argv is fixed, detached, and never uses a shell', () => {
  let captured = null;
  startSignIn({ spawn: (cmd, args, opts) => { captured = { cmd, args, opts }; return { unref() {} }; } });
  assert.equal(captured.cmd, 'claude');
  // --claudeai is explicit rather than assumed: the alternative (--console)
  // puts the user on API billing instead of their subscription.
  assert.deepEqual(captured.args, ['auth', 'login', '--claudeai']);
  assert.equal(captured.opts.shell, false);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.stdio, 'ignore');
});

test('a missing CLI makes sign-in report failure rather than throw', () => {
  const result = startSignIn({ spawn: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(result, { started: false });
});

test('summarise keeps only the fields the interface needs', () => {
  const summary = summariseAuth(JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'someone@example.com',
    orgId: '04ea783c-489c-4673-9624-6e2804bfca75',
    orgName: "someone@example.com's Organization",
    subscriptionType: 'max',
  }));

  assert.deepEqual(Object.keys(summary).sort(),
    ['account', 'engine', 'installed', 'method', 'plan', 'signedIn'].sort());
  assert.equal(summary.signedIn, true);
  assert.equal(summary.account, 'someone@example.com');
  assert.equal(summary.plan, 'max');

  const serialised = JSON.stringify(summary);
  assert.doesNotMatch(serialised, /orgId|orgName|04ea783c/, 'organisation identifiers must not reach the UI');
});

test('signedIn is strictly true, never merely truthy', () => {
  for (const loggedIn of [false, 'yes', 1, null, undefined]) {
    assert.equal(summariseAuth(JSON.stringify({ loggedIn })).signedIn, false, String(loggedIn));
  }
  assert.equal(summariseAuth(JSON.stringify({ loggedIn: true })).signedIn, true);
});

test('long or non-string fields are bounded, not trusted', () => {
  const summary = summariseAuth(JSON.stringify({
    loggedIn: true,
    email: 'x'.repeat(500),
    subscriptionType: { nested: true },
    authMethod: 12345,
  }));
  assert.equal(summary.account.length, 120);
  assert.equal(summary.plan, null);
  assert.equal(summary.method, null);
});

test('a missing CLI resolves to not-installed rather than throwing', async () => {
  const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  assert.deepEqual(await readAuthStatus({ spawn: spawnReturning(null, { error: enoent }) }), notInstalled());
});

test('unparseable output resolves to not-installed rather than throwing', async () => {
  for (const junk of ['not json at all', '', '<html>login</html>']) {
    const status = await readAuthStatus({ spawn: spawnReturning(junk) });
    assert.equal(status.signedIn, false, junk);
    assert.equal(status.installed, false, junk);
  }
});

test('a non-zero exit that still returns JSON is believed', async () => {
  // Some versions exit non-zero precisely because the user is signed out.
  const status = await readAuthStatus({
    spawn: spawnReturning(JSON.stringify({ loggedIn: false }), { exitCode: 1 }),
  });
  assert.equal(status.installed, true, 'the CLI answered, so it is installed');
  assert.equal(status.signedIn, false);
});

test('a hung CLI resolves on a timeout instead of hanging the page', async () => {
  const status = await readAuthStatus({
    spawn: () => fakeChild(),
    timeoutMs: 30,
    terminationGraceMs: 1,
  });
  assert.deepEqual(status, notInstalled());
});

test('a spawn that throws synchronously is handled', async () => {
  const status = await readAuthStatus({
    spawn: () => { throw new Error('EPERM'); },
  });
  assert.deepEqual(status, notInstalled());
});

test('an already-cancelled health request never launches the CLI', async () => {
  const controller = new AbortController();
  controller.abort();
  let launched = 0;
  const status = await readAuthStatus({
    signal: controller.signal,
    spawn() { launched++; },
  });
  assert.deepEqual(status, notInstalled());
  assert.equal(launched, 0);
});

test('hostile auth output stops the complete process tree', async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  const statusPromise = readAuthStatus({
    spawn() {
      queueMicrotask(() => child.stdout.write('😀'.repeat(20 * 1024)));
      return child;
    },
    platform: 'linux',
    processKill(pid, signal) {
      signals.push({ pid, signal });
    },
    terminationGraceMs: 1,
    timeoutMs: 5_000,
  });

  assert.deepEqual(await statusPromise, notInstalled());
  assert.deepEqual(signals, [
    { pid: -4321, signal: 'SIGTERM' },
    { pid: -4321, signal: 'SIGKILL' },
  ]);
});

test('destructive timeout kills auth-probe descendants before they mutate state', {
  skip: process.platform === 'win32',
}, async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-health-tree-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const parentScript = join(fixture, 'parent.mjs');
  const marker = join(fixture, 'late-auth-probe-write');
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
  const status = await readAuthStatus({
    timeoutMs: 150,
    terminationGraceMs: 100,
    spawn(_command, _args, options) {
      spawnOptions = options;
      return nodeSpawn(process.execPath, [parentScript], options);
    },
  });
  assert.deepEqual(status, notInstalled());
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.detached, true);
  assert.equal(spawnOptions.cwd, ROOT);

  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(
    existsSync(marker),
    false,
    'an auth-probe descendant survived after the health check reported failure',
  );
});
