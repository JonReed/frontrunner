import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROFILE_DETAIL_FIELDS,
  cvReplacementReadiness,
} from '../../ui/src/lib/profile-maintenance.mjs';

test('profile maintenance exposes the preferences used to judge a role', () => {
  const paths = new Set(PROFILE_DETAIL_FIELDS.map((field) => field.path));

  for (const path of [
    'compensation.location_flexibility',
    'compensation.currency',
    'location.city',
    'location.country',
    'location.timezone',
    'location.visa_status',
  ]) {
    assert.equal(paths.has(path), true, `${path} should be editable`);
  }
});

test('CV replacement rejects empty and suspiciously short drafts', () => {
  assert.deepEqual(
    cvReplacementReadiness(''),
    { ready: false, words: 0, reason: 'Paste your CV or choose a file first.' },
  );

  const short = cvReplacementReadiness('Product leader at Acme.');
  assert.equal(short.ready, false);
  assert.match(short.reason, /too short/iu);
});

test('CV replacement accepts a substantial pasted CV', () => {
  const result = cvReplacementReadiness(`
    # Jane Smith
    Product leader with fifteen years of experience building useful software.
    Led discovery, delivery and operations for a cross-functional platform team.
    Worked with customers, engineers and commercial teams from strategy through launch.
  `);

  assert.equal(result.ready, true);
  assert.equal(result.reason, '');
  assert.ok(result.words > 20);
});
