import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  assertOfficialUpdateSource,
  CANONICAL_REPO,
  FRONTRUNNER_REPO_SLUG,
  installUpdatedDependencies,
} from '../../update-system.mjs';

test('the updater has exactly one official Frontrunner source', () => {
  assert.equal(FRONTRUNNER_REPO_SLUG, 'Furls-Digital/frontrunner');
  assert.equal(
    assertOfficialUpdateSource(CANONICAL_REPO),
    'https://github.com/Furls-Digital/frontrunner.git',
  );

  const source = readFileSync(new URL('../../update-system.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /github\.com\/santifer\/career-ops/iu);
  assert.doesNotMatch(source, /raw\.githubusercontent\.com\/santifer\/career-ops/iu);
  assert.doesNotMatch(source, /api\.github\.com\/repos\/santifer\/career-ops/iu);
});

test('the updater rejects the parent repository and URL confusion', () => {
  const rejected = [
    'https://github.com/santifer/career-ops.git',
    'https://github.com/Furls-Digital/frontrunner',
    'http://github.com/Furls-Digital/frontrunner.git',
    'https://github.com/Furls-Digital/frontrunner.git?ref=main',
    'https://github.com@evil.example/Furls-Digital/frontrunner.git',
    'git@github.com:Furls-Digital/frontrunner.git',
    'not-a-url',
  ];

  for (const candidate of rejected) {
    assert.throws(
      () => assertOfficialUpdateSource(candidate),
      error => error?.code === 'UNTRUSTED_UPDATE_SOURCE',
      candidate,
    );
  }
});

test('CLI update commands fail closed if the canonical source policy is removed', () => {
  const source = readFileSync(new URL('../../update-system.mjs', import.meta.url), 'utf8');
  const sabotaged = source.replace(
    "export const CANONICAL_REPO = `https://github.com/${FRONTRUNNER_REPO_SLUG}.git`;",
    "export const CANONICAL_REPO = 'https://github.com/santifer/career-ops.git';",
  );
  assert.notEqual(sabotaged, source, 'fixture must replace the canonical source');

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-updater-origin-'));
  try {
    const fixture = join(fixtureRoot, 'update-system.mjs');
    const driver = join(fixtureRoot, 'verify-source.mjs');
    writeFileSync(fixture, sabotaged);
    writeFileSync(driver, `
      import { assertOfficialUpdateSource, CANONICAL_REPO } from './update-system.mjs';
      assertOfficialUpdateSource(CANONICAL_REPO);
    `);
    const result = spawnSync(process.execPath, [driver], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5_000,
    });

    assert.notEqual(result.status, 0, 'tampered updater source must abort');
    assert.match(result.stderr, /Refusing update from untrusted source/u);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('dependency installation covers every shipped app and fails the update on any error', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-updater-deps-'));
  try {
    for (const relative of ['.', 'ui', 'web']) {
      const dir = join(fixtureRoot, relative);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{}\n');
    }
    for (const relative of ['.', 'ui', 'web']) {
      writeFileSync(join(fixtureRoot, relative, 'package-lock.json'), '{}\n');
    }

    const calls = [];
    const installed = installUpdatedDependencies(fixtureRoot, {
      run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
      },
    });
    assert.deepEqual(installed, ['.', 'ui', 'web']);
    assert.deepEqual(
      calls.map(call => [call.command, call.args[0], call.cwd]),
      [
        ['npm', 'ci', fixtureRoot],
        ['npm', 'ci', join(fixtureRoot, 'ui')],
        ['npm', 'ci', join(fixtureRoot, 'web')],
      ],
    );
    assert.ok(calls.every(call => call.args.includes('--ignore-scripts')));

    assert.throws(
      () => installUpdatedDependencies(fixtureRoot, {
        run(_command, _args, options) {
          if (options.cwd === join(fixtureRoot, 'ui')) throw new Error('injected npm failure');
        },
      }),
      error => (
        error?.code === 'DEPENDENCY_INSTALL_FAILED' &&
        error.failures.some(failure => /ui: injected npm failure/u.test(failure))
      ),
    );

    rmSync(join(fixtureRoot, 'web', 'package-lock.json'));
    assert.throws(
      () => installUpdatedDependencies(fixtureRoot, { run() {} }),
      error => (
        error?.code === 'DEPENDENCY_INSTALL_FAILED' &&
        error.failures.includes('web: package-lock.json is missing')
      ),
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
