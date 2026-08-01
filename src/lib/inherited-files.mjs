#!/usr/bin/env node
/**
 * inherited-files.mjs — which files came from the parent project.
 *
 * AGENTS.md rule 3 says to prefer new files over editing inherited ones. That
 * rule was unenforceable because "inherited" was invisible: nothing in the tree
 * distinguishes a file this fork wrote from one it received, so the only way to
 * tell was git archaeology nobody performs mid-edit.
 *
 * The cost of not knowing is not hypothetical. Another product's audience
 * assumptions, another person's job-search archetypes, and 2,150 lines of
 * provider code for hosts this product does not support all survived here for
 * months because they read as "the product" to anyone who did not check.
 *
 * Computed live from git rather than stored as a manifest, because a checked-in
 * list of ~600 filenames goes stale the first time someone adds a file and is
 * then trusted anyway. One `git log --diff-filter=A` pass costs ~0.2s.
 *
 * Run: node src/lib/inherited-files.mjs <path>   # one file: inherited or ours
 *      node src/lib/inherited-files.mjs --list   # every inherited file
 *      node src/lib/inherited-files.mjs --stats  # counts by top-level area
 */

import { execFileSync } from 'node:child_process';

import { ROOT } from '#paths';

/**
 * Where this fork diverged from the parent.
 *
 * NOT the initial-release commit. A fork shares the parent's whole history, so
 * 994 commits precede the split — a file added by any of them is inherited even
 * though it appears nowhere in the first commit. Anchoring on the initial
 * release reported 41 inherited files; the real figure is an order of magnitude
 * higher, and under-reporting is the dangerous direction because it marks the
 * parent's code as ours.
 *
 * Resolved from the repository rather than hardcoded: this fork never merges
 * the parent, so `git merge-base` stays the divergence point permanently.
 */
export function forkPoint() {
  return git(['merge-base', 'HEAD', 'upstream/main']).trim();
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
}

/**
 * Every currently-tracked file whose content originated in the import commit,
 * following renames.
 *
 * Renames are the whole difficulty. This fork moved essentially every script
 * into src/, so a naive "was this path in the import commit" check reports 28
 * inherited files when the real number is an order of magnitude higher —
 * src/scan/scan.mjs was scan.mjs on arrival and is inherited code under a new
 * name. Under-reporting is the dangerous direction: it marks inherited content
 * as ours and invites exactly the rewrite rule 3 warns against.
 *
 * One reverse pass over history maintains path -> origin commit, moving the
 * origin across each rename and dropping it on delete. A file deleted and later
 * re-added by this fork therefore counts as ours, which is correct: its current
 * content is not what arrived.
 *
 * @returns {Set<string>} repo-relative paths
 */
export function inheritedPaths() {
  let ancestors;
  try {
    ancestors = new Set(git(['rev-list', forkPoint()]).split('\n').map((line) => line.trim()).filter(Boolean));
  } catch {
    // No upstream remote configured (a fresh clone that only added origin).
    // Report nothing rather than guess: a wrong answer here is worse than
    // "cannot tell", because the caller is deciding whether to rewrite a file.
    return new Set();
  }
  const log = git(['log', '--reverse', '--name-status', '-M', '--format=C:%H']);
  const origin = new Map();
  let commit = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('C:')) { commit = line.slice(2).trim(); continue; }
    if (!line.trim()) continue;
    const [status, first, second] = line.split('\t');
    if (!status || !first) continue;
    if (status.startsWith('R')) {
      if (!second) continue;
      const inheritedOrigin = origin.get(first);
      origin.delete(first);
      origin.set(second, inheritedOrigin ?? commit);
    } else if (status.startsWith('D')) {
      origin.delete(first);
    } else if (status.startsWith('A') || status.startsWith('C')) {
      // A re-added path starts fresh: its content is this fork's, not the
      // parent's, even where the name matches something that once existed.
      origin.set(first, commit);
    }
  }

  const tracked = new Set(git(['ls-files']).split('\n').map((line) => line.trim()).filter(Boolean));
  const inherited = new Set();
  for (const [path, from] of origin) {
    if (ancestors.has(from) && tracked.has(path)) inherited.add(path);
  }
  return inherited;
}

/** Whether one repo-relative path was inherited from the parent project. */
export function isInherited(path, inherited = inheritedPaths()) {
  return inherited.has(String(path).replace(/^\.\//, ''));
}

/* -------------------------------------------------------------------- CLI */

function main() {
  const [arg] = process.argv.slice(2);
  const inherited = inheritedPaths();

  if (arg === '--list') {
    for (const path of [...inherited].sort()) console.log(path);
    return;
  }

  if (arg === '--stats') {
    const tracked = git(['ls-files']).split('\n').filter(Boolean).length;
    const byArea = new Map();
    for (const path of inherited) {
      const area = path.includes('/') ? `${path.split('/')[0]}/` : '(root)';
      byArea.set(area, (byArea.get(area) ?? 0) + 1);
    }
    console.log(`${inherited.size} of ${tracked} tracked files came from the parent project\n`);
    for (const [area, count] of [...byArea].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}  ${area}`);
    }
    return;
  }

  if (!arg || arg.startsWith('-')) {
    process.stderr.write('usage: inherited-files.mjs <path> | --list | --stats\n');
    process.exitCode = 1;
    return;
  }

  if (isInherited(arg, inherited)) {
    console.log(`INHERITED  ${arg}`);
    console.log('Prefer adding a new module and calling it over rewriting this file (AGENTS.md rule 3).');
    console.log('Read it for another product\'s assumptions before treating its content as ours.');
  } else {
    console.log(`OURS       ${arg}`);
  }
}

if (process.argv[1]?.endsWith('inherited-files.mjs')) main();
