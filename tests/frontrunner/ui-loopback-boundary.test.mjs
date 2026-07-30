import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';

test('supported UI endpoint accepts only its two canonical loopback hosts and origins', () => {
  const source = readFileSync(join(ROOT, 'ui', 'src', 'proxy.ts'), 'utf8');
  const launcher = readFileSync(join(ROOT, 'src', 'application', 'ui-launch.mjs'), 'utf8');
  const nextConfig = readFileSync(join(ROOT, 'ui', 'next.config.mjs'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'ui', 'package.json'), 'utf8'));

  assert.match(source, /['"]127\.0\.0\.1:3100['"]/);
  assert.match(source, /['"]localhost:3100['"]/);
  assert.match(source, /['"]http:\/\/127\.0\.0\.1:3100['"]/);
  assert.match(source, /['"]http:\/\/localhost:3100['"]/);
  assert.match(source, /UI_HOSTS\.has/);
  assert.match(source, /UI_ORIGINS\.has/);
  assert.doesNotMatch(source, /::1/);
  assert.match(source, /matcher:\s*\[['"]\/:path\*['"]\]/);
  assert.match(pkg.scripts.dev, /ui-launch\.mjs dev/);
  assert.match(pkg.scripts.start, /ui-launch\.mjs start/);
  assert.match(launcher, /\['dev', '--webpack', '--hostname', '127\.0\.0\.1', '-p', '3100'\]/);
  assert.match(launcher, /\['start', '--hostname', '127\.0\.0\.1', '-p', '3100'\]/);
  assert.match(launcher, /FRONTRUNNER_ROOT:\s*ROOT/);
  assert.match(launcher, /shell:\s*false/);
  assert.match(nextConfig, /allowedOrigins:\s*\[['"]127\.0\.0\.1:3100['"],\s*['"]localhost:3100['"]\]/);
  assert.match(nextConfig, /poweredByHeader:\s*false/);
});
