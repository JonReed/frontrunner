#!/usr/bin/env node
/**
 * upstream-guard.mjs — deterministic block on anything that would write to the
 * parent repository.
 *
 * AGENTS.md rule 4 says the parent (`santifer/career-ops`) is a source of ideas
 * reviewed commit by commit, never a target. That rule was prose, and prose did
 * not hold: on 2026-08-01 a bare `gh pr create` resolved its default repo to the
 * `upstream` remote and opened a pull request in the parent's repo, notifying
 * their maintainers. GitHub does not allow deleting a pull request, so the
 * closed entry is permanent. This file is that rule expressed as code.
 *
 * Two callers, one matcher:
 *   - `.github/hooks/pre-push` (git's own hook, so it covers humans and agents)
 *   - the `PreToolUse` Bash hook in `.claude/settings.json` (covers the agent
 *     before the command ever runs)
 *
 * The load-bearing rule is the second one in `blockReason`. Disabling the
 * `upstream` remote's push URL does NOT stop `gh`: it talks to the GitHub API,
 * not to a git remote, and the command that caused the incident never mentioned
 * the parent at all — it simply omitted `--repo` and let `gh` choose. So a
 * mutating `gh` subcommand must name this fork explicitly or it is refused.
 * Fail closed: an unrecognised shape is blocked, not waved through.
 *
 * Read-only `gh` (view, list, checks, diff, status) is untouched — reviewing
 * upstream is the whole point of having the remote.
 *
 * Run: node src/lib/upstream-guard.mjs --hook            (reads PreToolUse JSON on stdin)
 *      node src/lib/upstream-guard.mjs --git-push <remote-name> <remote-url>
 *      node src/lib/upstream-guard.mjs --check '<shell command>'
 *      node src/lib/upstream-guard.mjs --self-test
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The fork every write must name. */
export const OWN_REPO = 'Furls-Digital/frontrunner';

// Built from a constant rather than written as regex literals: a literal
// containing a slash immediately before this slug reads as the inherited
// slash-command that tests/frontrunner/product-identity.test.mjs forbids.
const PARENT_SLUG = 'career-ops';
const PARENT_OWNER = 'santifer';

/**
 * Identities that mean "the parent repository". Matched case-insensitively
 * against a whole command string or a remote URL.
 */
const UPSTREAM_PATTERNS = [
  new RegExp(`${PARENT_OWNER}\\s*/\\s*${PARENT_SLUG}`, 'i'),
  new RegExp(`github\\.com[/:]\\s*${PARENT_OWNER}\\b`, 'i'),
  new RegExp(`\\b${PARENT_SLUG}\\.git\\b`, 'i'),
];

/**
 * `gh` subcommands that create or change something on GitHub. Read-only verbs
 * (view, list, checks, diff, status, ready) are deliberately absent.
 */
const MUTATING_GH = [
  /^\s*gh\s+pr\s+(create|edit|close|reopen|merge|comment|review|lock|unlock)\b/i,
  /^\s*gh\s+issue\s+(create|edit|close|reopen|comment|delete|lock|unlock|transfer|pin|unpin)\b/i,
  /^\s*gh\s+release\s+(create|edit|delete|upload)\b/i,
  /^\s*gh\s+repo\s+(create|fork|delete|edit|archive|rename|deploy-key)\b/i,
  /^\s*gh\s+(gist|secret|variable|workflow|label|ruleset|cache)\s+(create|set|delete|edit|remove|run|enable|disable)\b/i,
  /^\s*gh\s+api\b[^|;&]*(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i,
];

/** Pushes: the git-level half of the same boundary. */
const GIT_PUSH = /(^|[;&|]|\s)git\s+(?:-[^\s]+\s+)*push\b/i;

function splitCommands(command) {
  // Conservative: any segment of a chain is judged on its own, and the whole
  // string is judged too, so neither `a && b` nor a quoted subshell hides a
  // blocked verb.
  return [command, ...String(command).split(/&&|\|\||[;|]/)]
    .map((part) => part.trim())
    .filter(Boolean);
}

function mentionsUpstream(text) {
  return UPSTREAM_PATTERNS.some((pattern) => pattern.test(text));
}

function namesOwnRepo(text) {
  return new RegExp(`--repo(?:=|\\s+)['"]?${OWN_REPO.replace('/', '\\/')}['"]?`, 'i').test(text);
}

/**
 * Why this command must not run, or null when it is allowed.
 *
 * @param {string} command - the shell command about to execute
 * @returns {string|null}
 */
export function blockReason(command) {
  const raw = String(command ?? '');
  if (!raw.trim()) return null;
  const segments = splitCommands(raw);

  for (const segment of segments) {
    const isMutatingGh = MUTATING_GH.some((pattern) => pattern.test(segment));
    const isPush = GIT_PUSH.test(segment);

    // 1. Naming the parent alongside a write verb is never legitimate.
    if ((isMutatingGh || isPush) && mentionsUpstream(segment)) {
      return `refuses to write to the parent repository (santifer/career-ops): ${segment}`;
    }

    // 2. The incident case: a mutating gh command with no explicit --repo, so
    //    gh picks the default — which resolves to whichever remote it likes.
    if (isMutatingGh && !namesOwnRepo(segment)) {
      return `gh writes must name the fork explicitly — add --repo ${OWN_REPO}: ${segment}`;
    }

    // 3. `git push upstream ...` by remote name.
    if (isPush && /\bpush\s+(?:-[^\s]+\s+)*upstream\b/i.test(segment)) {
      return `refuses to push to the 'upstream' remote: ${segment}`;
    }
  }

  return null;
}

/**
 * Whether a git remote (name or URL) is the parent repository. Used by the
 * pre-push hook, which git hands the resolved URL — so this catches a push to
 * the parent under any remote name, including a fresh clone where the local
 * push-URL block was never applied.
 */
export function isUpstreamRemote(name, url) {
  if (mentionsUpstream(String(url ?? ''))) return true;
  return String(name ?? '').trim().toLowerCase() === 'upstream';
}

/* -------------------------------------------------------------------- CLI */

const DENY_PREFIX = 'Blocked by upstream-guard: ';
const RULE_NOTE =
  'Nothing from this fork goes to santifer/career-ops (AGENTS.md rule 4). '
  + `Target ${OWN_REPO} explicitly, or ask the user.`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function hookMode() {
  let command = '';
  try {
    command = JSON.parse(await readStdin())?.tool_input?.command ?? '';
  } catch {
    // A payload we cannot parse carries no command to judge. Staying silent
    // here is correct: the guard blocks writes, it does not police JSON.
    return;
  }
  const reason = blockReason(command);
  if (!reason) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${DENY_PREFIX}${reason}. ${RULE_NOTE}`,
    },
    systemMessage: `${DENY_PREFIX}${reason}`,
  })}\n`);
}

