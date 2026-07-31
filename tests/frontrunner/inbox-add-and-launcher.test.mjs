import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  appendPendingUrl,
  validateInboxRequest,
} from '../../src/application/inbox-control.mjs';
import {
  installLauncher,
  launcherFor,
  shellQuote,
} from '../../src/application/install-launcher.mjs';
import { buildIsStale } from '../../src/application/start.mjs';

function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------------------------- adding a role by hand */

test('add accepts optional labels; remove and restore do not', () => {
  assert.deepEqual(
    validateInboxRequest({
      version: '1',
      action: 'add',
      url: 'https://example.com/jobs/42',
      company: 'Acme',
      role: 'Practice Manager',
    }),
    {
      version: '1',
      action: 'add',
      url: 'https://example.com/jobs/42',
      company: 'Acme',
      role: 'Practice Manager',
    },
  );

  for (const request of [
    { version: '1', action: 'remove', url: 'https://example.com/j', company: 'Acme' },
    { version: '1', action: 'restore', url: 'https://example.com/j', role: 'Chef' },
    { version: '1', action: 'add', url: 'file:///etc/passwd' },
    { version: '1', action: 'add', url: 'https://u:p@example.com/j' },
    { version: '1', action: 'add', url: 'https://example.com/j', company: 'x'.repeat(200) },
    { version: '1', action: 'add', url: 'https://example.com/j', role: 42 },
  ]) {
    assert.throws(() => validateInboxRequest(request));
  }
});

test('a pasted role joins the same list the scanner writes', async (t) => {
  const pipeline = join(scratch(t, 'frontrunner-inbox-add-'), 'pipeline.md');
  writeFileSync(pipeline, '# Pending\n\n- [ ] https://example.com/one | One | Engineer\n');

  const result = await appendPendingUrl(pipeline, 'https://example.com/two', {
    company: 'Acme',
    role: 'Practice Manager',
  });
  assert.deepEqual(result, {
    added: true,
    duplicate: false,
    url: 'https://example.com/two',
  });

  const lines = readFileSync(pipeline, 'utf8').split('\n');
  assert.ok(lines.includes('- [ ] https://example.com/one | One | Engineer'));
  // Trailing empty cells are kept: readers index positionally, so dropping
  // them would make a later `posted:` label parse as a location.
  assert.ok(lines.some((line) => line.startsWith(
    '- [ ] https://example.com/two | Acme | Practice Manager |',
  )));
});

test('a pipe in a pasted label cannot forge extra columns', async (t) => {
  const dir = scratch(t, 'frontrunner-inbox-add-');
  const hostile = join(dir, 'hostile.md');
  const clean = join(dir, 'clean.md');

  await appendPendingUrl(hostile, 'https://example.com/x', {
    company: 'Acme | Evil | Corp',
    role: 'Chef\nSous',
  });
  await appendPendingUrl(clean, 'https://example.com/x', { company: 'Acme', role: 'Chef' });

  const rowOf = (file) => readFileSync(file, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('- [ ] '));

  // The invariant is the shape: a label full of separators must produce
  // exactly the same number of cells as an ordinary one.
  assert.equal(rowOf(hostile).split('|').length, rowOf(clean).split('|').length);
  assert.match(rowOf(hostile), /\| Acme Evil Corp \| Chef Sous \|/u);
});

test('adding the same role twice reports a duplicate instead of repeating it', async (t) => {
  const pipeline = join(scratch(t, 'frontrunner-inbox-add-'), 'pipeline.md');
  await appendPendingUrl(pipeline, 'https://example.com/two');
  const second = await appendPendingUrl(pipeline, 'https://example.com/two');

  assert.equal(second.added, false);
  assert.equal(second.duplicate, true);
  assert.equal(
    readFileSync(pipeline, 'utf8').split('\n').filter((l) => l.includes('example.com/two')).length,
    1,
  );
});

