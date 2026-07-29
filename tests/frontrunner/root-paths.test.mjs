// root-paths.test.mjs — no reference may point at a moved script's old path.
//
// Frontrunner moved ~94 scripts out of the repo root; upstream still writes
// against the flat layout. Every `git pull upstream main` can therefore
// reintroduce `join(ROOT, 'scan.mjs')` or `node scan.mjs`.
//
// The first post-reorg merge did exactly that, and NEITHER instance failed
// loudly: one surfaced as an unrelated assertion, the other as an async
// "resource generated activity after the test ended" that killed the suite
// without printing a single failure marker. Both were found by hand.
//
// This test makes that mechanical. When it fails after a merge, the fix is:
//
//     node src/lib/root-paths.mjs --fix

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findStaleRootPaths, fixStaleRootPaths } from '../../src/lib/root-paths.mjs';

test('no reference points at a moved script\'s old root path', () => {
  const stale = findStaleRootPaths();
  const report = stale.map((f) => `${f.file}:${f.line}  ${f.base} -> ${f.current}`);
  assert.deepEqual(report, [], 'run: node src/lib/root-paths.mjs --fix');
});

test('destructive fixer repairs tracked invocations, leaves prose alone, and is idempotent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'frontrunner-root-paths-'));
  const inheritedRootAlias = ['CAREER', 'OPS'].join('_');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (relative, contents) => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };

  put('src/scan/scan.mjs', 'export const scan = true;\n');
  put(
    'docs/usage.md',
    [
      'Run `node scan.mjs` to scan.',
      'The file scan.mjs is the scanner entry point.',
      '',
    ].join('\n'),
  );
  put(
    'scripts/launch.mjs',
    [
      "const command = join(ROOT, 'scan.mjs');",
      `const inherited = join(${inheritedRootAlias}, 'scan.mjs');`,
      "const result = run(NODE, ['scan.mjs']);",
      '',
    ].join('\n'),
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });

  const before = findStaleRootPaths(root);
  assert.deepEqual(
    before.map(({ file, line }) => `${file}:${line}`).sort(),
    ['docs/usage.md:1', 'scripts/launch.mjs:1', 'scripts/launch.mjs:2', 'scripts/launch.mjs:3'],
  );

  assert.equal(fixStaleRootPaths(root), 2);
  assert.match(readFileSync(join(root, 'docs/usage.md'), 'utf8'), /node src\/scan\/scan\.mjs/);
  assert.match(readFileSync(join(root, 'docs/usage.md'), 'utf8'), /file scan\.mjs is/);
  assert.match(readFileSync(join(root, 'scripts/launch.mjs'), 'utf8'), /join\(ROOT, 'src\/scan\/scan\.mjs'\)/);
  assert.match(
    readFileSync(join(root, 'scripts/launch.mjs'), 'utf8'),
    new RegExp(`join\\(${inheritedRootAlias}, 'src/scan/scan\\.mjs'\\)`),
  );
  assert.match(readFileSync(join(root, 'scripts/launch.mjs'), 'utf8'), /run\(NODE, \['src\/scan\/scan\.mjs'\]\)/);
  assert.deepEqual(findStaleRootPaths(root), []);
  assert.equal(fixStaleRootPaths(root), 0, 'second repair changed already-correct files');
});
