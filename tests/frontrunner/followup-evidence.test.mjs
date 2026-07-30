import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeFromContent,
  contactLabel,
  extractContacts,
  isRealCalendarDate,
  parseAppliedDate,
  resolveAppliedDate,
} from '../../src/tracker/followup-cadence.mjs';

test('estimated application dates remain measured evidence and malformed dates do not', () => {
  assert.equal(parseAppliedDate('Applied ~2026-06-09 after reconstructing history'), '2026-06-09');
  assert.equal(parseAppliedDate('reapplied ~2026-06-09'), null);
  assert.equal(parseAppliedDate('Applied 2026-06-091'), null);
  assert.equal(isRealCalendarDate('2024-02-29'), true);
  assert.equal(isRealCalendarDate('2026-02-29'), false);
  assert.deepEqual(
    resolveAppliedDate({
      date: '2026-06-01',
      notes: 'Applied ~2026-06-09',
    }),
    { appliedDate: '2026-06-09', appDateSource: 'notes' },
  );
  assert.deepEqual(
    resolveAppliedDate({
      date: '2026-06-01',
      notes: 'Applied 2026-06-31',
    }),
    {
      appliedDate: '2026-06-01',
      appDateSource: 'evaluation-date-fallback',
    },
  );
});

test('cadence output exposes whether application age is measured or inferred', () => {
  const tracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-01 | Acme | Engineer | 4.0/5 | Applied | ❌ | ❌ | Applied ~2026-06-09 |',
    '| 2 | 2026-06-02 | Beta | Engineer | 4.0/5 | Applied | ❌ | ❌ | no apply date |',
  ].join('\n');
  const entries = analyzeFromContent(tracker).entries;
  assert.deepEqual(
    entries.map(entry => ({
      num: entry.num,
      appliedDate: entry.appliedDate,
      source: entry.appDateSource,
    })),
    [
      { num: 1, appliedDate: '2026-06-09', source: 'notes' },
      {
        num: 2,
        appliedDate: '2026-06-02',
        source: 'evaluation-date-fallback',
      },
    ],
  );
});

test('name-only outreach is preserved, channelled, Unicode-aware, and deduplicated', () => {
  const contacts = extractContacts([
    'Messaged María-José O’Neill on LinkedIn',
    'Called Łukasz Żółć',
    'Emailed Jane Doe at jane@example.com',
    'Contacted Jane Doe on LinkedIn',
  ].join('; '));
  assert.deepEqual(contacts, [
    { name: 'María-José O’Neill', email: null, channel: 'linkedin' },
    { name: 'Łukasz Żółć', email: null, channel: 'phone' },
    { name: 'Jane Doe', email: 'jane@example.com', channel: 'email' },
  ]);
  assert.equal(contactLabel(contacts[0]), 'María-José O’Neill');
  assert.equal(contactLabel(contacts[2]), 'jane@example.com');
});

test('ordinary capitalized company prose is not invented into a contact', () => {
  assert.deepEqual(extractContacts('Reviewed Acme Corp role; no outreach yet'), []);
});