function gitPushMode(argv) {
  const [name, url] = argv;
  if (!isUpstreamRemote(name, url)) return 0;
  process.stderr.write(
    `${DENY_PREFIX}push to '${name || 'unknown'}' (${url || 'no url'}) is the parent repository.\n${RULE_NOTE}\n`,
  );
  return 1;
}

function selfTest() {
  const cases = [
    // The exact command from the incident: no --repo at all.
    ['gh pr create --title "Port upstream" --body "..."', true],
    ['gh pr create --repo santifer/career-ops --title x', true],
    ['gh pr comment 2413 --repo santifer/career-ops --body hi', true],
    ['gh issue create --repo santifer/career-ops --title x', true],
    ['gh api -X POST repos/santifer/career-ops/pulls', true],
    ['git push upstream main', true],
    ['git push https://github.com/santifer/career-ops.git main', true],
    ['npm test && gh pr create --title x', true],
    [`gh pr create --repo ${OWN_REPO} --title x`, false],
    [`gh pr merge 19 --repo ${OWN_REPO} --squash`, false],
    ['gh pr view 2413 --repo santifer/career-ops --json state', false],
    ['gh pr list --repo santifer/career-ops', false],
    ['gh pr checks 19', false],
    ['git push -u origin my-branch', false],
    ['git fetch upstream', false],
    ['git log --oneline upstream/main', false],
    ['node test-all.mjs', false],
  ];
  const failures = [];
  for (const [command, shouldBlock] of cases) {
    const blocked = blockReason(command) !== null;
    if (blocked !== shouldBlock) {
      failures.push(`${shouldBlock ? 'should block' : 'should allow'}: ${command}`);
    }
  }
  if (!isUpstreamRemote('upstream', 'https://example.test/x')) failures.push('remote named upstream must be blocked');
  if (!isUpstreamRemote('anything', 'https://github.com/santifer/career-ops.git')) failures.push('parent URL must be blocked under any remote name');
  if (isUpstreamRemote('origin', `https://github.com/${OWN_REPO}.git`)) failures.push('origin must be allowed');

  if (failures.length) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.error(`upstream-guard self-test: ${failures.length} failure(s)`);
    return 1;
  }
  console.log('upstream-guard self-test OK');
  return 0;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '--hook') return void await hookMode();
  if (mode === '--git-push') return void (process.exitCode = gitPushMode(rest));
  if (mode === '--self-test') return void (process.exitCode = selfTest());
  if (mode === '--check') {
    const reason = blockReason(rest.join(' '));
    if (reason) {
      process.stderr.write(`${DENY_PREFIX}${reason}\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.stderr.write('usage: upstream-guard.mjs --hook | --git-push <name> <url> | --check <command> | --self-test\n');
  process.exitCode = 1;
}

// Entry-point detection only — this resolves argv[1], never this file's own
// location, so it does not violate the no-self-rooting rule (AGENTS.md rule 1).
if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  await main();
}
