import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HARNESS = fileURLToPath(
  new URL('../fixtures/operation-worker-harness.mjs', import.meta.url),
);

test('operation worker exits normally without requiring its owner pipe to close', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-owner-normal-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const backend = join(fixture, 'backend.mjs');
  writeFileSync(backend, 'process.stdout.write("backend-complete\\\\n");\n');
  const worker = spawn(process.execPath, [HARNESS, backend], {
    cwd: fixture,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (worker.exitCode === null) worker.kill('SIGKILL');
  });
  worker.stdin.write(`${JSON.stringify({
    version: '1',
    operation: 'test.owner-death',
    input: {},
  })}\n`);

  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    worker.stdout.on('data', chunk => { stdout += String(chunk); });
    worker.stderr.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => reject(new Error('worker retained its owner pipe')), 2_000);
    worker.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    worker.once('error', reject);
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /backend-complete/u);
});

test('destructive owner-pipe loss kills a backend descendant before it mutates state', {
  skip: process.platform === 'win32',
}, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'frontrunner-owner-death-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const backend = join(fixture, 'backend.mjs');
  const marker = join(fixture, 'orphan-mutated-state');
  const descendant = `
    process.on('SIGTERM', () => {});
    process.stdout.write('descendant-ready\\\\n');
    setTimeout(
      () => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'),
      250,
    );
    setInterval(() => {}, 1_000);
  `;
  writeFileSync(backend, `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.once('data', chunk => process.stdout.write(chunk));
    setInterval(() => {}, 1_000);
  `);

  const worker = spawn(process.execPath, [HARNESS, backend], {
    cwd: fixture,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (worker.exitCode === null) worker.kill('SIGKILL');
  });
  let stderr = '';
  worker.stderr.on('data', chunk => { stderr += String(chunk); });
  worker.stdin.write(`${JSON.stringify({
    version: '1',
    operation: 'test.owner-death',
    input: {},
  })}\n`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`backend never became ready: ${stderr}`)),
      3_000,
    );
    worker.stdout.on('data', (chunk) => {
      if (!String(chunk).includes('descendant-ready')) return;
      clearTimeout(timer);
      resolve();
    });
    worker.once('error', reject);
  });

  worker.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`owner worker did not stop: ${stderr}`)),
      3_000,
    );
    worker.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.notEqual(exitCode, 0);

  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(
    existsSync(marker),
    false,
    'backend descendant survived owner death and mutated state',
  );
});
