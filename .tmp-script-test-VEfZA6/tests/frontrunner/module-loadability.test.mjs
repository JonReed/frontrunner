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
// `node "$PROJECT_DIR/merge-tracker.mjs"` under `set -e`, so a moved file made
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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every tracked .mjs that is a module or CLI (not a test). */
function trackedModules() {
  const out = execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.test\.mjs$|-tests\.mjs$/.test(f))
    .filter((f) => !f.startsWith('web/'))          // web has its own toolchain
    .filter((f) => !f.startsWith('node_modules/'));
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

test('every module resolves its imports when executed', () => {
  const broken = [];
  for (const m of MODULES) {
    let output = '';
    try {
      output = execFileSync(process.execPath, [join(ROOT, m), '--help'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30_000,
        env: { ...process.env, CAREER_OPS_NO_NETWORK: '1' },
      });
    } catch (e) {
      // Non-zero exit is fine — many CLIs exit 1 without real arguments.
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    const fatal = FATAL.find((re) => re.test(output));
    if (fatal) {
      const line = output.split('\n').find((l) => fatal.test(l)) ?? '';
      broken.push(`${m}: ${line.trim().slice(0, 160)}`);
    }
  }
  assert.deepEqual(broken, [], 'modules failed to load');
});

// ---------------------------------------------------------------------------
// Path hygiene — the invariants that make the tree safe to rearrange again.
// ---------------------------------------------------------------------------

test('no module outside src/paths.mjs derives the repo root from its own location', () => {
  // This duplication (61 copies) is what made the first reorganisation
  // expensive. If it creeps back, the next one will be expensive too.
  const ALLOWED = new Set([
    'src/paths.mjs',
    // Must resolve its own location: it detects being run from an untracked
    // temp copy, which a shared ROOT would mask.
    'validate-system-paths-coverage.mjs',
  ]);
  const offenders = [];
  for (const m of MODULES) {
    if (ALLOWED.has(m)) continue;
    const src = readFileSync(join(ROOT, m), 'utf8');
    if (/const\s+(?:ROOT|CAREER_OPS|__dirname|REPO_ROOT|PROJECT_ROOT)\s*=\s*(?:join\()?dirname\(fileURLToPath\(import\.meta\.url\)\)/.test(src)) {
      offenders.push(m);
    }
  }
  assert.deepEqual(offenders, [], 'use `import { ROOT } from "#paths"` instead');
});

test('no module reaches outside the repo with ../..', () => {
  const offenders = [];
  for (const m of MODULES) {
    const src = readFileSync(join(ROOT, m), 'utf8');
    for (const spec of src.matchAll(/['"](\.\.\/(?:\.\.\/)+[\w./-]+)['"]/g)) {
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
