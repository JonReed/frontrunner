/**
 * Frontrunner's version is its own.
 *
 * The fork arrived carrying the parent's `1.23.0` — a number claiming 23 minor
 * releases that never happened in this repository — alongside 29 tags named
 * `career-ops-v*`. Both are gone, and the series restarted at 0.1.0 to say
 * something true: pre-1.0, nothing released yet.
 *
 * Five files carry the version. Nothing kept them in step, so a bump could
 * update `VERSION` and leave the plugin manifests advertising something else.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const json = (file) => JSON.parse(read(file));

// Mirrors update-system.mjs parseVersionFile(), which tolerates a trailing
// comment in a VERSION restored from an older backup.
const VERSION = read('VERSION').trim().split(/\s+/)[0];

test('every version-carrying file agrees with VERSION', () => {
  const carriers = {
    'package.json': json('package.json').version,
    'ui/package.json': json('ui/package.json').version,
    '.claude-plugin/plugin.json': json('.claude-plugin/plugin.json').version,
    '.github/plugin/plugin.json': json('.github/plugin/plugin.json').version,
  };
  for (const [file, version] of Object.entries(carriers)) {
    assert.equal(version, VERSION, `${file} must match VERSION (${VERSION})`);
  }

  // The marketplace manifest carries the version in more than one place.
  const marketplace = read('.claude-plugin/marketplace.json');
  const stale = [...marketplace.matchAll(/"version":\s*"([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((version) => version !== VERSION);
  assert.deepEqual(stale, [], `.claude-plugin/marketplace.json has stale versions: ${stale.join(', ')}`);
});

test('the lockfile records the same version', () => {
  // npm rewrites this on install; a mismatch means someone edited package.json
  // by hand and the lockfile still advertises the old number.
  const lock = json('package-lock.json');
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages['']?.version, VERSION);
});

test('the version is valid semver and has not drifted back to the parent series', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/u, 'VERSION must be bare semver');
  // 1.23.0 was the parent's number when this fork diverged. Landing on it again
  // means the inherited numbering came back rather than a real release.
  assert.notEqual(VERSION, '1.23.0', 'VERSION is the parent project number');
});
