import assert from 'node:assert/strict';
import test from 'node:test';

import { suggestJobTitles } from '../../ui/src/lib/job-title-suggestions.mjs';

test('onboarding suggests explicit job titles from common CV experience layouts', () => {
  const cv = `
# Jane Smith

## Professional Experience

### Acme Ltd — Head of Operations
January 2021 — Present

**Operations Manager** | Example Group | 2018–2021

### Senior Programme Manager
Another Company

## Education
### University of Somewhere
`;

  assert.deepEqual(suggestJobTitles(cv), [
    'Head of Operations',
    'Operations Manager',
    'Senior Programme Manager',
  ]);
});

test('title suggestions do not turn skills, dates, contact details or later sections into roles', () => {
  const cv = `
# Jane Smith — Product Director
jane@example.com

## Summary
Engineering leadership and programme delivery.

## Experience
### Product Director | Acme Ltd | 2022 — Present
- Managed engineers and designers.
- Project management and engineering leadership
- Leadership, strategy, architecture and operations

## Skills
Engineering Manager
`;

  assert.deepEqual(suggestJobTitles(cv), ['Product Director']);
});

test('title suggestions support plain-text CVs without styled markdown headings', () => {
  const cv = `
JANE SMITH

EXPERIENCE
Example Group
Operations Director
2020 - Present

Acme Ltd
Senior Product Manager
2016 - 2020

EDUCATION
University of Somewhere
`;

  assert.deepEqual(suggestJobTitles(cv), ['Operations Director', 'Senior Product Manager']);
});

test('title suggestions are bounded, deduplicated and work for compact heading-only CVs', () => {
  const cv = `
# Principal Engineer
## Principal Engineer
## Engineering Manager
## engineering manager
## Product Director
`;

  assert.deepEqual(suggestJobTitles(cv, 2), ['Principal Engineer', 'Engineering Manager']);
  assert.deepEqual(suggestJobTitles(cv, 0), []);
  assert.deepEqual(suggestJobTitles(''), []);
});
