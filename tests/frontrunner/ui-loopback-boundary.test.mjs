import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';

test('supported UI endpoint accepts only its two canonical loopback hosts and origins', () => {
  const source = readFileSync(join(ROOT, 'ui', 'src', 'proxy.ts'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'ui', 'package.json'), 'utf8'));

  assert.match(source, /['"]127\.0\.0\.1:3100['"]/);
  assert.match(source, /['"]localhost:3100['"]/);
  assert.match(source, /['"]http:\/\/127\.0\.0\.1:3100['"]/);
  assert.match(source, /['"]http:\/\/localhost:3100['"]/);
  assert.match(source, /UI_HOSTS\.has/);
  assert.match(source, /UI_ORIGINS\.has/);
  assert.doesNotMatch(source, /::1/);
  assert.match(source, /matcher:\s*\[['"]\/:path\*['"]\]/);
  assert.match(pkg.scripts.dev, /--hostname 127\.0\.0\.1 -p 3100/);
  assert.match(pkg.scripts.start, /--hostname 127\.0\.0\.1 -p 3100/);
});
