/**
 * The parent repository is a source of ideas, never a target (AGENTS.md rule 4).
 *
 * That rule existed as prose and prose did not hold: on 2026-08-01 a bare
 * `gh pr create` resolved its default repo to the `upstream` remote and opened a
 * pull request in santifer/career-ops. GitHub does not allow deleting a pull
 * request, so the closed entry is permanent in someone else's repo.
 *
 * These assertions are the enforcement half of `src/lib/upstream-guard.mjs`.
 * They fail if either hook is unwired, if the guard stops blocking the exact
 * command that caused the incident, or if it starts blocking the read-only
 * upstream review the fork depends on. Deleting the guard fails `qa:full`,
 * which is the point — reinforcement without enforcement decays.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import { OWN_REPO, blockReason, isUpstreamRemote } from '../../src/lib/upstream-guard.mjs';

const GUARD = join(ROOT, 'src', 'lib', 'upstream-guard.mjs');

/* ------------------------------------------------------- the incident case */

test('the exact command that caused the incident is blocked', () => {
  // No --repo anywhere: gh chooses the default, which resolved to upstream.
  const reason = blockReason('gh pr create --title "Port upstream: DE/AGG row" --body "..."');
  assert.ok(reason, 'a gh write with no explicit --repo must be blocked');
  assert.match(reason, /--repo Furls-Digital\/frontrunner/);
});

test('naming the parent repository with a write verb is blocked', () => {
  for (const command of [
    'gh pr create --repo santifer/career-ops --title x',
    'gh pr edit 2413 --repo santifer/career-ops --body x',
    'gh pr close 2413 --repo santifer/career-ops',
    'gh pr comment 2413 --repo santifer/career-ops --body hi',
    'gh issue create --repo santifer/career-ops --title x',
    'gh api -X POST repos/santifer/career-ops/pulls',
    'gh api --method PATCH repos/santifer/career-ops/pulls/1',
    'git push upstream main',
    'git push https://github.com/santifer/career-ops.git HEAD',
    'git push git@github.com:santifer/career-ops.git main',
  ]) {
    assert.ok(blockReason(command), `should block: ${command}`);
  }
});

test('a blocked verb cannot hide inside a command chain', () => {
  assert.ok(blockReason('npm test && gh pr create --title x'));
  assert.ok(blockReason('cd /tmp; git push upstream main'));
  assert.ok(blockReason('echo hi || gh pr create --repo santifer/career-ops --title x'));
});

/* ------------------------------------------------ what must stay possible */

test('writes that name this fork explicitly are allowed', () => {
  for (const command of [
    `gh pr create --repo ${OWN_REPO} --title x --body y`,
    `gh pr merge 19 --repo ${OWN_REPO} --squash --delete-branch`,
    `gh pr comment 19 --repo ${OWN_REPO} --body x`,
    `gh issue create --repo=${OWN_REPO} --title x`,
    'git push -u origin my-branch',
    'git push origin HEAD',
  ]) {
    assert.equal(blockReason(command), null, `should allow: ${command}`);
  }
});

test('the fork can be named the three ways gh actually accepts', () => {
  // Fail-closed is right, but only if the closed door has a handle. gh takes
  // --repo, its -R alias, and — for `gh api`, which has no repo flag at all —
  // a literal path. Blocking any of these would make the guard unusable and
  // the first person to hit it would reach for a way around it.
  assert.equal(blockReason(`gh pr create -R ${OWN_REPO} --title x`), null);
  assert.equal(blockReason(`gh pr create -R=${OWN_REPO} --title x`), null);
  assert.equal(blockReason(`gh api -X POST repos/${OWN_REPO}/issues`), null);
  assert.equal(blockReason(`gh api --method PATCH repos/${OWN_REPO}/pulls/19`), null);
});

test('naming the fork must be unambiguous — placeholders and lookalikes do not count', () => {
  // gh resolves {owner}/{repo} through the same default-repo mechanism that
  // opened a PR in the parent's repo, so it is not a way of naming this fork.
  assert.ok(blockReason('gh api -X POST repos/{owner}/{repo}/issues'));
  assert.ok(blockReason(`gh pr create --repo ${OWN_REPO}-evil --title x`), 'hyphen suffix must not satisfy the check');
  assert.ok(blockReason(`gh pr create --repo ${OWN_REPO}.evil --title x`), 'dot suffix must not satisfy the check');
  assert.ok(blockReason(`gh pr create --repo ${OWN_REPO}X --title x`));
  assert.ok(blockReason(`gh api -X POST repos/${OWN_REPO}-evil/issues`));
  // A mention in prose is not a target: the flag has to carry it.
  assert.ok(blockReason(`gh pr create --title "port to ${OWN_REPO}"`));
});

