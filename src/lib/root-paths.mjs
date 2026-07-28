// @ts-check
/**
 * root-paths.mjs — find (and fix) references to moved scripts at their OLD
 * repo-root paths.
 *
 * WHY THIS EXISTS
 * ---------------
 * Frontrunner moved ~94 scripts from the repo root into src/. Upstream still
 * writes against the flat layout, so every `git pull upstream main` can bring
 * in new code referencing `scan.mjs` instead of `src/scan/scan.mjs`.
 *
 * The first merge after the reorg brought exactly that: two NEW upstream tests
 * imported scan.mjs and scan-ats-full.mjs from the root. Neither failed
 * loudly — one surfaced as an unrelated assertion, the other as an async
 * "resource generated activity after the test ended" that killed the run
 * without printing a single ❌.
 *
 * So this is checked mechanically instead of by eye:
 *
 *     node src/lib/root-paths.mjs            # report
 *     node src/lib/root-paths.mjs --fix      # repair in place
 *
 * and `tests/frontrunner/root-paths.test.mjs` fails the suite if any survive.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { ROOT } from '#paths';

/** Files worth scanning. Excludes the web app, which has its own layout. */
function scannableFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => /\.(mjs|json|md|sh|yml|ts|tsx)$/.test(f))
    .filter((f) => !f.startsWith('node_modules/'))
    // scaffolder ships standalone and legitimately describes the upstream layout
    .filter((f) => !f.startsWith('scaffolder/'));
}

/** basename -> current path, for everything that lives under src/ now. */
function movedScripts() {
  const out = execFileSync('git', ['ls-files', 'src/**/*.mjs'], { cwd: ROOT, encoding: 'utf8' });
  const map = new Map();
  for (const f of out.split('\n').filter(Boolean)) {
    if (/\.test\.mjs$|-tests\.mjs$/.test(f)) continue;
    map.set(basename(f), f);
  }
  return map;
}

/**
 * Patterns that mean "this resolves against the repo root". Deliberately
 * narrow: a bare mention of `scan.mjs` in prose is fine, an invocation is not.
 *
 * @param {string} base - e.g. "scan.mjs"
 */
function stalePatterns(base) {
  const b = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // join(ROOT, 'scan.mjs') / join(CAREER_OPS, "scan.mjs")
    new RegExp(`join\\(\\s*(?:ROOT|CAREER_OPS)\\s*,\\s*['"]${b}['"]`, 'g'),
    // "$PROJECT_DIR/scan.mjs" and friends
    new RegExp(`\\$\\{?[A-Z_]+\\}?/${b}`, 'g'),
    // node scan.mjs   (help text, docs, npm scripts)
    new RegExp(`node ${b}(?![\\w/.-])`, 'g'),
  ];
}

/**
 * @returns {{file:string, line:number, base:string, current:string, text:string}[]}
 */
export function findStaleRootPaths() {
  const moved = movedScripts();
  const findings = [];
  for (const file of scannableFiles()) {
    let src;
    try {
      src = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const lines = src.split('\n');
    for (const [base, current] of moved) {
      if (!src.includes(base)) continue;
      for (const re of stalePatterns(base)) {
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            findings.push({ file, line: i + 1, base, current, text: lines[i].trim().slice(0, 120) });
          }
        }
      }
    }
  }
  return findings;
}

/** Repair every finding in place. @returns {number} files changed */
export function fixStaleRootPaths() {
  const moved = movedScripts();
  const touched = new Set();
  for (const file of scannableFiles()) {
    const path = join(ROOT, file);
    let src;
    try {
      src = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const before = src;
    for (const [base, current] of moved) {
      if (!src.includes(base)) continue;
      for (const re of stalePatterns(base)) {
        src = src.replace(re, (m) => m.replace(base, current));
      }
    }
    if (src !== before) {
      writeFileSync(path, src);
      touched.add(file);
    }
  }
  return touched.size;
}

// --------------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const fix = process.argv.includes('--fix');
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log(`root-paths.mjs — find references to moved scripts at their old root paths

Usage:
  node src/lib/root-paths.mjs           report stale references
  node src/lib/root-paths.mjs --fix     repair them in place

Run this after every 'git pull upstream main'.`);
    process.exit(0);
  }

  if (fix) {
    const n = fixStaleRootPaths();
    console.log(n === 0 ? 'Nothing to fix.' : `Repaired root-path references in ${n} file(s).`);
    process.exit(0);
  }

  const findings = findStaleRootPaths();
  if (findings.length === 0) {
    console.log('OK: no stale root-path references.');
    process.exit(0);
  }
  console.error(`${findings.length} stale root-path reference(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.base} -> ${f.current}`);
    console.error(`    ${f.text}\n`);
  }
  console.error('Fix with: node src/lib/root-paths.mjs --fix');
  process.exit(1);
}
