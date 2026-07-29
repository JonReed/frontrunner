import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applicationProgress,
  createApplicationProgressDecoder,
  normalizeApplicationProgress,
} from '../../src/application/progress.mjs';

test('progress contract is closed, bounded, and contains no free text', () => {
  assert.deepEqual(applicationProgress({
    stage: 'prefilter',
    state: 'completed',
    counts: { kept: 4, rejected: 2 },
  }), {
    version: '1',
    stage: 'prefilter',
    state: 'completed',
    counts: { kept: 4, rejected: 2 },
  });
  for (const invalid of [
    { version: '1', stage: 'cache', state: 'started', message: 'hostile text' },
    { version: '1', stage: 'unknown', state: 'started' },
    { version: '1', stage: 'cache', state: 'complete' },
    { version: '1', stage: 'cache', state: 'started', counts: { roles: 1 } },
    { version: '1', stage: 'cache', state: 'completed', counts: { roles: -1 } },
    { version: '1', stage: 'cache', state: 'completed', counts: { bad_key: 1 } },
  ]) {
    assert.throws(() => normalizeApplicationProgress(invalid));
  }
});

test('decoder handles fragmented events and disables itself after one violation', () => {
  const events = [];
  const warnings = [];
  const decoder = createApplicationProgressDecoder({
    onEvent: event => events.push(event),
    onWarning: error => warnings.push(error.message),
  });
  const valid = `${JSON.stringify(applicationProgress({
    stage: 'scan',
    state: 'completed',
    counts: { roles: 3 },
  }))}\n`;
  decoder.push(valid.slice(0, 7));
  decoder.push(valid.slice(7));
  decoder.push('{"version":"1","stage":"cache","state":"started","url":"https://evil"}\n');
  decoder.push(`${JSON.stringify(applicationProgress({
    stage: 'liveness',
    state: 'started',
  }))}\n`);
  decoder.end();

  assert.equal(events.length, 1);
  assert.equal(events[0].stage, 'scan');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unsupported progress field/u);
});

test('decoder rejects unterminated progress floods at the byte boundary', () => {
  const warnings = [];
  const decoder = createApplicationProgressDecoder({
    onWarning: error => warnings.push(error.message),
  });
  decoder.push('x'.repeat(3_000));
  decoder.push('x'.repeat(70_000));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /line exceeds/u);
});
