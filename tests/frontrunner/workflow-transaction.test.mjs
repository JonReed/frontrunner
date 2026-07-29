import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { ROOT } from '#paths';
import { reconcileWorkflowFollowups } from '../../src/application/status-control.mjs';

const CONTROL = join(ROOT, 'src', 'application', 'status-control.mjs');

function fixture(t, status = 'Evaluated', notes = '[frontrunner-stage:ready]') {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-workflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tracker = join(dir, 'applications.md');
  const followups = join(dir, 'follow-ups.md');
  const profile = join(dir, 'profile.yml');
  const row = `| 42 | 2026-07-29 | Acme | Director | 4.2/5 | ${status} | ✅ | — | ${notes} |`;
  writeFileSync(tracker, `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
${row}
`);
  writeFileSync(profile, 'followup:\n  applied_first: 7\n');
  return {
    dir,
    tracker,
    followups,
    profile,
    row,
    revision: createHash('sha256').update(row).digest('hex'),
  };
}

function invoke(paths, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONTROL], {
      cwd: ROOT,
      shell: false,
      env: {
        ...process.env,
        FRONTRUNNER_TRACKER: paths.tracker,
        FRONTRUNNER_FOLLOWUPS: paths.followups,
        FRONTRUNNER_PROFILE: paths.profile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

function moveRequest(revision, token = randomUUID()) {
  return {
    version: '1',
    action: 'set',
    roleNum: 42,
    state: 'Applied',
    note: `[frontrunner-before:${token}:Evaluated:ready:Applied]; Applied — recorded in Frontrunner`,
    expectedRevision: revision,
    undoToken: token,
  };
}

test('destructive workflow: stale moves lose, Undo is single-use, and its owned follow-up reverses', async (t) => {
  const paths = fixture(t);
  const token = randomUUID();
  const request = moveRequest(paths.revision, token);

  const [first, second] = await Promise.all([
    invoke(paths, request),
    invoke(paths, request),
  ]);
  const successes = [first, second].filter(result => result.code === 0);
  const conflicts = [first, second].filter(result => result.code !== 0);
  assert.equal(successes.length, 1, 'exactly one concurrent move must commit');
  assert.equal(conflicts.length, 1, 'the stale concurrent move must fail closed');
  assert.match(conflicts[0].stderr, /changed after it was displayed/iu);

  const receipt = JSON.parse(successes[0].stdout);
  assert.match(receipt.revision, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.undoToken, token);
  assert.match(readFileSync(paths.tracker, 'utf8'), /\| Applied \|/u);
  const scheduled = readFileSync(paths.followups, 'utf8');
  assert.match(scheduled, /- next #42 \d{4}-\d{2}-\d{2}/u);
  assert.match(scheduled, new RegExp(`frontrunner-workflow:${token}:42`, 'u'));

  const undo = await invoke(paths, {
    version: '1',
    action: 'restore',
    roleNum: 42,
    expectedRevision: receipt.revision,
    undoToken: token,
  });
  assert.equal(undo.code, 0, undo.stderr);
  assert.match(readFileSync(paths.tracker, 'utf8'), /\| Evaluated \|/u);
  assert.doesNotMatch(readFileSync(paths.followups, 'utf8'), /- next #42 /u);

  const replay = await invoke(paths, {
    version: '1',
    action: 'restore',
    roleNum: 42,
    expectedRevision: receipt.revision,
    undoToken: token,
  });
  assert.notEqual(replay.code, 0);
  assert.match(replay.stderr, /changed after the move|already been undone/iu);
  assert.match(readFileSync(paths.tracker, 'utf8'), /\| Evaluated \|/u);
});

test('durable workflow marker repairs a follow-up missed by an interrupted controller', async (t) => {
  const token = randomUUID();
  const notes = `[frontrunner-before:${token}:Evaluated:ready:Applied]; Applied — recorded in Frontrunner`;
  const paths = fixture(t, 'Applied', notes);

  const result = await reconcileWorkflowFollowups({
    trackerPath: paths.tracker,
    followupsPath: paths.followups,
    profilePath: paths.profile,
  });
  assert.equal(result.failed.length, 0);
  assert.equal(result.repaired.length, 1);
  const followups = readFileSync(paths.followups, 'utf8');
  assert.match(followups, /- next #42 \d{4}-\d{2}-\d{2}/u);
  assert.match(followups, new RegExp(`frontrunner-workflow:${token}:42`, 'u'));

  const retry = await reconcileWorkflowFollowups({
    trackerPath: paths.tracker,
    followupsPath: paths.followups,
    profilePath: paths.profile,
  });
  assert.equal(retry.failed.length, 0);
  assert.equal((readFileSync(paths.followups, 'utf8').match(/- next #42 /gu) ?? []).length, 1);
});

test('leaving Applied retires its owned date and Undo restores the Applied schedule', async (t) => {
  const appliedToken = randomUUID();
  const notes = `[frontrunner-before:${appliedToken}:Evaluated:ready:Applied]; Applied — recorded in Frontrunner`;
  const paths = fixture(t, 'Applied', notes);
  await reconcileWorkflowFollowups({
    trackerPath: paths.tracker,
    followupsPath: paths.followups,
    profilePath: paths.profile,
  });
  assert.match(readFileSync(paths.followups, 'utf8'), /- next #42 /u);

  const respondedToken = randomUUID();
  const moved = await invoke(paths, {
    version: '1',
    action: 'set',
    roleNum: 42,
    state: 'Responded',
    note: `[frontrunner-before:${respondedToken}:Applied:applied:Responded]; Employer replied — recorded in Frontrunner`,
    expectedRevision: paths.revision,
    undoToken: respondedToken,
  });
  assert.equal(moved.code, 0, moved.stderr);
  const receipt = JSON.parse(moved.stdout);
  assert.match(readFileSync(paths.tracker, 'utf8'), /\| Responded \|/u);
  assert.doesNotMatch(readFileSync(paths.followups, 'utf8'), /- next #42 /u);

  const undo = await invoke(paths, {
    version: '1',
    action: 'restore',
    roleNum: 42,
    expectedRevision: receipt.revision,
    undoToken: respondedToken,
  });
  assert.equal(undo.code, 0, undo.stderr);
  assert.match(readFileSync(paths.tracker, 'utf8'), /\| Applied \|/u);
  const restored = readFileSync(paths.followups, 'utf8');
  assert.match(restored, /- next #42 /u);
  assert.match(restored, new RegExp(`frontrunner-workflow:${appliedToken}:42`, 'u'));
  assert.doesNotMatch(restored, new RegExp(`frontrunner-workflow:${respondedToken}:42`, 'u'));
});

test('Undo refuses to overwrite an intervening human tracker edit', async (t) => {
  const paths = fixture(t);
  const token = randomUUID();
  const moved = await invoke(paths, moveRequest(paths.revision, token));
  assert.equal(moved.code, 0, moved.stderr);
  const receipt = JSON.parse(moved.stdout);

  const edited = readFileSync(paths.tracker, 'utf8').replace(
    'Applied — recorded in Frontrunner',
    'Applied — recorded in Frontrunner; human note after move',
  );
  writeFileSync(paths.tracker, edited);

  const undo = await invoke(paths, {
    version: '1',
    action: 'restore',
    roleNum: 42,
    expectedRevision: receipt.revision,
    undoToken: token,
  });
  assert.notEqual(undo.code, 0);
  assert.match(undo.stderr, /changed after the move/iu);
  const after = readFileSync(paths.tracker, 'utf8');
  assert.match(after, /human note after move/u);
  assert.match(after, /\| Applied \|/u);
});

test('durable undone marker removes only its workflow-owned pin after interruption', async (t) => {
  const token = randomUUID();
  const notes = `[frontrunner-before:${token}:Evaluated:ready:Applied]; [frontrunner-undone:${token}]; [frontrunner-stage:ready]`;
  const paths = fixture(t, 'Evaluated', notes);
  writeFileSync(paths.followups, `# Follow-ups

| num | appNum | date | company | role | channel | contact | notes |
|---|---|---|---|---|---|---|---|
- next #99 2026-08-10 (set 2026-07-29)
- next #42 2026-08-05 (set 2026-07-29)
<!-- frontrunner-workflow:${token}:42 -->
`);

  const result = await reconcileWorkflowFollowups({
    trackerPath: paths.tracker,
    followupsPath: paths.followups,
    profilePath: paths.profile,
  });
  assert.equal(result.failed.length, 0);
  const followups = readFileSync(paths.followups, 'utf8');
  assert.doesNotMatch(followups, /- next #42 /u);
  assert.doesNotMatch(followups, new RegExp(token, 'u'));
  assert.match(followups, /- next #99 2026-08-10/u, 'unrelated/manual pins must survive');
});
