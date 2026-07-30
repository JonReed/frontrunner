// module-loadability.test.mjs — every module must resolve its imports.
//
// WHY THIS EXISTS
// ---------------
// During the src/ reorganisation, every single breakage was the same shape: a
// module that no longer resolved an import, silent until something happened to
// run it. The existing suite could not see them because 21 of 76 modules have
// no test of any kind, and several of the broken ones were reached only by the
// web UI or the Go dashboard.
//
// Worse, one failure mode produced NO output at all: batch-runner.sh invokes
// `node "$PROJECT_DIR/src/tracker/merge-tracker.mjs"` under `set -e`, so a moved file made
// the whole runner exit silently with an empty stdout and a passing-looking
// test elsewhere.
//
// This test spawns every module and fails on module-resolution errors. It does
// not assert exit codes: plenty of these are CLIs that legitimately exit
// non-zero without arguments. It asserts only that Node could LOAD them.
//
// It is deliberately exhaustive rather than curated — a curated list is exactly
// what would have missed the files nothing else touches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Modules with side effects on ANY invocation, including --help. Executing
 * these in a test is not just noisy, it is user-hostile: manifesto.mjs spawns
 * the system browser, so running the suite opened a browser tab per run.
 * They are still covered by the --check (syntax) pass below.
 */
const SIDE_EFFECTING = new Set([
  // (manifesto.mjs was removed — it spawned a browser at the upstream site.)
]);

/** Every tracked .mjs that is a module or CLI (not a test). */
function trackedModules() {
  const out = execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.test\.mjs$|-tests\.mjs$/.test(f))
    .filter((f) => !f.startsWith('web/'))          // web has its own toolchain
    .filter((f) => !f.startsWith('node_modules/'))
    .filter((f) => !SIDE_EFFECTING.has(f));
}

const MODULES = trackedModules();

/** Errors that mean "this file is broken", vs. normal CLI complaints. */
const FATAL = [
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find module/,
  /ERR_UNSUPPORTED_DIR_IMPORT/,
  /ERR_PACKAGE_PATH_NOT_EXPORTED/,
  /SyntaxError/,
  /ReferenceError/,
  /is not defined/,
];

test('every module is syntactically valid', () => {
  const broken = [];
  for (const m of MODULES) {
    try {
      execFileSync(process.execPath, ['--check', join(ROOT, m)], { stdio: 'pipe' });
    } catch (e) {
      broken.push(`${m}: ${String(e.stderr ?? e.message).split('\n')[0]}`);
    }
  }
  assert.deepEqual(broken, [], 'modules failed --check');
});

test('every module resolves its imports', () => {
  // STATIC resolution, deliberately. The first version of this test spawned
  // `node <module> --help` for all ~76 modules with a 30s timeout each: any
  // module that ignored --help and started real work burned its full timeout,
  // so the suite could take over half an hour. It also had side effects —
  // manifesto.mjs opened a browser, reply-watch.mjs created a file named
  // '--help'. Parsing import specifiers catches the same breakage in
  // milliseconds with no execution at all.
  const broken = [];
  for (const m of MODULES) {
    const dir = dirname(join(ROOT, m));
    // Strip comments first so import-like prose is not treated as code.
    const src = readFileSync(join(ROOT, m), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const specs = [
      ...src.matchAll(/(?:^|[\s;])(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((x) => x[1]);

    for (const spec of specs) {
      if (spec.startsWith('node:') || spec.startsWith('#')) continue;   // builtin / subpath
      if (!spec.startsWith('.')) continue;                              // bare package
      if (!existsSync(join(dir, spec))) broken.push(`${m} -> ${spec}`);
    }
  }
  assert.deepEqual(broken, [], 'unresolved relative imports');
});

test('every declared #paths subpath resolves', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const imports = pkg.imports ?? {};
  assert.ok(Object.keys(imports).length > 0, 'package.json declares no imports map');
  for (const [alias, target] of Object.entries(imports)) {
    assert.ok(existsSync(join(ROOT, target)), `${alias} -> ${target} does not exist`);
  }
});

// ---------------------------------------------------------------------------
// Path hygiene — the invariants that make the tree safe to rearrange again.
// ---------------------------------------------------------------------------

test('no module outside src/paths.mjs derives the repo root from its own location', () => {
  // This duplication (61 copies) is what made the first reorganisation
  // expensive. If it creeps back, the next one will be expensive too.
  const ALLOWED = new Set([
    'src/paths.mjs',
    // The updater must be self-loading because old clients check out this one
    // file before the target release has materialized its dependencies.
    'update-system.mjs',
    // Must resolve its own location: it detects being run from an untracked
    // temp copy, which a shared ROOT would mask.
    'validate-system-paths-coverage.mjs',
  ]);
  const offenders = [];
  for (const m of MODULES) {
    if (ALLOWED.has(m)) continue;
    if (m.startsWith('batch/')) continue;       // standalone batch tooling
    const src = readFileSync(join(ROOT, m), 'utf8');
    // Match ANY use, not just `const X = ...`. scan.mjs built its providers
    // path inline — path.resolve(path.dirname(fileURLToPath(...)), 'providers')
    // — and slipped past a declaration-only check, silently breaking provider
    // loading for every scan run.
    if (/dirname\(fileURLToPath\(import\.meta\.url\)\)/.test(src)) {
      offenders.push(m);
    }
  }
  assert.deepEqual(offenders, [], 'use `import { ROOT } from "#paths"` instead');
});

test('no module reaches outside the repo with ../..', () => {
  const offenders = [];
  for (const m of MODULES) {
    // Strip comments first so import-like prose is not treated as code.
    const src = readFileSync(join(ROOT, m), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const specs = [
      ...src.matchAll(/(?:^|\s)(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    for (const spec of specs) {
      if (!/^\.\.\/(?:\.\.\/)+/.test(spec[1])) continue;
      const depth = m.split('/').length - 1;
      const ups = (spec[1].match(/\.\.\//g) ?? []).length;
      if (ups > depth) offenders.push(`${m} -> ${spec[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'relative path escapes the repository');
});

test('the module inventory is non-trivial (guards against a silent no-op)', () => {
  // If git ls-files ever returns nothing — the failure mode that made the
  // upstream SYSTEM_PATHS guard a no-op for its whole life — this test must
  // fail rather than vacuously pass.
  assert.ok(MODULES.length > 50, `only found ${MODULES.length} modules — inventory looks broken`);
});
