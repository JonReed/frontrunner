import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  MAX_PROFILE_REQUEST_BYTES,
} from '../../src/application/profile-control.mjs';
import {
  resolveUiLaunch,
} from '../../src/application/ui-launch.mjs';

test('UI root and process authority come only from the fixed application launcher', () => {
  const roles = readFileSync(join(ROOT, 'ui', 'src', 'lib', 'roles.ts'), 'utf8');
  const root = readFileSync(join(ROOT, 'ui', 'src', 'lib', 'root.ts'), 'utf8');
  const spec = resolveUiLaunch('dev');

  assert.doesNotMatch(roles, /process\.cwd\(\)/);
  assert.match(root, /process\.env\.FRONTRUNNER_ROOT/);
  assert.match(root, /isAbsolute\(configured\)/);
  assert.equal(spec.command, process.execPath);
  assert.equal(spec.cwd, join(ROOT, 'ui'));
  assert.equal(spec.env.FRONTRUNNER_ROOT, ROOT);
  assert.deepEqual(spec.args.slice(-5), ['dev', '--hostname', '127.0.0.1', '-p', '3100']);
  assert.throws(() => resolveUiLaunch('--hostname'), /must be one of/);
  assert.throws(() => resolveUiLaunch('anything-else'), /must be one of/);
});

test('UI artifact reads use a role identity, never a browser-supplied filesystem path', () => {
  const route = readFileSync(
    join(ROOT, 'ui', 'src', 'app', 'api', 'file', 'route.ts'),
    'utf8',
  );
  const links = [
    readFileSync(join(ROOT, 'ui', 'src', 'components', 'cv-links.tsx'), 'utf8'),
    readFileSync(join(ROOT, 'ui', 'src', 'components', 'build-cv.tsx'), 'utf8'),
  ].join('\n');

  assert.doesNotMatch(route, /searchParams\.get\(['"]path['"]\)/);
  assert.match(route, /params\.get\(['"]role['"]\)/);
  assert.match(route, /params\.get\(['"]format['"]\)/);
  assert.match(route, /await readTracker\(\)/);
  assert.match(route, /realpathSync\(abs\)/);
  assert.doesNotMatch(links, /api\/file\?path=/);
  assert.match(links, /api\/file\?role=/);
});

test('large supported CVs cross an operation-specific cap while generic requests stay small', () => {
  const control = readFileSync(
    join(ROOT, 'src', 'application', 'profile-control.mjs'),
    'utf8',
  );
  const nextConfig = readFileSync(join(ROOT, 'ui', 'next.config.mjs'), 'utf8');

  assert.equal(MAX_PROFILE_REQUEST_BYTES, 1536 * 1024);
  assert.match(control, /readBoundedRequest\(input,\s*\{\s*maxBytes:\s*MAX_PROFILE_REQUEST_BYTES/s);
  assert.match(nextConfig, /experimental:\s*\{\s*serverActions:\s*\{\s*bodySizeLimit:\s*['"]1536kb['"]/s);
});
