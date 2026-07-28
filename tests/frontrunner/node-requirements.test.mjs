import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from '../../src/paths.mjs';

const MINIMUM = '>=22.5.0';

function json(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

test('every shipped package declares the same Node minimum', () => {
  const packages = [
    'package.json',
    'scaffolder/package.json',
    'web/package.json',
    'ui/package.json',
  ];

  for (const path of packages) {
    assert.equal(json(path).engines?.node, MINIMUM, path);
  }
});

test('doctor enforces Node 22.5 instead of treating it as optional', () => {
  const source = readFileSync(join(ROOT, 'doctor.mjs'), 'utf8');
  assert.match(source, /Node\.js >= 22\.5\.0/);
  assert.doesNotMatch(source, /major >= 18/);
  assert.doesNotMatch(source, /highly recommended/);
});
