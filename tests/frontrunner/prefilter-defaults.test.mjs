import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

test('shipped prefilter does not assume the candidate target level', () => {
  const config = yaml.load(readFileSync(
    new URL('../../config/prefilter.example.yml', import.meta.url),
    'utf8',
  ));

  assert.deepEqual(config.below_level, []);
});
