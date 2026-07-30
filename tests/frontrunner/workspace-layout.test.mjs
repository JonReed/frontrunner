import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';

import {
  APPLICATIONS_FILE,
  CV_FILE,
  JDS_DIR,
  OUTPUT_DIR,
  PIPELINE_FILE,
  PROFILE_FILE,
  REPORTS_DIR,
  ROOT,
  STATE_DIR,
  WORKSPACE_DIR,
} from '#paths';
import {
  applyLegacyArchive,
  planLegacyArchive,
} from '../../src/workspace/archive-legacy.mjs';

test('every canonical private path is owned by the one workspace boundary', () => {
  for (const file of [
    APPLICATIONS_FILE,
    CV_FILE,
    JDS_DIR,
    OUTPUT_DIR,
    PIPELINE_FILE,
    PROFILE_FILE,
    REPORTS_DIR,
    STATE_DIR,
  ]) {
    const local = relative(WORKSPACE_DIR, file);
    assert.equal(
      local === ''
        || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)),
      true,
      file,
    );
  }
});

test('legacy archive previews without mutation and apply leaves active onboarding empty', t => {
  const root = mkdtempSync(join(tmpdir(), 'frontrunner-legacy-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'src', 'paths.mjs'), '// fixture\n');
  writeFileSync(join(root, 'cv.md'), '# Existing CV\n');
  writeFileSync(join(root, 'config', 'profile.yml'), 'candidate: {}\n');
  writeFileSync(join(root, 'data', 'applications.md'), '# Existing tracker\n');

  const preview = planLegacyArchive({ root, id: 'fixture' });
  assert.deepEqual(preview.entries.map(entry => entry.source), [
    'cv.md',
    'config/profile.yml',
    'data',
  ]);
  assert.equal(existsSync(join(root, 'cv.md')), true);
  assert.equal(existsSync(preview.backupRoot), false);

  const result = applyLegacyArchive({ root, id: 'fixture' });
  assert.deepEqual(result.moved, ['cv.md', 'config/profile.yml', 'data']);
  assert.equal(existsSync(join(root, 'cv.md')), false);
  assert.equal(existsSync(join(root, 'workspace', 'profile', 'cv.md')), false);
  assert.equal(
    readFileSync(join(result.backupRoot, 'cv.md'), 'utf8'),
    '# Existing CV\n',
  );
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.entries.every(entry => entry.moved), true);
});

test('the repository ships no tracked private-workspace scaffolds', () => {
  assert.equal(existsSync(join(ROOT, 'workspace', '.gitkeep')), false);
});
