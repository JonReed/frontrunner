import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  pruneRetiredSkillEntrypoints,
  RETIRED_SKILL_ENTRYPOINTS,
} from '../../src/lib/skill-entrypoints.mjs';

function put(root, relativePath) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, 'legacy entrypoint\n');
}

test('retired skill migration removes tracked system paths only', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'frontrunner-skill-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const path of RETIRED_SKILL_ENTRYPOINTS) put(root, path);
  const tracked = RETIRED_SKILL_ENTRYPOINTS.slice(0, 2);

  assert.deepEqual(pruneRetiredSkillEntrypoints(root, tracked), tracked);
  for (const path of tracked) assert.equal(existsSync(join(root, path)), false);
  assert.equal(
    existsSync(join(root, RETIRED_SKILL_ENTRYPOINTS[2])),
    true,
    'an untracked user skill was removed',
  );
});
