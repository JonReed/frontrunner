import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as yaml from 'js-yaml';

import { completeOnboarding } from '../../src/application/onboarding-completion.mjs';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'frontrunner-complete-onboarding-'));
  mkdirSync(join(base, 'templates'), { recursive: true });
  mkdirSync(join(base, 'modes'), { recursive: true });
  writeFileSync(join(base, 'templates', 'portals.example.yml'), `title_filter:
  positive: [AI Engineer]
  negative: [Java]
location_filter:
  always_allow: [United States]
  allow: []
  block: [Europe]
tracked_companies: []
`);
  writeFileSync(join(base, 'modes', '_custom.template.md'), '# Preferences\n');
  return base;
}

const save = {
  cv: '# Jane Example\n\n## Experience\n\nLed important programmes.\n',
  versions: [{ label: 'Programme', text: '# Programme CV\n\nAlternative wording.\n' }],
  fields: {
    'candidate.full_name': 'Jane Example',
    'candidate.email': 'jane@example.test',
    'candidate.location': 'Redhill, Surrey, UK',
    'target_roles.primary': ['Programme Director'],
    'location.city': 'Redhill',
    'location.country': 'United Kingdom',
    'location.timezone': 'Europe/London',
    'location.authorized_in': ['United Kingdom'],
    'location.needs_sponsorship': false,
    'compensation.currency': 'GBP',
    'compensation.location_flexibility': 'Hybrid',
    spend_tier: 'standard',
  },
  targeting: { dealBreakers: 'No compulsory relocation' },
};

test('a virgin install becomes scanner, evaluator and tracker ready', async () => {
  const base = fixture();
  try {
    const result = await completeOnboarding(save, { base });
    assert.equal(result.completed, true);
    for (const path of [
      'workspace/profile/cv.md',
      'workspace/profile/profile.yml',
      'workspace/profile/targeting.md',
      'workspace/profile/preferences.md',
      'workspace/search/portals.yml',
      'workspace/applications/tracker.md',
    ]) assert.equal(existsSync(join(base, path)), true, path);

    const profile = yaml.load(readFileSync(join(base, 'workspace/profile/profile.yml'), 'utf8'));
    assert.deepEqual(profile.location.authorized_in, ['United Kingdom']);
    assert.equal(profile.location.needs_sponsorship, false);
    const portals = yaml.load(readFileSync(join(base, 'workspace/search/portals.yml'), 'utf8'));
    assert.deepEqual(portals.title_filter.positive, ['Programme Director']);
    assert.deepEqual(portals.title_filter.negative, []);
    assert.deepEqual(portals.location_filter.always_allow, ['Redhill', 'United Kingdom']);
    assert.match(readFileSync(join(base, 'workspace/applications/tracker.md'), 'utf8'), /\| # \| Date \| Company/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('completion recovers after interruption at every stage without replacing custom files', async () => {
  for (const stage of ['profile', 'targeting', 'preferences', 'portals']) {
    const base = fixture();
    try {
      await assert.rejects(
        completeOnboarding(save, {
          base,
          afterStage(current) {
            if (current === stage) throw new Error(`injected ${stage} interruption`);
          },
        }),
        new RegExp(`injected ${stage}`),
      );
      if (existsSync(join(base, 'workspace/profile/targeting.md'))) {
        writeFileSync(join(base, 'workspace/profile/targeting.md'), '# My edited search brief\n');
      }
      await completeOnboarding(save, { base });
      assert.equal(existsSync(join(base, 'workspace/applications/tracker.md')), true);
      if (stage !== 'profile') {
        assert.equal(readFileSync(join(base, 'workspace/profile/targeting.md'), 'utf8'), '# My edited search brief\n');
      }
      assert.equal(
        readFileSync(join(base, 'workspace/profile/cv-versions/01-programme.md'), 'utf8'),
        '# Programme CV\n\nAlternative wording.\n',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});
