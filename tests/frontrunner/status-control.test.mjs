/**
 * status-control.test.mjs
 *
 * The UI's only path to writing a tracker status. A request arrives from a
 * browser, so the tests that matter are the ones about what it CANNOT do.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateStatusRequest,
  buildSetStatusArgs,
  canonicalStates,
} from '../../src/application/status-control.mjs';

const REVISION = 'a'.repeat(64);
const TOKEN = '12345678-1234-1234-1234-123456789abc';
const ok = (over = {}) => ({
  version: '1',
  action: 'set',
  roleNum: 42,
  state: 'Applied',
  note: `[frontrunner-before:${TOKEN}:Evaluated:ready:Applied]`,
  expectedRevision: REVISION,
  undoToken: TOKEN,
  ...over,
});

const UI_STATES = [
  'Evaluated',
  'Applied',
  'Responded',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
  'Discarded',
  'SKIP',
];

test('accepts only states represented by explicit user-observed UI actions', () => {
  for (const state of UI_STATES) {
    assert.equal(validateStatusRequest(ok({
      state,
      note: `[frontrunner-before:${TOKEN}:Evaluated:ready:${state}]`,
    })).state, state);
  }
});

test('refuses a state no explicit outcome control can record', () => {
  assert.throws(
    () => validateStatusRequest(ok({ state: 'Invented' })),
    /must be one of/,
  );
});

test('the UI allowlist is a subset of templates/states.yml', () => {
  const canonical = canonicalStates();
  for (const state of UI_STATES) {
    assert.ok(canonical.has(state), `${state} must exist in templates/states.yml`);
  }
});

test('rejects a state that is not canonical even if the allowlist drifts', () => {
  assert.throws(
    () => validateStatusRequest(ok({ state: 'Applied' }), new Set(['Evaluated'])),
    /not canonical/,
  );
});

test('rejects unknown fields rather than ignoring them', () => {
  assert.throws(() => validateStatusRequest(ok({ force: true })), /unsupported/);
  assert.throws(() => validateStatusRequest(ok({ role: 'x' })), /unsupported/);
  assert.throws(() => validateStatusRequest(ok({ path: '/etc/passwd' })), /unsupported/);
});

test('accepts bounded restore and rejects every other action', () => {
  assert.deepEqual(
    validateStatusRequest({
      version: '1',
      action: 'restore',
      roleNum: 42,
      expectedRevision: REVISION,
      undoToken: TOKEN,
    }),
    {
      version: '1',
      action: 'restore',
      roleNum: 42,
      expectedRevision: REVISION,
      undoToken: TOKEN,
    },
  );
  assert.throws(
    () => validateStatusRequest({
      version: '1',
      action: 'restore',
      roleNum: 42,
      state: 'Hired',
      expectedRevision: REVISION,
      undoToken: TOKEN,
    }),
    /restore does not accept/,
  );
  assert.throws(() => validateStatusRequest(ok({ action: 'delete' })), /unsupported/);
  assert.throws(() => validateStatusRequest(ok({ version: '2' })), /unsupported/);
});

test('roleNum must be a plausible positive integer', () => {
  for (const roleNum of [0, -1, 1.5, '42', null, undefined, 1_000_000, NaN]) {
    assert.throws(() => validateStatusRequest(ok({ roleNum })), /positive integer/, String(roleNum));
  }
});

test('a note cannot break the tracker row or carry control characters', () => {
  assert.throws(() => validateStatusRequest(ok({ note: 'a|b' })), /not allowed/);
  assert.throws(() => validateStatusRequest(ok({ note: 'a\nb' })), /not allowed/);
  assert.throws(() => validateStatusRequest(ok({ note: 'a\u0000b' })), /not allowed/);
  assert.throws(() => validateStatusRequest(ok({ note: 'x'.repeat(301) })), /too long/);
  assert.throws(() => validateStatusRequest(ok({ note: 42 })), /must be a string/);
  const padded = `  [frontrunner-before:${TOKEN}:Evaluated:ready:Applied]  `;
  assert.equal(
    validateStatusRequest(ok({ note: padded })).note,
    padded.trim(),
  );
});

test('a prototype-polluting payload is rejected, not merged', () => {
  const hostile = JSON.parse('{"version":"1","action":"set","roleNum":1,"state":"Applied","__proto__":{"admin":true}}');
  // The key-allowlist catches it before any merge could happen, which is
  // stronger than tolerating it and relying on the prototype being unreachable.
  assert.throws(() => validateStatusRequest(hostile), /unsupported status-control field/);
  assert.equal({}.admin, undefined, 'Object.prototype must be untouched');
});

test('argv is fixed — nothing from the request becomes a flag', () => {
  const note = `[frontrunner-before:${TOKEN}:Evaluated:ready:Applied]; sent today`;
  const args = buildSetStatusArgs(validateStatusRequest(ok({ note })));
  assert.ok(args[0].endsWith('set-status.mjs'));
  assert.deepEqual(args.slice(1), [
    '--row',
    '42',
    'Applied',
    '--json',
    '--expect-revision',
    REVISION,
    '--note',
    note,
  ]);

  // A note that looks like a flag stays a note: it is passed as the value
  // after --note, never as an argument of its own.
  const sneakyNote = `[frontrunner-before:${TOKEN}:Evaluated:ready:Applied]; --force`;
  const sneaky = buildSetStatusArgs(validateStatusRequest(ok({ note: sneakyNote })));
  assert.deepEqual(sneaky.slice(1), [
    '--row',
    '42',
    'Applied',
    '--json',
    '--expect-revision',
    REVISION,
    '--note',
    sneakyNote,
  ]);
  assert.equal(sneaky.filter((a) => a === '--force').length, 0);
});

test('omitting the durable workflow marker is rejected', () => {
  assert.throws(
    () => validateStatusRequest(ok({ note: undefined })),
    /workflow undo marker/,
  );
  assert.throws(
    () => validateStatusRequest(ok({
      note: `[frontrunner-before:${TOKEN}:Evaluated:ready:Discarded]`,
    })),
    /does not match/,
  );
});
