import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  profileSaveJournalPath,
  publishProfileSave,
  recoverProfileSave,
} from '../../src/application/profile-transaction.mjs';

const REAL_TEMPLATE = fileURLToPath(new URL('../../config/profile.example.yml', import.meta.url));
const WORKER = fileURLToPath(
  new URL('../fixtures/profile-transaction-worker.mjs', import.meta.url),
);
const PROFILE_CONTROL = fileURLToPath(
  new URL('../../src/application/profile-control.mjs', import.meta.url),
);

function runWorker(base, save, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      WORKER,
      base,
      JSON.stringify(save),
      mode,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
}

function runControl(base, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROFILE_CONTROL], {
      env: { ...process.env, FRONTRUNNER_PROFILE_BASE: base },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(request));
  });
}

function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'frontrunner-profile-transaction-'));
  mkdirSync(join(base, 'config'), { recursive: true });
  mkdirSync(join(base, 'workspace', 'profile'), { recursive: true });
  mkdirSync(join(base, 'workspace', '.state'), { recursive: true });
  writeFileSync(
    join(base, 'config', 'profile.example.yml'),
    readFileSync(REAL_TEMPLATE, 'utf8'),
  );
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test('whole-save preflight prevents a late invalid value from partially replacing the CV', async (t) => {
  const base = sandbox(t);
  const cv = join(base, 'workspace/profile/cv.md');
  const profile = join(base, 'workspace', 'profile', 'profile.yml');
  writeFileSync(cv, '# Original CV\n');
  writeFileSync(profile, 'spend_tier: standard\n');

  await assert.rejects(
    publishProfileSave({
      cv: '# Replacement CV',
      versions: [{ label: 'broken', text: '   ' }],
      fields: { spend_tier: 'lavish' },
    }, { base }),
  );

  assert.equal(readFileSync(cv, 'utf8'), '# Original CV\n');
  assert.equal(readFileSync(profile, 'utf8'), 'spend_tier: standard\n');
  assert.equal(existsSync(join(base, 'cv-versions')), false);
  assert.equal(existsSync(profileSaveJournalPath(base)), false);
});

test('destructive process death replays one complete profile decision exactly once', async (t) => {
  const base = sandbox(t);
  writeFileSync(join(base, 'workspace/profile/cv.md'), '# Original CV\n');
  writeFileSync(
    join(base, 'workspace', 'profile', 'profile.yml'),
    'candidate:\n  full_name: Old Name\nspend_tier: standard\n',
  );
  const save = {
      cv: '# New CV',
      versions: [{ label: 'leadership', text: '# Leadership CV' }],
      fields: { 'candidate.full_name': 'New Name' },
  };
  const crashed = await runWorker(base, save, 'crash-after-first-target');
  assert.equal(crashed.code, 73, crashed.stderr);
  assert.equal(existsSync(profileSaveJournalPath(base)), true);

  const recovered = await recoverProfileSave({ base });
  assert.equal(recovered.entries.length, 3);
  assert.equal(readFileSync(join(base, 'workspace/profile/cv.md'), 'utf8'), '# New CV\n');
  assert.equal(
    readFileSync(join(base, 'workspace', 'profile', 'cv-versions', '01-leadership.md'), 'utf8'),
    '# Leadership CV\n',
  );
  assert.match(
    readFileSync(join(base, 'workspace', 'profile', 'profile.yml'), 'utf8'),
    /full_name: New Name/u,
  );
  assert.equal(existsSync(profileSaveJournalPath(base)), false);
  assert.equal(await recoverProfileSave({ base }), null);
});

test('recovery refuses to overwrite a newer edit made after a crash', async (t) => {
  const base = sandbox(t);
  const cv = join(base, 'workspace/profile/cv.md');
  writeFileSync(cv, '# Original CV\n');

  await assert.rejects(
    publishProfileSave({ cv: '# Journalled CV' }, {
      base,
      afterStage(stage) {
        if (stage === 'journal') throw new Error('crash after journal');
      },
    }),
    /crash after journal/u,
  );
  writeFileSync(cv, '# Newer manual edit\n');

  await assert.rejects(
    recoverProfileSave({ base }),
    error => error?.code === 'PROFILE_TRANSACTION_CONFLICT',
  );
  assert.equal(readFileSync(cv, 'utf8'), '# Newer manual edit\n');
  assert.equal(existsSync(profileSaveJournalPath(base)), true);
});

test('destructive cross-process profile saves retain independent field updates', async (t) => {
  const base = sandbox(t);
  const results = await Promise.all([
    runWorker(base, {
      fields: { 'candidate.full_name': 'Jane Smith' },
    }),
    runWorker(base, {
      fields: { 'candidate.email': 'jane@example.com' },
    }),
    runWorker(base, {
      fields: { 'location.city': 'Manchester' },
    }),
  ]);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0]);

  const profile = readFileSync(join(base, 'workspace', 'profile', 'profile.yml'), 'utf8');
  assert.match(profile, /full_name:.*Jane Smith/u);
  assert.match(profile, /email:.*jane@example.com/u);
  assert.match(profile, /city:.*Manchester/u);
  assert.equal(existsSync(profileSaveJournalPath(base)), false);
});

test('poisoned journal state cannot choose a profile publication path', async (t) => {
  const base = sandbox(t);
  const journal = profileSaveJournalPath(base);
  const outside = join(base, 'outside');
  mkdirSync(join(base, 'data'), { recursive: true });
  writeFileSync(journal, `${JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    entries: [{
      path: '../outside',
      beforeHash: null,
      content: 'unsafe',
    }],
  })}\n`);

  await assert.rejects(
    recoverProfileSave({ base }),
    /invalid target/u,
  );
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(journal), true);
});

test('the fixed profile controller publishes one complete transaction', async (t) => {
  const base = sandbox(t);
  const result = await runControl(base, {
    version: '1',
    action: 'save',
    cv: '# Controller CV',
    versions: [{ label: 'focused', text: '# Focused CV' }],
    fields: { 'candidate.full_name': 'Controller User' },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: '1',
    written: ['workspace/profile/cv.md', 'workspace/profile/cv-versions/1', 'candidate.full_name'],
  });
  assert.equal(readFileSync(join(base, 'workspace/profile/cv.md'), 'utf8'), '# Controller CV\n');
  assert.equal(
    readFileSync(join(base, 'workspace', 'profile', 'cv-versions', '01-focused.md'), 'utf8'),
    '# Focused CV\n',
  );
  assert.match(
    readFileSync(join(base, 'workspace', 'profile', 'profile.yml'), 'utf8'),
    /full_name:.*Controller User/u,
  );
  assert.equal(existsSync(profileSaveJournalPath(base)), false);
});

test('profile controller appends an additional CV without accepting a path', async (t) => {
  const base = sandbox(t);
  const result = await runControl(base, {
    version: '1',
    action: 'add-version',
    label: 'operations roles',
    text: '# Operations CV\nMore detail here.',
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: '1',
    added: { name: '01-operations-roles.md', bytes: 34, words: 6 },
  });
  assert.equal(
    readFileSync(join(base, 'workspace', 'profile', 'cv-versions', '01-operations-roles.md'), 'utf8'),
    '# Operations CV\nMore detail here.\n',
  );

  const rejected = await runControl(base, {
    version: '1', action: 'add-version', label: '../../outside', text: '# Safe',
  });
  assert.equal(rejected.code, 0, rejected.stderr);
  assert.deepEqual(JSON.parse(rejected.stdout).added.name, '02-outside.md');
  assert.equal(existsSync(join(base, 'outside')), false);
});
