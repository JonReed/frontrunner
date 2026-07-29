import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAppliedDate,
  parseStatusDate,
} from '../../src/tracker/followup-cadence.mjs';

test('follow-up cadence uses the latest observed reply or interview date', () => {
  const notes = [
    'Applied 2026-07-01 — recorded in Frontrunner',
    'Responded 2026-07-08 — recorded in Frontrunner',
    'Interview 2026-07-14 — recorded in Frontrunner',
    'Interview 2026-07-21 — second round',
  ].join('; ');

  assert.equal(parseAppliedDate(notes), '2026-07-01');
  assert.equal(parseStatusDate(notes, 'responded'), '2026-07-08');
  assert.equal(parseStatusDate(notes, 'interview'), '2026-07-21');
});

test('legacy tracker notes without observed event dates retain the applied fallback', () => {
  assert.equal(parseStatusDate('Employer replied by email', 'responded'), null);
  assert.equal(parseStatusDate('Interview arranged', 'interview'), null);
  assert.equal(parseStatusDate('Responded 2026-07-08', 'applied'), null);
});
