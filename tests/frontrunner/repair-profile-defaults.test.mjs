import assert from 'node:assert/strict';
import test from 'node:test';

import { repairIllustrativeProfileDefaults } from '../../src/application/repair-profile-defaults.mjs';

test('repairs only inherited example facts and derives UK fields from an entered UK location', () => {
  const result = repairIllustrativeProfileDefaults(`
candidate:
  full_name: Jon Reed
  email: jon@example.test
  phone: +1-555-0123
  location: Redhill, Surrey, UK
  linkedin: linkedin.com/in/janesmith
compensation:
  target_range: 150000
  currency: USD
  minimum: $120K
location:
  country: United States
  city: Redhill, Surrey, UK
  timezone: PST
  visa_status: No sponsorship needed
  authorized_in: [United States]
  needs_sponsorship: false
`);

  assert.match(result.content, /full_name: Jon Reed/u);
  assert.match(result.content, /target_range: 150000/u);
  assert.match(result.content, /country: United Kingdom/u);
  assert.match(result.content, /city: Redhill, Surrey/u);
  assert.match(result.content, /timezone: Europe\/London/u);
  assert.match(result.content, /currency: GBP/u);
  for (const removed of ['+1-555-0123', 'janesmith', '$120K', 'United States', 'PST', 'No sponsorship needed']) {
    assert.doesNotMatch(result.content, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('does not invent regional facts for an unrecognised location', () => {
  const result = repairIllustrativeProfileDefaults('candidate:\n  location: Remote\n');
  assert.equal(result.content, 'candidate:\n  location: Remote\n');
  assert.deepEqual(result.changed, []);
});
