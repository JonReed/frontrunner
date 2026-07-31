import assert from 'node:assert/strict';
import test from 'node:test';

import {
  onboardingCompleteness,
  profileCompleteness,
} from '../../ui/src/lib/profile-completeness.mjs';

test('profile completeness distinguishes required, recommended and optional gaps', () => {
  const result = profileCompleteness({
    hasCv: true,
    fields: {
      'candidate.full_name': 'Alex Example',
      'candidate.email': 'alex@example.test',
      'candidate.location': 'Redhill, UK',
      'target_roles.primary': ['Product Director'],
      'compensation.target_range': '£120,000',
      'compensation.currency': 'GBP',
    },
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.requiredMissing, []);
  assert.deepEqual(
    result.recommendedMissing.map((field) => field.id),
    ['working_pattern', 'search_country', 'timezone', 'spend_tier'],
  );
  assert.equal(result.optionalMissing.some((field) => field.id === 'minimum'), true);
});

test('a profile file cannot hide missing core onboarding facts', () => {
  const result = onboardingCompleteness({
    cv: '# Alex Example\nExperience',
    fullName: 'Alex Example',
    email: '',
    location: 'Redhill, UK',
    targetRoles: '',
  });

  assert.equal(result.ready, false);
  assert.deepEqual(
    result.requiredMissing.map((field) => field.id),
    ['email', 'target_roles'],
  );
});
