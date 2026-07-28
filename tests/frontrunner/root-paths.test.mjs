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
import { findStaleRootPaths } from '../../src/lib/root-paths.mjs';

test('no reference points at a moved script\'s old root path', () => {
  const stale = findStaleRootPaths();
  const report = stale.map((f) => `${f.file}:${f.line}  ${f.base} -> ${f.current}`);
  assert.deepEqual(report, [], 'run: node src/lib/root-paths.mjs --fix');
});
