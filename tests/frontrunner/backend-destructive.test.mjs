// Destructive backend boundary tests.
//
// Every test operates on a throwaway directory and invokes the production
// implementation. These deliberately assert files and repeatability rather
// than merely checking helper return shapes.

import { test } from 'node:test';
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
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT } from '#paths';
import { runPrefilter } from '../../src/scan/prefilter.mjs';

function fixture(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(file, contents = '') {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

test('doctor validates the real templates/fonts path and creates runtime directories', (t) => {
  const target = fixture(t, 'frontrunner-doctor-');

  put(join(target, 'workspace/profile/cv.md'), '# CV\n');
  put(join(target, 'workspace/profile/profile.yml'), 'name: Test User\n');
  put(join(target, 'workspace/profile/targeting.md'), '# Profile\n');
  put(join(target, 'workspace/search/portals.yml'), 'companies: []\n');
  put(join(target, 'templates/fonts/test.woff2'), 'not-a-real-font');
  mkdirSync(join(target, 'node_modules'));

  const proc = spawnSync(process.execPath, [join(ROOT, 'doctor.mjs'), '--target', target], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.match(proc.stdout, /✓ Fonts directory ready/);
  assert.doesNotMatch(proc.stdout, /✗ templates\/fonts\//);
  for (const dir of ['workspace/search', 'workspace/documents', 'workspace/reports/evaluations']) {
    assert.ok(existsSync(join(target, dir)), `${dir}/ was not created`);
  }
  assert.match(readFileSync(join(target, 'workspace/search/pipeline.md'), 'utf8'), /^# Pipeline — Pending URLs/);
});

test('prefilter writes an auditable shortlist into new directories and is idempotent', (t) => {
  const target = fixture(t, 'frontrunner-prefilter-');
  const input = join(target, 'pipeline.md');
  const jdsDir = join(target, 'jds');
  const out = join(target, 'nested/batch/input.tsv');
  const rejects = join(target, 'nested/audit/rejects.tsv');
  const blockerUrl = 'https://jobs.example.test/security-lead';

  put(
    input,
    [
      '- [ ] https://jobs.example.test/director | Acme | Director of Engineering |',
      '- [ ] https://jobs.example.test/junior | Acme | Junior Developer |',
      `- [ ] ${blockerUrl} | SecureCo | Chief Technology Officer |`,
      '',
    ].join('\n'),
  );
  const blockerFile = join(jdsDir, 'security.md');
  put(blockerFile, 'Applicants must be US citizens and already hold security clearance.');
  put(join(jdsDir, 'index.tsv'), `url\tfile\n${blockerUrl}\t${blockerFile}\n`);

  const rules = {
    keep: [/\b(director|chief)\b/i],
    ic: [/\bdeveloper\b/i],
    wrong: [],
    junior: [/\bjunior\b/i],
    blockers: [{ id: 'clearance', all: [/\bUS citizens?\b/i, /\bsecurity clearance\b/i], reason: 'clearance' }],
    comp: { enabled: false, margin: 0.8 },
  };
  const options = {
    input,
    jdsDir,
    out,
    rejects,
    profile: { minComp: 0, currency: 'GBP' },
    rules,
  };

  const first = runPrefilter(options);
  assert.deepEqual(first.result.byRule, { below_level: 1, clearance: 1 });
  assert.equal(first.result.kept, 1);
  const shortlist = readFileSync(out, 'utf8');
  const audit = readFileSync(rejects, 'utf8');
  assert.match(shortlist, /Director of Engineering/);
  assert.doesNotMatch(shortlist, /Junior Developer|Chief Technology Officer/);
  assert.match(audit, /Junior Developer\tbelow_level\tJunior/);
  assert.match(audit, /Chief Technology Officer\tclearance\t.*security clearance/i);

  runPrefilter(options);
  assert.equal(readFileSync(out, 'utf8'), shortlist, 'shortlist changed on an identical rerun');
  assert.equal(readFileSync(rejects, 'utf8'), audit, 'audit log changed on an identical rerun');
});

test('importing prefilter is inert: it neither runs the pipeline nor prints results', () => {
  const moduleUrl = new URL('../../src/scan/prefilter.mjs', import.meta.url).href;
  const proc = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(moduleUrl)})`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout, '');
  assert.equal(proc.stderr, '');
});
