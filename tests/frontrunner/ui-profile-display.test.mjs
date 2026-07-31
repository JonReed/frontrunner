import assert from 'node:assert/strict';
import test from 'node:test';

import { locationDefaults } from '../../ui/src/lib/location-defaults.mjs';
import { scalar } from '../../ui/src/lib/profile-yaml.mjs';

test('profile display removes YAML comments rather than treating them as profile data', () => {
  const profile = 'compensation:\n  target_range: "150000" # Your target total comp\n';
  assert.equal(scalar(profile, ['compensation', 'target_range']), '150000');
});

test('UK onboarding defaults are deterministic and do not invent a US location', () => {
  assert.deepEqual(locationDefaults('Redhill, Surrey, UK'), {
    city: 'Redhill, Surrey',
    country: 'United Kingdom',
    timezone: 'Europe/London',
    currency: 'GBP',
  });
});

test('unknown locations retain the entered location without fabricated regional data', () => {
  assert.deepEqual(locationDefaults('Remote'), {
    city: 'Remote', country: '', timezone: '', currency: '',
  });
});
