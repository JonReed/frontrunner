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
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  validateHealthRequest,
  summariseAuth,
  notInstalled,
  readAuthStatus,
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

test('there is no sign-in action — authentication is not ours to start', () => {
  for (const action of ['login', 'signin', 'auth', 'setup', 'write']) {
    assert.throws(() => validateHealthRequest({ version: '1', action }), /unsupported/, action);
  }
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
  const status = await readAuthStatus({ spawn: () => fakeChild(), timeoutMs: 30 });
  assert.deepEqual(status, notInstalled());
});

test('a spawn that throws synchronously is handled', async () => {
  const status = await readAuthStatus({
    spawn: () => { throw new Error('EPERM'); },
  });
  assert.deepEqual(status, notInstalled());
});
