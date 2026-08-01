/**
 * AGENTS.md rule 3 — prefer new files over editing inherited ones — was
 * unenforceable while "inherited" was invisible. These assertions pin the two
 * mistakes that made the detector wrong twice while it was being written, both
 * of which fail in the same dangerous direction: reporting the parent's code as
 * this fork's, and inviting the rewrite the rule exists to prevent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { forkPoint, inheritedPaths, isInherited } from '../../src/lib/inherited-files.mjs';

/*
  The hermetic runner copies the repo into a temp tree without the `upstream`
  remote, so the detector correctly reports nothing there. Skipping is the
  honest response: asserting against an empty set would pass for the wrong
  reason and hide a real regression in a normal checkout.
*/
const inherited = inheritedPaths();
const available = inherited.size > 0;
const needsUpstream = { skip: available ? false : 'no upstream remote (hermetic runner)' };

test('the fork point is the divergence, not the initial release', needsUpstream, () => {
  // A fork shares the parent's whole history. Anchoring on the first commit
  // missed ~600 files added by the 994 commits before the split.
  assert.match(forkPoint(), /^[0-9a-f]{40}$/);
  assert.ok(inherited.size > 300, `expected the parent's tree, got ${inherited.size} files`);
});

test('renames are followed, so a moved file stays inherited', needsUpstream, () => {
  // This fork moved every script into src/. Matching on the path as it stood at
  // the fork point reports src/scan/scan.mjs as ours; it is the parent's
  // scan.mjs under a new name.
  assert.equal(isInherited('src/scan/scan.mjs', inherited), true);
  assert.equal(isInherited('src/tracker/merge-tracker.mjs', inherited), true);
  assert.equal(isInherited('modes/_shared.md', inherited), true);
});

test('files this fork wrote are not reported as inherited', needsUpstream, () => {
  for (const ours of [
    'src/lib/upstream-guard.mjs',
    'src/lib/model-routing.mjs',
    'src/lib/inherited-files.mjs',
    'tests/frontrunner/inherited-files.test.mjs',
  ]) {
    assert.equal(isInherited(ours, inherited), false, `${ours} is this fork's own work`);
  }
});

test('every reported path still exists', needsUpstream, async () => {
  // A deleted file must drop out: answering "inherited" for a path that is gone
  // sends a reader looking for content that is not there.
  const { execFileSync } = await import('node:child_process');
  const { ROOT } = await import('#paths');
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' })
      .split('\n').map((line) => line.trim()).filter(Boolean),
  );
  for (const path of inherited) assert.ok(tracked.has(path), `${path} is reported but untracked`);
});
