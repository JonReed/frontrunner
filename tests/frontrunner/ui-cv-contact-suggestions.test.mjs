import assert from 'node:assert/strict';
import test from 'node:test';

import { suggestCvContact } from '../../ui/src/lib/cv-contact-suggestions.mjs';

test('onboarding extracts exact contact details from a common CV header', () => {
  const cv = `
# Jane O'Brien
Manchester, UK | jane.obrien@example.com | +44 7700 900123

## Professional Experience
`;

  assert.deepEqual(suggestCvContact(cv), {
    name: "Jane O'Brien",
    email: 'jane.obrien@example.com',
    location: 'Manchester, UK',
  });
});

test('onboarding supports labelled locations and a title beside the candidate name', () => {
  const cv = `
# Jane Smith — Product Director
Location: Leeds, United Kingdom
jane@example.com
`;

  assert.deepEqual(suggestCvContact(cv), {
    name: 'Jane Smith',
    email: 'jane@example.com',
    location: 'Leeds, United Kingdom',
  });
});

test('contact extraction leaves uncertain values empty instead of inventing them', () => {
  const cv = `
CURRICULUM VITAE
Product Director
Building products and leading teams across international markets.












Reference: recruiter@example.com
`;

  assert.deepEqual(suggestCvContact(cv), {
    name: null,
    email: null,
    location: null,
  });
  assert.deepEqual(suggestCvContact(''), {
    name: null,
    email: null,
    location: null,
  });
});
