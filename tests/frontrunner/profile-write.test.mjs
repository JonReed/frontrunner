/**
 * profile-write.test.mjs
 *
 * This module writes workspace/profile/cv.md and workspace/profile/profile.yml — the two files whose loss
 * costs a user the most. Every test below runs against a temporary checkout via
 * FRONTRUNNER_PROFILE_BASE; none of them may touch the real one.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  updateProfile,
  readProfileFields,
  writeCv,
  writeCvVersion,
  validateProfilePatch,
  profilePath,
  cvPath,
  cvVersionsDir,
  appendCvVersion,
  listCvVersions,
} from '../../src/application/profile-write.mjs';

const REAL_TEMPLATE = fileURLToPath(new URL('../../config/profile.example.yml', import.meta.url));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'profile-write-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'workspace', 'profile'), { recursive: true });
  writeFileSync(join(dir, 'config', 'profile.example.yml'), readFileSync(REAL_TEMPLATE, 'utf8'));
  process.env.FRONTRUNNER_PROFILE_BASE = dir;
  return dir;
}

function cleanup(dir) {
  delete process.env.FRONTRUNNER_PROFILE_BASE;
  rmSync(dir, { recursive: true, force: true });
}

test('creates a safe profile without inheriting illustrative personal data', async () => {
  const dir = sandbox();
  try {
    await updateProfile({ 'candidate.full_name': 'Grizelda Thorncastle' });

    const written = readFileSync(profilePath(), 'utf8');
    assert.match(written, /add only facts that are true for you/);
    for (const inheritedFact of [
      'Jane Smith', 'jane@example.com', '+1-555-0123', 'San Francisco',
      'United States', 'USD', '$150K-200K', '$120K', 'No sponsorship needed',
    ]) {
      assert.doesNotMatch(written, new RegExp(inheritedFact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    // Asserted through the parser, not a regex on the raw text: `yaml` keeps
    // the template's existing quote style, so the written line is
    // `full_name: "Grizelda Thorncastle"` — matching on formatting would make
    // this test fail for a reason that does not matter.
    assert.equal(readProfileFields()['candidate.full_name'], 'Grizelda Thorncastle');
  } finally {
    cleanup(dir);
  }
});

test('an edit preserves comments, unknown keys and untouched values', async () => {
  const dir = sandbox();
  try {
    writeFileSync(
      profilePath(),
      [
        '# leading comment',
        'candidate:',
        '  full_name: "Old Name"   # trailing comment',
        '  email: "old@example.com"',
        'a_key_the_ui_knows_nothing_about:',
        '  nested: true',
        'spend_tier: standard',
        '',
      ].join('\n'),
    );

    await updateProfile({ 'candidate.full_name': 'New Name' });
    const out = readFileSync(profilePath(), 'utf8');

    assert.match(out, /# leading comment/, 'comments must survive an edit');
    assert.match(out, /# trailing comment/, 'inline comments must survive an edit');
    assert.match(out, /a_key_the_ui_knows_nothing_about/, 'unknown keys must never be dropped');
    assert.match(out, /old@example\.com/, 'untouched fields must be left alone');
    assert.match(out, /New Name/);
    assert.doesNotMatch(out, /Old Name/);
  } finally {
    cleanup(dir);
  }
});

test('rejects any field outside the allowlist rather than ignoring it', async () => {
  const dir = sandbox();
  try {
    for (const patch of [
      { 'candidate.__proto__': 'x' },
      { 'spend_tier.evil': 'x' },
      { 'scoring.weights': 'x' },
      { 'candidate.photo': '/etc/passwd' },
    ]) {
      await assert.rejects(() => updateProfile(patch), /not a writable profile field/);
    }
    assert.equal(existsSync(profilePath()), false, 'a rejected write must not create the file');
  } finally {
    cleanup(dir);
  }
});

test('rejects the whole patch when any field is invalid', async () => {
  const dir = sandbox();
  try {
    await updateProfile({ 'candidate.full_name': 'Grizelda Thorncastle' });
    // A value that cannot appear in the shipped template, so a match proves the
    // write happened rather than matching the template's own example data.
    await assert.rejects(
      () => updateProfile({ 'candidate.email': 'nobody@frontrunner.invalid', 'spend_tier': 'lavish' }),
      /must be one of/,
    );
    assert.doesNotMatch(
      readFileSync(profilePath(), 'utf8'),
      /nobody@frontrunner\.invalid/,
      'no field may be applied when another in the same patch fails',
    );
  } finally {
    cleanup(dir);
  }
});

test('validates types and bounds', () => {
  assert.throws(() => validateProfilePatch(null), /must be an object/);
  assert.throws(() => validateProfilePatch({}), /must change something/);
  assert.throws(() => validateProfilePatch({ 'candidate.full_name': 42 }), /must be text/);
  assert.throws(() => validateProfilePatch({ 'target_roles.primary': 'not a list' }), /must be a list/);
  assert.throws(() => validateProfilePatch({ 'candidate.full_name': 'x'.repeat(501) }), /too long/);
  assert.throws(
    () => validateProfilePatch({ 'target_roles.primary': Array(41).fill('role') }),
    /too many/,
  );
});

test('an empty value clears the field instead of writing an empty string', async () => {
  const dir = sandbox();
  try {
    await updateProfile({ 'candidate.phone': '+44 7700 900000' });
    assert.match(readFileSync(profilePath(), 'utf8'), /900000/);

    await updateProfile({ 'candidate.phone': '' });
    assert.equal(readProfileFields()['candidate.phone'], undefined);
  } finally {
    cleanup(dir);
  }
});

test('refuses to touch a profile it cannot parse', async () => {
  const dir = sandbox();
  try {
    const broken = 'candidate:\n  full_name: "unterminated\n   : : :\n';
    writeFileSync(profilePath(), broken);
    await assert.rejects(() => updateProfile({ 'candidate.full_name': 'Jane' }), /could not be parsed/);
    assert.equal(readFileSync(profilePath(), 'utf8'), broken, 'the damaged file must be left as-is');
  } finally {
    cleanup(dir);
  }
});

test('round-trips lists', async () => {
  const dir = sandbox();
  try {
    await updateProfile({ 'target_roles.primary': ['Head of Operations', 'Operations Director'] });
    assert.deepEqual(readProfileFields()['target_roles.primary'], [
      'Head of Operations',
      'Operations Director',
    ]);
  } finally {
    cleanup(dir);
  }
});

test('writes workspace/profile/cv.md and rejects empty or oversized input', async () => {
  const dir = sandbox();
  try {
    await writeCv('# Jane Smith\n\nOperations Director.');
    assert.match(readFileSync(cvPath(), 'utf8'), /Operations Director/);

    await assert.rejects(() => writeCv('   '), /is empty/);
    await assert.rejects(() => writeCv(42), /must be text/);
    await assert.rejects(() => writeCv('x'.repeat(512 * 1024 + 1)), /too large/);

    assert.match(readFileSync(cvPath(), 'utf8'), /Operations Director/, 'a rejected write must not clobber');
  } finally {
    cleanup(dir);
  }
});

test('CV version labels cannot escape the directory', async () => {
  const dir = sandbox();
  try {
    await writeCvVersion('../../etc/passwd', 'content', 0);
    await writeCvVersion('the ops one', 'content', 1);
    await writeCvVersion('', 'content', 2);

    const files = readdirSync(cvVersionsDir()).sort();
    assert.deepEqual(files, ['01-etc-passwd.md', '02-the-ops-one.md', '03-version.md']);
    assert.equal(existsSync(join(dir, '..', 'passwd')), false);
  } finally {
    cleanup(dir);
  }
});

test('concurrent writes do not lose an update', async () => {
  const dir = sandbox();
  try {
    await Promise.all([
      updateProfile({ 'candidate.full_name': 'Jane Smith' }),
      updateProfile({ 'candidate.email': 'jane@example.com' }),
      updateProfile({ 'location.city': 'Manchester' }),
    ]);
    const fields = readProfileFields();
    assert.equal(fields['candidate.full_name'], 'Jane Smith');
    assert.equal(fields['candidate.email'], 'jane@example.com');
    assert.equal(fields['location.city'], 'Manchester');
  } finally {
    cleanup(dir);
  }
});

test('additional CV versions append into unique slots under contention', async () => {
  const dir = sandbox();
  try {
    const first = await appendCvVersion('operations roles', '# Operations CV\nMore detail here.');
    assert.equal(first.name, '01-operations-roles.md');

    const added = await Promise.all([
      appendCvVersion('product roles', '# Product CV\nMore detail here.'),
      appendCvVersion('programme roles', '# Programme CV\nMore detail here.'),
    ]);
    assert.deepEqual(new Set(added.map(version => version.name)), new Set([
      '02-product-roles.md',
      '03-programme-roles.md',
    ]));
    assert.deepEqual(listCvVersions().map(version => version.name), [
      '01-operations-roles.md',
      '02-product-roles.md',
      '03-programme-roles.md',
    ]);
  } finally {
    cleanup(dir);
  }
});
