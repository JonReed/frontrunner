import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensurePortalsFile,
  portalsPath,
  renderPortalsTemplate,
  renderTargeting,
} from '../../src/application/onboarding-files.mjs';

test('onboarding provisions portals once and never overwrites a user edit', async () => {
  const base = mkdtempSync(join(tmpdir(), 'frontrunner-onboarding-files-'));
  try {
    mkdirSync(join(base, 'templates'), { recursive: true });
    writeFileSync(join(base, 'templates', 'portals.example.yml'), '# default sources\ntracked_companies: []\n');

    assert.deepEqual(await ensurePortalsFile({ base }), {
      created: true,
      path: portalsPath(base),
    });
    assert.equal(readFileSync(portalsPath(base), 'utf8'), '# default sources\ntracked_companies: []\n');

    writeFileSync(portalsPath(base), '# my sources\ntracked_companies: []\n');
    assert.deepEqual(await ensurePortalsFile({ base }), {
      created: false,
      path: portalsPath(base),
    });
    assert.equal(readFileSync(portalsPath(base), 'utf8'), '# my sources\ntracked_companies: []\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('onboarding derives scanner filters from confirmed roles and location', () => {
  const rendered = renderPortalsTemplate(`title_filter:
  positive: [AI Engineer]
  negative: [Java]
location_filter:
  always_allow: [United States]
  allow: [Remote]
  block: [Europe]
tracked_companies: []
`, {
    roles: ['Operations Director', 'Head of Operations'],
    city: 'Redhill',
    country: 'United Kingdom',
    workingPattern: 'Hybrid',
  });
  assert.match(rendered, /Operations Director/u);
  assert.match(rendered, /Head of Operations/u);
  assert.match(rendered, /Redhill/u);
  assert.match(rendered, /United Kingdom/u);
  assert.match(rendered, /Remote/u);
  assert.doesNotMatch(rendered, /AI Engineer|Java|United States/u);
  assert.match(rendered, /seniority_boost: \[\]/u);
  assert.match(rendered, /search_queries: \[\]/u);
});

test('onboarding creates a neutral search brief rather than inherited candidate facts', () => {
  const rendered = renderTargeting({
    roles: ['Programme Director'],
    superpower: 'Making complex delivery understandable',
  });
  assert.match(rendered, /Programme Director/u);
  assert.match(rendered, /Making complex delivery understandable/u);
  assert.doesNotMatch(rendered, /AI Engineer|LLMOps|example candidate/u);
});
