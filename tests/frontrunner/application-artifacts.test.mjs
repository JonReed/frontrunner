import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  applicationArtifactPaths,
  initializeApplicationArtifacts,
  recordReuseDecision,
} from '../../src/cv/application-artifacts.mjs';

const MODULE = new URL('../../src/cv/application-artifacts.mjs', import.meta.url);

function fixture(t) {
  const outputRoot = mkdtempSync(join(tmpdir(), 'frontrunner-application-artifacts-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  return {
    application: {
      reportNum: 7,
      company: '../../Acme & Sons',
      role: 'Senior Platform Engineer',
      version: 2,
    },
    outputRoot,
  };
}

test('bundle paths are stable, bounded and contained by construction', t => {
  const { application, outputRoot } = fixture(t);
  const paths = applicationArtifactPaths(application, { outputRoot });
  assert.equal(paths.key, '007-acme-sons-senior-platform-engineer');
  assert.equal(paths.root, join(outputRoot, paths.key));
  assert.equal(
    paths.cv.tailored.pdf,
    join(outputRoot, paths.key, 'cv', 'tailored', 'v002', 'cv.pdf'),
  );
  assert.throws(
    () => applicationArtifactPaths({ ...application, reportNum: '../7' }, { outputRoot }),
    /numeric report/,
  );
  assert.throws(
    () => applicationArtifactPaths({ ...application, company: 'x'.repeat(161) }, { outputRoot }),
    /must not exceed/,
  );
  assert.throws(
    () => applicationArtifactPaths({ ...application, company: '' }, { outputRoot }),
    /company must be a non-empty string/,
  );
  assert.equal(
    applicationArtifactPaths({
      ...application,
      company: '株式会社アクメ',
      role: '平台主管',
    }, { outputRoot }).key,
    '007-株式会社アクメ-平台主管',
  );
});

test('initialization creates only the canonical application bundle', t => {
  const { application, outputRoot } = fixture(t);
  const paths = initializeApplicationArtifacts(application, { outputRoot });
  assert.equal(lstatSync(join(paths.root, 'jd')).isDirectory(), true);
  assert.equal(lstatSync(paths.cv.tailored.root).isDirectory(), true);
  assert.equal(lstatSync(join(paths.root, 'decision')).isDirectory(), true);
});

test('initialization refuses a symlinked application bundle', t => {
  const { application, outputRoot } = fixture(t);
  const paths = applicationArtifactPaths(application, { outputRoot });
  const outside = mkdtempSync(join(tmpdir(), 'frontrunner-artifact-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, paths.root);
  assert.throws(
    () => initializeApplicationArtifacts(application, { outputRoot }),
    /symbolic link/,
  );
  assert.deepEqual(lstatSync(outside).isDirectory(), true);
});

test('concurrent decision writes remain complete, private and schema-valid', async t => {
  const { application, outputRoot } = fixture(t);
  const now = () => new Date('2026-07-30T12:00:00.000Z');
  await Promise.all([
    recordReuseDecision(application, {
      decision: 'reuse',
      score: 0.91,
      reason: 'high-similarity',
    }, { outputRoot, now }),
    recordReuseDecision(application, {
      decision: 'reuse-with-edits',
      score: 0.58,
      reason: 'medium-similarity',
      changedSections: ['Professional Summary'],
    }, { outputRoot, now }),
  ]);

  const paths = applicationArtifactPaths(application, { outputRoot });
  const record = JSON.parse(readFileSync(paths.decision.reuse, 'utf8'));
  assert.equal(record.schema_version, 1);
  assert.ok(['reuse', 'reuse-with-edits'].includes(record.decision));
  assert.equal(record.recorded_at, '2026-07-30T12:00:00.000Z');
  assert.equal(lstatSync(paths.decision.reuse).mode & 0o777, 0o600);
});

test('decision validation fails before replacing an existing record', async t => {
  const { application, outputRoot } = fixture(t);
  await recordReuseDecision(application, {
    decision: 'regenerate',
    score: 0.1,
  }, { outputRoot });
  const paths = applicationArtifactPaths(application, { outputRoot });
  const before = readFileSync(paths.decision.reuse, 'utf8');

  await assert.rejects(
    recordReuseDecision(application, {
      decision: 'delete-everything',
      changedSections: Array.from({ length: 40 }, () => 'section'),
    }, { outputRoot }),
    /decision must be one of/,
  );
  assert.equal(readFileSync(paths.decision.reuse, 'utf8'), before);
});

test('CLI rejects arbitrary output roots instead of writing outside workspace', () => {
  const result = spawnSync(process.execPath, [
    MODULE.pathname,
    '--report', '7',
    '--company', 'Acme',
    '--role', 'Engineer',
    '--root', tmpdir(),
    '--init',
  ], {
    encoding: 'utf8',
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'),
    ),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option '--root'|unknown option.*root/i);
});
