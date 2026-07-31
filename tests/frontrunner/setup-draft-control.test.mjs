import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearDraft,
  MAX_DRAFT_BYTES,
  readDraft,
  saveDraft,
  validateDraftControlRequest,
} from '../../src/application/draft-control.mjs';

function scratchDraft(t) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-setup-draft-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.FRONTRUNNER_SETUP_DRAFT;
  const file = join(dir, 'setup-draft.json');
  process.env.FRONTRUNNER_SETUP_DRAFT = file;
  t.after(() => {
    if (previous === undefined) delete process.env.FRONTRUNNER_SETUP_DRAFT;
    else process.env.FRONTRUNNER_SETUP_DRAFT = previous;
  });
  return file;
}

test('a draft round-trips and is written owner-only', (t) => {
  const file = scratchDraft(t);
  assert.equal(readDraft(), null);

  saveDraft({ cv: '# Jane\nPractice manager', fullName: 'Jane', salaryTarget: '£45,000' });
  assert.deepEqual(readDraft(), {
    cv: '# Jane\nPractice manager',
    fullName: 'Jane',
    salaryTarget: '£45,000',
  });

  /*
    This is an unfinished CV, not shared state. The mode is a large part of
    why it is safe to hold on disk at all, so it is asserted rather than
    assumed.

    POSIX only, matching every other mode assertion in this suite: NTFS uses
    ACLs and Node reports a synthesised mode there, so the check would be
    testing the host rather than the writer. On Windows the file inherits the
    ACLs of the user's own profile directory — comparable protection by a
    different mechanism, which this assertion cannot speak to.
  */
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o077, 0, 'the draft must not be group or world readable');
  }
});

test('clearing removes the second copy of the CV', (t) => {
  scratchDraft(t);
  assert.deepEqual(clearDraft(), { cleared: false });

  saveDraft({ cv: 'something' });
  assert.deepEqual(clearDraft(), { cleared: true });
  assert.equal(readDraft(), null);
});

test('an unreadable draft is an empty form, never a thrown error', (t) => {
  const file = scratchDraft(t);
  writeFileSync(file, '{ not json at all');
  // Setup must still open. A corrupt safety net is a lost safety net, not a
  // reason to block the screen that replaces it.
  assert.equal(readDraft(), null);

  writeFileSync(file, '["an array is not a draft"]');
  assert.equal(readDraft(), null);
});

test('the control refuses anything outside its fixed protocol', () => {
  assert.deepEqual(
    validateDraftControlRequest({ version: '1', action: 'read' }),
    { version: '1', action: 'read' },
  );
  assert.deepEqual(
    validateDraftControlRequest({ version: '1', action: 'save', draft: { cv: 'x' } }),
    { version: '1', action: 'save', draft: { cv: 'x' } },
  );

  for (const request of [
    null,
    [],
    { version: '2', action: 'read' },
    { version: '1', action: 'destroy' },
    { version: '1', action: 'read', draft: {} },
    { version: '1', action: 'clear', draft: {} },
    { version: '1', action: 'save' },
    { version: '1', action: 'save', draft: 'a string' },
    { version: '1', action: 'save', draft: [] },
    { version: '1', action: 'save', draft: {}, path: '/etc/passwd' },
  ]) {
    assert.throws(() => validateDraftControlRequest(request));
  }
});

test('an oversized draft is refused rather than written', () => {
  assert.throws(
    () => validateDraftControlRequest({
      version: '1',
      action: 'save',
      draft: { cv: 'x'.repeat(MAX_DRAFT_BYTES + 1) },
    }),
    (error) => error.code === 'DRAFT_TOO_LARGE',
  );
});

test('the setup flow keeps the CV out of browser storage', async () => {
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('#paths');
  const source = await readFile(join(ROOT, 'ui/src/components/setup-flow.tsx'), 'utf8');

  /*
    The regression this guards is a real CodeQL finding: persisting the draft
    to sessionStorage put an employment history, contact details and salary
    expectations into browser storage in clear text. Any reintroduction should
    fail here rather than in a security scan after merge.
  */
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
  assert.doesNotMatch(code, /sessionStorage|localStorage/u);
  assert.match(source, /storeSetupDraft|loadSetupDraft/u);
});

test('a CLI failure reported on stdout is surfaced, not swallowed', async () => {
  const { claudeFailureDetail } = await import('../../src/application/profile-extraction.mjs');

  /*
    The regression: `claude -p --output-format json` reports its own errors in
    the stdout envelope and leaves stderr empty, so reading stderr alone turned
    an expired session — the commonest failure there is — into a bare
    "exited 1" with no cause.
  */
  assert.equal(
    claudeFailureDetail({
      stdout: JSON.stringify({
        is_error: true,
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      }),
      stderr: '',
    }),
    'Failed to authenticate: OAuth session expired and could not be refreshed',
  );

  // Still falls back to stderr when the process died before printing JSON.
  assert.equal(claudeFailureDetail({ stdout: 'not json', stderr: 'spawn ENOENT' }), 'spawn ENOENT');
  assert.equal(claudeFailureDetail({}), '');
});

test('an expired sign-in offers the fix where it broke, not a page to visit', async () => {
  const { readFile } = await import('node:fs/promises');
  const { ROOT } = await import('#paths');

  const notice = await readFile(join(ROOT, 'ui/src/components/reconnect-notice.tsx'), 'utf8');
  // The remedy must be the button, not prose telling the user to go elsewhere.
  assert.match(notice, /ConnectButton/u);

  /*
    Every control that spends allowance has to route an auth failure here.
    Left to prose, each one drifts into its own wording and its own dead end —
    which is exactly what this replaced.
  */
  for (const file of [
    'ui/src/components/build-cv.tsx',
    'ui/src/components/build-cover.tsx',
    'ui/src/components/pipeline-control.tsx',
    'ui/src/components/suggest-companies.tsx',
  ]) {
    const source = await readFile(join(ROOT, file), 'utf8');
    assert.match(source, /isSignInFailure/u, `${file} must route sign-in failures to the notice`);
  }
});
