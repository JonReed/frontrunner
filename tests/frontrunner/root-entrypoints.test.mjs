import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';

function source(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function lineCount(text) {
  return text.trimEnd().split('\n').length;
}

test('public root commands remain thin compatibility entry points', () => {
  const entrypoints = new Map([
    ['doctor.mjs', './src/application/doctor.mjs'],
    ['find.mjs', './src/tracker/find.mjs'],
    ['test-all.mjs', './tests/runner.mjs'],
  ]);

  for (const [relativePath, implementation] of entrypoints) {
    const text = source(relativePath);
    assert.ok(
      lineCount(text) <= 30,
      `${relativePath} grew implementation logic; move it behind ${implementation}`,
    );
    assert.ok(text.includes(implementation), `${relativePath} lost its stable implementation boundary`);
    assert.doesNotMatch(
      text,
      /dirname\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url/u,
      `${relativePath} must use the canonical root boundary`,
    );
  }
});

test('ordered core test modules stay bounded and exactly registered', () => {
  const coreDir = join(ROOT, 'tests', 'core');
  const modules = readdirSync(coreDir)
    .filter(name => /^\d{2}-.+\.mjs$/u.test(name))
    .sort();
  const runner = source('tests/runner.mjs');

  assert.ok(modules.length >= 8, 'test orchestration collapsed back into broad modules');
  assert.ok(lineCount(runner) <= 500, 'tests/runner.mjs grew domain assertions');
  for (const name of modules) {
    assert.ok(
      lineCount(source(`tests/core/${name}`)) <= 1_600,
      `${name} became a monolith; split it at a domain boundary`,
    );
    assert.equal(
      runner.split(`./core/${name}`).length - 1,
      1,
      `${name} must be registered exactly once by tests/runner.mjs`,
    );
  }

  const registered = [...runner.matchAll(/\.\/core\/(\d{2}-.+?\.mjs)/gu)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(registered, modules, 'runner/core registration drifted');
});

test('repository text policy enforces LF independently of editor support', () => {
  assert.match(source('.editorconfig'), /end_of_line = lf/u);
  assert.match(source('.gitattributes'), /^\* text=auto eol=lf$/mu);
});
