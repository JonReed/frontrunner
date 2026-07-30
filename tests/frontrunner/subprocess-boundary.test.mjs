import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  SubprocessFailure,
  runBoundedSubprocess,
  runCheckedSubprocess,
} from '../../src/security/subprocess.mjs';

test('destructive argv probe proves shell text remains one inert argument', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'frontrunner-subprocess-')), 'owned');
  try {
    const hostile = `$(touch ${marker})`;
    const result = await runCheckedSubprocess(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      hostile,
    ], {
      timeoutMs: 5_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    });
    assert.equal(result.stdout, hostile);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(marker, { force: true });
    rmSync(join(marker, '..'), { recursive: true, force: true });
  }
});

test('destructive output flooding reaps the child at the byte boundary', async () => {
  await assert.rejects(
    runBoundedSubprocess(process.execPath, [
      '-e',
      'for (;;) process.stdout.write("x".repeat(4096))',
    ], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      terminationGraceMs: 50,
    }),
    error => error instanceof SubprocessFailure
      && error.code === 'SUBPROCESS_OUTPUT_LIMIT'
      && error.result.stdout.length <= 1_024,
  );
});

test('destructive timeout kills descendants before they can mutate state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-subprocess-tree-'));
  const marker = join(dir, 'late-write');
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 400)`;
  const parent = `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: 'ignore',
    });
    setInterval(() => {}, 1000);
  `;
  try {
    await assert.rejects(
      runBoundedSubprocess(process.execPath, ['-e', parent], {
        timeoutMs: 75,
        maxStdoutBytes: 4_096,
        maxStderrBytes: 4_096,
        terminationGraceMs: 75,
      }),
      error => error instanceof SubprocessFailure
        && error.code === 'SUBPROCESS_TIMEOUT',
    );
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checked execution exposes only bounded diagnostics for non-zero exits', async () => {
  await assert.rejects(
    runCheckedSubprocess(process.execPath, [
      '-e',
      'process.stderr.write("diagnostic"); process.exitCode = 7',
    ], {
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    }),
    error => error instanceof SubprocessFailure
      && error.code === 'SUBPROCESS_EXIT_NONZERO'
      && error.result.status === 7
      && error.result.stderr === 'diagnostic',
  );
});

test('invalid bounds and pre-cancelled work fail before launch', async () => {
  assert.throws(
    () => runBoundedSubprocess(process.execPath, ['-e', ''], { timeoutMs: 0 }),
    /positive integer/u,
  );
  assert.throws(
    () => runBoundedSubprocess(process.execPath, ['bad\0arg']),
    /NUL-free/u,
  );
  assert.throws(
    () => runBoundedSubprocess(process.execPath, ['-e', ''], {
      input: '12345',
      maxInputBytes: 4,
    }),
    error => error instanceof SubprocessFailure
      && error.code === 'SUBPROCESS_INPUT_LIMIT',
  );

  let launches = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runBoundedSubprocess(process.execPath, ['-e', ''], {
      signal: controller.signal,
      spawn() {
        launches++;
        throw new Error('must not launch');
      },
    }),
    error => error instanceof SubprocessFailure
      && error.code === 'SUBPROCESS_CANCELLED',
  );
  assert.equal(launches, 0);
});

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name) ? [path] : [];
  });
}

test('production subprocess capabilities cannot grow outside reviewed boundaries', () => {
  const files = [
    ...filesUnder(join(ROOT, 'src')),
    ...filesUnder(join(ROOT, 'providers')),
    ...filesUnder(join(ROOT, 'config')),
  ].filter(path => !/\.test\.mjs$/u.test(path));
  const sources = new Map(files.map(path => [
    relative(ROOT, path).split('\\').join('/'),
    readFileSync(path, 'utf8'),
  ]));

  const imports = [...sources]
    .filter(([, source]) => /from\s+['"](?:node:)?child_process['"]/u.test(source))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(imports, [
    'src/application/health-control.mjs', // fixed authentication protocol
    'src/application/operation-worker.mjs', // owner-death worker protocol
    'src/application/process-tree.mjs', // platform tree signalling primitive
    'src/application/service.mjs', // versioned application operation supervisor
    'src/application/status-control.mjs', // fixed tracker-decision protocol
    'src/application/ui-launch.mjs', // fixed local UI launcher and root injection
    'src/lib/root-paths.mjs', // maintainer-only repository migration utility
    'src/security/subprocess.mjs', // canonical general backend boundary
  ]);

  const processFiles = new Set(imports);
  const shellExecution = [...sources]
    .filter(([path, source]) => processFiles.has(path)
      && (/\b(?:exec|execSync)\s*\(\s*['"`]/u.test(source)
      || /shell\s*:\s*true/u.test(source))
    )
    .map(([path]) => path);
  assert.deepEqual(shellExecution, []);
});