test('re-adding a dismissed role does not quietly undo the dismissal', async (t) => {
  const pipeline = join(scratch(t, 'frontrunner-inbox-add-'), 'pipeline.md');
  writeFileSync(pipeline, '# Pending\n\n- [x] https://example.com/gone | Gone | Role\n');

  const result = await appendPendingUrl(pipeline, 'https://example.com/gone');
  assert.equal(result.duplicate, true);
  assert.match(readFileSync(pipeline, 'utf8'), /- \[x\] https:\/\/example\.com\/gone/u);
});

test('adding to a list that does not exist yet creates a usable one', async (t) => {
  const pipeline = join(scratch(t, 'frontrunner-inbox-add-'), 'pipeline.md');
  await appendPendingUrl(pipeline, 'https://example.com/first', { company: 'Acme' });
  const content = readFileSync(pipeline, 'utf8');
  assert.match(content, /^# Pipeline/u);
  assert.match(content, /- \[ \] https:\/\/example\.com\/first \| Acme \|/u);
});

/* ---------------------------------------------------------- the launcher */

test('a project path containing quotes or spaces stays one shell argument', () => {
  assert.equal(shellQuote('/srv/My Drive/frontrunner'), `'/srv/My Drive/frontrunner'`);
  assert.equal(shellQuote(`/tmp/it's here`), `'/tmp/it'\\''s here'`);
});

test('each platform gets a launcher its file manager will actually run', () => {
  const mac = launcherFor('darwin', '/srv/My Drive/frontrunner');
  assert.equal(mac.name, 'Frontrunner.command');
  assert.equal(mac.mode, 0o755);
  assert.match(mac.contents, /^#!\/bin\/sh/u);
  assert.match(mac.contents, /cd '\/srv\/My Drive\/frontrunner'/u);
  assert.match(mac.contents, /src\/application\/start\.mjs/u);

  const win = launcherFor('win32', 'D:\\Apps\\frontrunner');
  assert.equal(win.name, 'Frontrunner.cmd');
  assert.match(win.contents, /cd \/d "D:\\Apps\\frontrunner"/u);
  assert.match(win.contents, /src\\application\\start\.mjs/u);
  // CRLF, because Windows shells mis-parse a batch file with bare LF endings.
  assert.ok(win.contents.includes('\r\n'));

  assert.equal(launcherFor('linux', '/opt/frontrunner').name, 'Frontrunner.sh');
});

test('the installed launcher is executable and rewritable', (t) => {
  const dir = scratch(t, 'frontrunner-launcher-');
  const file = installLauncher({ platform: 'darwin', root: '/opt/frontrunner', dir });

  assert.equal(file, join(dir, 'Frontrunner.command'));
  /*
    POSIX only. NTFS does not carry the executable bit — chmod is close to a
    no-op there — and the Windows launcher is a .cmd, which the shell runs by
    extension and never needs one. Asserting it everywhere tested the host's
    filesystem rather than this code.
  */
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o111, 0o111, 'a launcher that is not executable does nothing');
  }

  // Regenerating after a move must replace it rather than fail or append.
  installLauncher({ platform: 'darwin', root: '/opt/elsewhere', dir });
  assert.match(readFileSync(file, 'utf8'), /cd '\/opt\/elsewhere'/u);
});

test('a missing or outdated build is detected so start rebuilds it', (t) => {
  const dir = scratch(t, 'frontrunner-build-stale-');
  const buildId = join(dir, 'BUILD_ID');
  const sourceDir = join(dir, 'src');
  rmSync(sourceDir, { recursive: true, force: true });

  assert.equal(buildIsStale({ buildId, sourceDir }), true, 'no build at all is stale');

  writeFileSync(buildId, 'abc');
  // A source tree older than the build (here: absent) must not force a rebuild
  // on every launch.
  assert.equal(buildIsStale({ buildId, sourceDir }), false);
});
