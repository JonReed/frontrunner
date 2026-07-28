import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ROOT } from '#paths';

test('aggregate runner supervises node:test suites instead of exiting over their results', () => {
  const source = readFileSync(`${ROOT}/test-all.mjs`, 'utf8');
  assert.match(source, /nodeTestFiles\.push\(f\)/);
  assert.match(source, /spawnSync\(NODE, \['--test', \.\.\.nodeTestFiles\]/);
  assert.match(source, /result\.status === 0/);
  assert.match(source, /fail\(`\$\{nodeTestFiles\.length\} node:test suites failed`\)/);
});