test('read-only upstream review is untouched — it is why the remote exists', () => {
  for (const command of [
    'git fetch upstream',
    'git log --oneline --no-merges 8127c93..upstream/main',
    'git show 7ab92ab --stat',
    'gh pr view 2413 --repo santifer/career-ops --json state',
    'gh pr list --repo santifer/career-ops',
    'gh pr checks 19',
    'gh pr diff 19',
    'node test-all.mjs',
    '',
  ]) {
    assert.equal(blockReason(command), null, `should allow: ${command}`);
  }
});

/* ------------------------------------------------------- remote resolution */

test('a push is judged by resolved URL, not by remote name', () => {
  // A fresh clone has no local push-URL block, and a remote can be named
  // anything. The URL is the only thing that cannot be renamed around.
  assert.equal(isUpstreamRemote('parent', 'https://github.com/santifer/career-ops.git'), true);
  assert.equal(isUpstreamRemote('upstream', 'https://example.test/anything'), true);
  assert.equal(isUpstreamRemote('origin', `https://github.com/${OWN_REPO}.git`), false);
});

/* -------------------------------------------------------------- the wiring */

test('the git pre-push hook calls the guard before anything else', () => {
  const hook = readFileSync(join(ROOT, '.github', 'hooks', 'pre-push'), 'utf-8');
  assert.match(hook, /upstream-guard\.mjs['" ]+--git-push/);
  const guardLine = hook.split('\n').findIndex((line) => line.includes('upstream-guard.mjs'));
  const qaLine = hook.split('\n').findIndex((line) => line.includes('qa:full'));
  assert.ok(guardLine >= 0 && guardLine < qaLine, 'the guard must run before the test suite, not after');
});

test('the Claude Code PreToolUse hook is wired for Bash', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf-8'));
  const entries = settings?.hooks?.PreToolUse ?? [];
  const bash = entries.filter((entry) => String(entry?.matcher || '').split('|').includes('Bash'));
  assert.ok(bash.length, '.claude/settings.json must register a PreToolUse hook on Bash');
  const commands = bash.flatMap((entry) => entry.hooks || []).map((hook) => hook.command || '');
  assert.ok(
    commands.some((command) => command.includes('upstream-guard.mjs') && command.includes('--hook')),
    'the Bash PreToolUse hook must invoke upstream-guard.mjs --hook',
  );
});

test('every host entrypoint states the rule, not just AGENTS.md', () => {
  // The failure this prevents is an agent acting before it has read AGENTS.md,
  // so a bare `@AGENTS.md` import is not enough — the rule has to be at the
  // entry point itself. GEMINI.md is excluded on purpose: it is a deliberate
  // no-op that exists to stop Antigravity loading the instructions twice.
  for (const entrypoint of ['CLAUDE.md', 'CODEX.md']) {
    const content = readFileSync(join(ROOT, entrypoint), 'utf-8');
    assert.match(content, /NOTHING GOES UPSTREAM/, `${entrypoint} must carry the rule heading`);
    assert.ok(
      content.includes(`--repo ${OWN_REPO}`),
      `${entrypoint} must show the explicit --repo form`,
    );
    assert.match(content, /never\*{0,2} writes to it/i, `${entrypoint} must state the prohibition`);
  }
});

/* --------------------------------------------------------------- CLI modes */

test('--hook denies a blocked command in the PreToolUse contract shape', () => {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create --title x' } });
  const out = execFileSync(process.execPath, [GUARD, '--hook'], { input: payload, encoding: 'utf-8' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /santifer\/career-ops/);
});

test('--hook stays silent for an allowed command', () => {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git fetch upstream' } });
  const out = execFileSync(process.execPath, [GUARD, '--hook'], { input: payload, encoding: 'utf-8' });
  assert.equal(out.trim(), '', 'an allowed command must produce no decision at all');
});

test('--git-push exits non-zero for the parent and zero for origin', () => {
  assert.throws(() => execFileSync(
    process.execPath,
    [GUARD, '--git-push', 'upstream', 'https://github.com/santifer/career-ops.git'],
    { stdio: 'pipe' },
  ), 'a push to the parent must abort the push');

  execFileSync(
    process.execPath,
    [GUARD, '--git-push', 'origin', `https://github.com/${OWN_REPO}.git`],
    { stdio: 'pipe' },
  );
});
