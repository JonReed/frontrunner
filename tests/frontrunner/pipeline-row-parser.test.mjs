import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePipelineMetadata } from '../../src/scan/pipeline-row.mjs';

test('labeled metadata is never treated as a missing location', () => {
  assert.deepEqual(
    parsePipelineMetadata(' | Acme | Platform Engineer | posted: 2026-07-30 | trust: 82 verified | note: referral'),
    {
      company: 'Acme',
      role: 'Platform Engineer',
      location: '',
      compensation: '',
      posted: '2026-07-30',
    },
  );
});

test('empty positional cells and compensation retain their meaning', () => {
  assert.deepEqual(
    parsePipelineMetadata(' | Acme | Platform Engineer |  | £90k–£110k | trust: 70 | posted: 2026-07-29'),
    {
      company: 'Acme',
      role: 'Platform Engineer',
      location: '',
      compensation: '£90k–£110k',
      posted: '2026-07-29',
    },
  );
});

test('location text containing a colon is not mistaken for scanner metadata', () => {
  assert.deepEqual(
    parsePipelineMetadata(' | Acme | Platform Engineer | Remote: UK | note: distributed team'),
    {
      company: 'Acme',
      role: 'Platform Engineer',
      location: 'Remote: UK',
      compensation: '',
      posted: null,
    },
  );
});

test('invalid posting dates are ignored', () => {
  assert.equal(
    parsePipelineMetadata(' | Acme | Platform Engineer | posted: yesterday').posted,
    null,
  );
});
