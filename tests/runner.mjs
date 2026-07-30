#!/usr/bin/env node

/**
 * test-all.mjs — Comprehensive test suite for frontrunner
 *
 * Run before merging any PR or pushing changes.
 * Tests: syntax, scripts, data contract, personal data, paths, and backend workflows.
 *
 * Usage:
 *   node test-all.mjs                        # Run all tests
 *   node test-all.mjs --only <substring>      # Run ONLY discovered tests/**\/*.test.mjs
 *                                             # files whose path contains <substring>
 *                                             # (e.g. --only providers/themuse).
 *
 *   LOUD WARNING: `--only` runs ONLY discovered tests/ files — every inline
 *   core section above (syntax, scripts, data contract, personal
 *   data, paths, etc.) is SKIPPED. A green `--only` run is NOT a green
 *   suite. Always run the full suite (no flags) before pushing.
 *
 * Provider tests live in tests/providers/{name}.test.mjs and are
 * auto-discovered — no registration needed. To add a test for a new
 * provider, create that one file; do not add a section to this file.
 */


import { execSync, execFileSync, spawn, spawnSync } from 'child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'fs';
import { join, dirname, basename, delimiter } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { pass, fail, warn, run, fileExists, finish, ROOT, NODE, getBash, toBashPath } from './helpers.mjs';

/**
 * Run the entire suite in a disposable copy of the current source tree.
 *
 * The inherited suite contains realistic integration tests whose programs
 * derive data/output paths from ROOT. Running those inside a provisioned
 * checkout can overwrite ignored user data. A tracked+untracked source copy
 * preserves the exact code under test, while omitting every ignored user file.
 */
