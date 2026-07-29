// Shared CLI skill entrypoint bootstrap — used by update-system.
//
// .agents/skills/frontrunner/SKILL.md is canonical; each supported CLI gets a
// copy at the location it looks in. Copies rather than symlinks because not
// every filesystem supports them.
//
// Only the supported CLIs are listed. Frontrunner supports Claude Code and
// Codex, plus Antigravity for the free tier — and Codex reads CODEX.md rather
// than a skills directory, so it needs no entry. Copies for Cursor, OpenCode,
// Qwen, Grok and Kimi were removed with those CLIs: eight byte-identical
// copies of one 202-line file is not support, it is duplication.
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const CANONICAL_SKILL_PATH = '.agents/skills/frontrunner/SKILL.md';

export const SKILL_ENTRYPOINTS = [
  {
    path: '.claude/skills/frontrunner/SKILL.md',
    pointer: '../../../.agents/skills/frontrunner/SKILL.md',
  },
  {
    path: '.antigravitycli/skills/frontrunner/SKILL.md',
    pointer: '../../../.agents/skills/frontrunner/SKILL.md',
  },
];

const inheritedSkillName = ['career', 'ops'].join('-');
export const RETIRED_SKILL_ENTRYPOINTS = [
  `.agents/skills/${inheritedSkillName}/SKILL.md`,
  `.claude/skills/${inheritedSkillName}/SKILL.md`,
  `.antigravitycli/skills/${inheritedSkillName}/SKILL.md`,
];

function repoPath(root, path) {
  return join(root, ...path.split('/'));
}

/**
 * Remove only retired entrypoints that the caller has independently confirmed
 * are tracked system files. Untracked skills are user-owned and stay untouched.
 */
export function pruneRetiredSkillEntrypoints(root, trackedPaths = []) {
  const tracked = new Set(trackedPaths);
  const removed = [];
  for (const path of RETIRED_SKILL_ENTRYPOINTS) {
    if (!tracked.has(path)) continue;
    rmSync(repoPath(root, path), { force: true });
    removed.push(path);
  }
  return removed;
}

function readCanonical(root) {
  const canonicalPath = repoPath(root, CANONICAL_SKILL_PATH);
  if (!existsSync(canonicalPath)) return null;
  try {
    return readFileSync(canonicalPath, 'utf-8');
  } catch {
    return null;
  }
}

export function materializeSkillEntrypoints(root) {
  const canonicalContent = readCanonical(root);
  if (canonicalContent === null) return [];

  const materialized = [];
  for (const entry of SKILL_ENTRYPOINTS) {
    const entryPath = repoPath(root, entry.path);
    if (!existsSync(entryPath)) continue;

    let stat = null;
    try {
      stat = lstatSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isFile()) continue;

    try {
      const content = readFileSync(entryPath, 'utf-8').trim();
      if (content !== entry.pointer) continue;
      writeFileSync(entryPath, canonicalContent);
    } catch {
      continue;
    }
    materialized.push(entry.path);
  }

  return materialized;
}

export function ensureSkillEntrypoints(root) {
  const canonicalContent = readCanonical(root);
  if (canonicalContent === null) return [];

  const touched = [];
  for (const entry of SKILL_ENTRYPOINTS) {
    const entryPath = repoPath(root, entry.path);

    if (!existsSync(entryPath)) {
      try {
        mkdirSync(dirname(entryPath), { recursive: true });
        writeFileSync(entryPath, entry.pointer);
        touched.push(entry.path);
      } catch {
        continue;
      }
    }

    let stat = null;
    try {
      stat = lstatSync(entryPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isFile()) continue;

    try {
      const content = readFileSync(entryPath, 'utf-8').trim();
      if (content !== entry.pointer) continue;
      writeFileSync(entryPath, canonicalContent);
      if (!touched.includes(entry.path)) touched.push(entry.path);
    } catch {
      continue;
    }
  }

  return touched;
}
