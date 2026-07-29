import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';

const legacySlug = ['career', 'ops'].join('-');
const legacyEnv = ['CAREER', 'OPS'].join('_');
const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

function trackedTextEntries() {
  const entries = [];
  for (const relativePath of trackedFiles) {
    const absolutePath = join(ROOT, relativePath);
    if (!existsSync(absolutePath)) continue;

    let content;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\0')) continue;
    entries.push({ relativePath, content });
  }
  return entries;
}

test('the shipped command and skill identity is Frontrunner', () => {
  const skillPath = '.agents/skills/frontrunner/SKILL.md';
  const skill = readFileSync(join(ROOT, skillPath), 'utf8');

  assert.match(skill, /^name: frontrunner$/m);
  assert.match(skill, /\/frontrunner pipeline\b/);
  assert.ok(trackedFiles.includes(skillPath));
  assert.ok(trackedFiles.includes('.claude/skills/frontrunner/SKILL.md'));
  assert.ok(trackedFiles.includes('.antigravitycli/skills/frontrunner/SKILL.md'));
});

test('the rename preserves truthful parent-project attribution', () => {
  const packageMetadata = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  assert.match(packageMetadata.description, new RegExp(`Fork of ${legacySlug}\\.`));
  assert.match(readme, new RegExp(`fork of \\[${legacySlug}\\]`));
  assert.match(readme, new RegExp(`Relationship to ${legacySlug}`));
  assert.doesNotMatch(packageMetadata.description, /fork of frontrunner/i);
  assert.doesNotMatch(readme, /fork of \[?frontrunner/i);
});

test('runtime and update guidance do not revive the removed manifesto promotion', () => {
  const activeFiles = ['doctor.mjs', 'update-system.mjs', 'modes/update.md'];
  for (const relativePath of activeFiles) {
    const content = readFileSync(join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(content, /frontrunner manifesto|npm run manifesto/i, relativePath);
  }
});

test('active files cannot restore the inherited command or identifiers', () => {
  const inheritedCommand = new RegExp(`(^|[^-A-Za-z0-9._~/\\\\])/${legacySlug}(?:-[A-Za-z0-9_-]+)?\\b`, 'm');
  const inheritedEnv = new RegExp(`\\b${legacyEnv}(?:_|\\b)`);
  const inheritedHelper = new RegExp(`\\b${legacySlug.replace('-', '')}`, 'i');
  const inheritedSkillPath = new RegExp(`(?:\\.agents|\\.claude|\\.antigravitycli)/skills/${legacySlug}\\b`);
  const inheritedManifestName = new RegExp(`(?:^name:\\s*|["']name["']\\s*:\\s*["'])${legacySlug}(?:$|["'])`, 'm');
  const inheritedPackageScope = new RegExp(`@${legacySlug}/`);

  const violations = [];
  for (const { relativePath, content } of trackedTextEntries()) {
    const checks = [
      ['command', inheritedCommand],
      ['environment variable', inheritedEnv],
      ['helper identifier', inheritedHelper],
      ['skill path', inheritedSkillPath],
      ['manifest name', inheritedManifestName],
      ['package scope', inheritedPackageScope],
    ];
    for (const [kind, pattern] of checks) {
      if (pattern.test(content)) violations.push(`${relativePath}: inherited ${kind}`);
    }
  }

  assert.deepEqual(violations, []);
});
