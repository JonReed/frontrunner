import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import { readBoundedRegularFileSync } from '../../src/lib/safe-file-read.mjs';
import { parseJobUrl } from '../../src/scan/fetch-jds.mjs';

test('provider parsing rejects hostile lookalike hosts and non-HTTPS URLs', () => {
  for (const url of [
    'https://evilgreenhouse.io/acme/jobs/1',
    'https://greenhouse.io.evil.example/acme/jobs/1',
    'https://evilashbyhq.com/acme/1',
    'https://evillever.co/acme/1',
    'http://jobs.ashbyhq.com/acme/1',
    'ftp://jobs.lever.co/acme/1',
  ]) {
    assert.equal(parseJobUrl(url), null, url);
  }
});

test('reply-watch never creates sample employer messages for a missing input', t => {
  const directory = mkdtempSync(join(tmpdir(), 'frontrunner-reply-missing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidates = join(directory, 'missing.json');
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'src/tracker/reply-watch.mjs'), candidates],
    { cwd: directory, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(candidates), false);
  assert.match(result.stderr, /no sample employer messages were created/iu);
});

test('application prefill reaches validation instead of crashing on an undefined import', () => {
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, 'src/evaluate/prepare-application.mjs'),
      '--url',
      'https://boards.greenhouse.io/acme/jobs/1',
      '--pdf',
      'workspace/documents/does-not-exist.pdf',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PDF not found/iu);
  assert.doesNotMatch(result.stderr, /ReferenceError|join is not defined/iu);
});

test('bounded file reads reject oversized files and final-component symlinks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'frontrunner-safe-read-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'source.txt');
  const link = join(directory, 'link.txt');
  writeFileSync(file, '12345', { mode: 0o600 });

  assert.throws(
    () => readBoundedRegularFileSync(file, { maxBytes: 4, label: 'fixture' }),
    /no larger than 4 bytes/iu,
  );
  assert.equal(
    readBoundedRegularFileSync(file, { maxBytes: 5, label: 'fixture' }),
    '12345',
  );

  try {
    symlinkSync(file, link);
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('symlink creation needs Windows developer mode');
      return;
    }
    throw error;
  }
  if (process.platform !== 'win32') {
    assert.throws(
      () => readBoundedRegularFileSync(link, { maxBytes: 5, label: 'fixture' }),
      /must not be a symbolic link/iu,
    );
  }
});