function runInDisposableWorkspace() {
  const sandbox = mkdtempSync(join(tmpdir(), 'frontrunner-test-workspace-'));
  try {
    const testHome = join(sandbox, '.test-home');
    const testTmp = join(sandbox, '.test-tmp');
    const xdgConfig = join(testHome, '.config');
    const xdgCache = join(testHome, '.cache');
    const emptyGitConfig = join(testHome, '.gitconfig');
    for (const directory of [testHome, testTmp, xdgConfig, xdgCache]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(
      emptyGitConfig,
      '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgSign = false\n',
      'utf8',
    );

    // Deliberately do not spread process.env. Tests must not vary with or leak
    // the operator's API keys, proxies, cloud credentials, HOME configuration,
    // locale, package caches, or NODE_OPTIONS preload hooks.
    const pathKey = Object.keys(process.env)
      .find(name => name.toLowerCase() === 'path') ?? 'PATH';
    const executablePath = process.env[pathKey] ?? '';
    const cleanEnv = {
      [pathKey]: executablePath,
      HOME: testHome,
      USERPROFILE: testHome,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      TMPDIR: testTmp,
      TMP: testTmp,
      TEMP: testTmp,
      TZ: 'UTC',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      USER: 'frontrunner-test',
      USERNAME: 'frontrunner-test',
      CI: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_TERMINAL_PROMPT: '0',
      npm_config_cache: join(xdgCache, 'npm'),
      PLAYWRIGHT_BROWSERS_PATH: join(xdgCache, 'playwright'),
      FRONTRUNNER_TEST_HERMETIC: '1',
    };
    for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SHELL']) {
      if (process.env[name]) cleanEnv[name] = process.env[name];
    }

    const listed = spawnSync(
      'git',
      ['ls-files', '-z', '-co', '--exclude-standard'],
      { cwd: ROOT, env: cleanEnv, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
    );
    if (listed.status !== 0) {
      throw new Error(`could not inventory test source: ${String(listed.stderr ?? '')}`);
    }
    for (const relativePath of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const source = join(ROOT, relativePath);
      const destination = join(sandbox, relativePath);
      let stat;
      try {
        stat = lstatSync(source);
      } catch (error) {
        // `git ls-files -c` includes a tracked path deleted in the current
        // worktree. That deletion is part of the source state under test, not
        // a reason to resurrect the index copy or crash before QA starts.
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      mkdirSync(dirname(destination), { recursive: true });
      if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), destination);
      } else if (stat.isFile()) {
        copyFileSync(source, destination);
        chmodSync(destination, stat.mode & 0o777);
      }
    }
    for (const args of [
      ['init', '-q'],
      ['add', '-A'],
      [
        '-c', 'user.name=Frontrunner Test',
        '-c', 'user.email=tests@invalid.example',
        'commit', '-qm', 'isolated test source',
      ],
    ]) {
      const result = spawnSync('git', args, { cwd: sandbox, env: cleanEnv, encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`could not prepare disposable test repository: ${result.stderr}`);
      }
      if (args[0] === 'init') {
        writeFileSync(
          join(sandbox, '.git', 'info', 'exclude'),
          '.test-home/\n.test-tmp/\n',
          'utf8',
        );
      }
    }
    // Dependencies are runtime-only links, added after the disposable commit
    // so coverage and git inventory cannot mistake them for product files.
    for (const relativePath of ['node_modules', 'ui/node_modules', 'web/node_modules']) {
      const source = join(ROOT, relativePath);
      if (!existsSync(source)) continue;
      const destination = join(sandbox, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(source, destination);
    }

    const barrierImport = pathToFileURL(
      join(sandbox, 'tests', 'test-user-data-write-barrier.mjs'),
    ).href;
    const networkBarrierImport = pathToFileURL(
      join(sandbox, 'tests', 'test-hermetic-network-barrier.mjs'),
    ).href;
    const nodeOptions = [
      `--import=${barrierImport}`,
      `--import=${networkBarrierImport}`,
    ].join(' ');
    const result = spawnSync(
      process.execPath,
      [join(sandbox, 'test-all.mjs'), ...process.argv.slice(2)],
      {
        cwd: sandbox,
        env: {
          ...cleanEnv,
          FRONTRUNNER_TEST_SANDBOX: '1',
          FRONTRUNNER_TEST_PROTECTED_ROOT: ROOT,
          NODE_OPTIONS: nodeOptions,
        },
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (process.env.FRONTRUNNER_TEST_SANDBOX !== '1') {
  process.exitCode = runInDisposableWorkspace();
} else {

/**
 * Read a repo-relative text file as UTF-8.
 *
 * @param {string} path - Path relative to the frontrunner repository root.
 * @returns {string} File contents.
 */
function readFile(path) {
  const fullPath = join(ROOT, path);
  let content = readFileSync(fullPath, 'utf-8');
  if (content.trim().startsWith('..') && content.trim().split('\n').length === 1) {
    const target = join(dirname(fullPath), content.trim());
    if (existsSync(target)) {
      content = readFileSync(target, 'utf-8');
    }
  }
  return content;
}

/**
 * Normalize CRLF line endings to LF (#1771).
 *
 * On Windows checkouts with core.autocrlf=true, repo text files arrive with
 * CRLF endings. Doc assertions that anchor on `\n` (JS `.` never matches `\r`)
 * then fail on pristine main. Normalizing at read time keeps the assertions
 * byte-ending agnostic without touching any regex.
 *
 * @param {string} text - Raw file contents.
 * @returns {string} Contents with LF-only line endings.
 */
const normalizeEol = (text) => text.replace(/\r\n/g, '\n');

/**
 * Read a repo text file with line endings normalized to LF (#1771).
 * Use for doc-content reads that feed `\n`-anchored regex assertions.
 * Do NOT use where byte-exact content matters.
 *
 * @param {string} path - Path relative to the frontrunner repository root.
 * @returns {string} File contents with LF-only line endings.
 */
const readTextLF = (path) => normalizeEol(readFile(path));

// ── Auto-discovered test files (issue #1440) ─────────────────────────────
// Deterministic: recursive readdirSync with default lexicographic sort of
// entry names — same order on every run and OS. No glob library, no
// registration list. Discovery is limited to tests/ so root-level
// standalone *.test.mjs files are never picked up.
const TESTS_DIR = join(ROOT, 'tests');

function discoverTests(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...discoverTests(full));
    else if (entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

async function runDiscovered(filter = null) {
  let files = discoverTests(TESTS_DIR);
  if (filter) {
    const norm = (p) => p.slice(TESTS_DIR.length + 1).replace(/\\/g, '/');
    files = files.filter((f) => norm(f).includes(filter));
  }
  if (files.length === 0) {
    // Fail hard: a path typo must never silently turn CI green.
    console.log(`  ❌ no test files matched${filter ? ` --only "${filter}"` : ''} under tests/`);
    process.exit(1);
  }
  const nodeTestFiles = [];
  for (const f of files) {
    const source = readFileSync(f, 'utf-8');
    // Discovered suites run IN-PROCESS and share this suite's counters. A
    // process.exit() inside one would terminate test-all mid-run with a forged
    // exit code — every later section (and finish()) would silently never run.
    // Refuse to import such a suite and fail loudly instead (#1916 regression).
    if (/\bprocess\.exit\s*\(/.test(source)) {
      fail(`${f.slice(ROOT.length + 1)} calls process.exit() — discovered suites must use pass/fail from tests/helpers.mjs and never exit`);
      continue;
    }
    // node:test schedules its assertions after import(). finish() deliberately
    // exits, so importing those files used to let a failing assertion disappear
    // behind a green aggregate result. Run framework suites in one supervised
    // child and translate its exit status into the shared counters.
    if (/\bfrom\s+['"]node:test['"]/.test(source)) {
      nodeTestFiles.push(f);
      continue;
    }
    await import(pathToFileURL(f).href);
  }
  if (nodeTestFiles.length > 0) {
    const result = spawnSync(NODE, ['--test', ...nodeTestFiles], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status === 0) {
      pass(`${nodeTestFiles.length} node:test suites passed`);
    } else {
      const detail = [result.stdout, result.stderr, result.error?.message]
        .filter(Boolean)
        .join('\n')
        .trim();
      if (detail) console.log(detail);
      fail(`${nodeTestFiles.length} node:test suites failed`);
    }
  }
}

const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] ?? '') : null;
if (ONLY !== null) {
  if (ONLY === '' || ONLY.startsWith('--')) {
    console.log('  ❌ --only requires a path substring, e.g. --only providers/themuse');
    process.exit(1);
  }
  console.log('\n🧪 frontrunner test suite (--only ' + ONLY + ')\n');
  await runDiscovered(ONLY);
  finish();
}

console.log('\n🧪 frontrunner test suite\n');

await import(new URL('./core/01-bootstrap-and-data-contracts.mjs', import.meta.url));
await import(new URL('./core/02-renderer-updater-and-language.mjs', import.meta.url));
await import(new URL('./core/03-modes-and-language.mjs', import.meta.url));
await import(new URL('./core/04-scan-and-portals.mjs', import.meta.url));
await import(new URL('./core/05-agent-and-skill-contracts.mjs', import.meta.url));
await import(new URL('./core/06-tracker-foundations.mjs', import.meta.url));
await import(new URL('./core/07-tracker-merge-workflows.mjs', import.meta.url));
await import(new URL('./core/08-onboarding-and-rediscovery.mjs', import.meta.url));
await import(new URL('./core/09-batch-and-rendering.mjs', import.meta.url));
await import(new URL('./core/10-evaluation-and-scan.mjs', import.meta.url));
await import(new URL('./core/11-cross-surface-contracts.mjs', import.meta.url));

await runDiscovered();

finish();
}
