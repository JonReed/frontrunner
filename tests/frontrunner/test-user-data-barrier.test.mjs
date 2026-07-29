import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { ROOT } from '#paths';
import { isRealUserDataPath } from '../../src/lib/test-user-data-policy.mjs';

const PROFILE_CONTROL = fileURLToPath(
  new URL('../../src/application/profile-control.mjs', import.meta.url),
);
const BARRIER = fileURLToPath(
  new URL('../test-user-data-write-barrier.mjs', import.meta.url),
);
const LEGACY_PROFILE_BASE = ['CAREER', 'OPS', 'PROFILE', 'BASE'].join('_');
const REAL_USER_PATHS = [
  join(ROOT, 'cv.md'),
  join(ROOT, 'config', 'profile.yml'),
  join(ROOT, 'cv-versions', '01-focused.md'),
];

function snapshot(paths) {
  return paths.map(path => ({
    path,
    exists: existsSync(path),
    content: existsSync(path) ? readFileSync(path) : null,
  }));
}

function assertUnchanged(before) {
  for (const entry of before) {
    assert.equal(existsSync(entry.path), entry.exists, entry.path);
    if (entry.exists) assert.deepEqual(readFileSync(entry.path), entry.content, entry.path);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

test('the write policy identifies the complete real user layer, not temporary fixtures', () => {
  for (const path of [
    'cv.md',
    'config/profile.yml',
    'modes/_profile.md',
    'data/applications.md',
    'reports/001-example.md',
    'output/cv.pdf',
    'jds/job.md',
    'cv-versions/01-focused.md',
  ]) {
    assert.equal(isRealUserDataPath(join(ROOT, path)), true, path);
  }
  assert.equal(isRealUserDataPath(join(ROOT, 'src', 'application', 'run.mjs')), false);
  assert.equal(isRealUserDataPath(join(tmpdir(), 'fixture', 'cv.md')), false);
});

test('destructive barrier: a legacy direct fs write cannot touch real cv.md', async () => {
  const before = snapshot([join(ROOT, 'cv.md')]);
  const barrierUrl = pathToFileURL(BARRIER).href;
  const result = await run(process.execPath, [
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(join(ROOT, 'cv.md'))}, 'unsafe')`,
  ], {
    env: {
      ...process.env,
      FRONTRUNNER_TEST_PROTECTED_ROOT: ROOT,
      NODE_OPTIONS: `--import=${barrierUrl}`,
    },
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /TEST_USER_DATA_WRITE_BLOCKED|refused to write real user data/u);
  assertUnchanged(before);
});

test('destructive barrier: a stale profile fixture override cannot touch any real user file', async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-stale-profile-base-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const before = snapshot(REAL_USER_PATHS);
  const result = await run(process.execPath, [PROFILE_CONTROL], {
    env: {
      ...process.env,
      // Reproduce the exact historical failure: production ignores this old
      // name and would otherwise fall back to ROOT.
      [LEGACY_PROFILE_BASE]: fixture,
      FRONTRUNNER_TEST_PROTECTED_ROOT: ROOT,
      NODE_OPTIONS: `--import=${pathToFileURL(BARRIER).href}`,
    },
    input: JSON.stringify({
      version: '1',
      action: 'save',
      cv: '# Must never land',
      versions: [{ label: 'focused', text: '# Must never land' }],
      fields: { 'candidate.full_name': 'Must never land' },
    }),
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /TEST_USER_DATA_WRITE_BLOCKED|refused to write real user data/u);
  assertUnchanged(before);
  assert.equal(existsSync(join(fixture, 'cv.md')), false);
});

test('the barrier permits writes inside an explicit temporary fixture', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-write-barrier-'));
  try {
    const file = join(fixture, 'cv.md');
    writeFileSync(file, '# Isolated\n');
    assert.equal(readFileSync(file, 'utf8'), '# Isolated\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
