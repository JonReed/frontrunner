import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensurePortalsFile,
  portalsPath,
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
