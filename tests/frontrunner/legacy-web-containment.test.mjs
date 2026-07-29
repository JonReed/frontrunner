import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { ROOT } from '#paths';

const WEB = join(ROOT, 'web');

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('legacy web package cannot start a runtime server', () => {
  const packageJson = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'));
  for (const script of ['dev', 'start']) {
    assert.equal(packageJson.scripts[script], 'node legacy-disabled.mjs');
  }

  const result = spawnSync(process.execPath, [join(WEB, 'legacy-disabled.mjs')], {
    cwd: WEB,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archived and cannot be started/u);
  assert.match(result.stderr, /npm -C ui run dev/u);
});

test('direct Next invocation still meets an unconditional fail-closed proxy', () => {
  const proxy = readFileSync(join(WEB, 'src', 'proxy.ts'), 'utf8');
  assert.match(proxy, /status:\s*410/u);
  assert.match(proxy, /matcher:\s*['"]\/:path\*['"]/u);
  assert.match(proxy, /default-src 'none'/u);
  assert.doesNotMatch(proxy, /process\.env|NextResponse\.next|request\.nextUrl/u);
});

test('legacy privileged surfaces remain inventoried behind the archive boundary', () => {
  const privileged = filesUnder(join(WEB, 'src'))
    .filter(file => /\.(?:ts|tsx|js|mjs)$/u.test(file))
    .filter(file => /node:child_process|playwright/u.test(readFileSync(file, 'utf8')));

  assert.ok(privileged.length >= 10, 'test must fail if it silently stops auditing the legacy surface');
  assert.ok(privileged.some(file => file.endsWith(join('api', 'run', 'route.ts'))));
  assert.ok(privileged.some(file => file.endsWith(join('lib', 'apply', 'drive.ts'))));
  assert.ok(privileged.some(file => file.endsWith(join('api', 'assistant', 'route.ts'))));
});
