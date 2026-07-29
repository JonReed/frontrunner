import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  allowRejectedRole,
  validatePrefilterOverrideRequest,
} from '../../src/application/prefilter-override-control.mjs';
import { evaluateDeterministicGate } from '../../src/evaluate/evaluation-gate.mjs';
import { runPrefilter } from '../../src/scan/prefilter.mjs';
import {
  matchingPrefilterOverride,
  parsePrefilterOverrides,
  readPrefilterOverrides,
} from '../../src/scan/prefilter-overrides.mjs';

const url = 'https://jobs.example.com/42';
const rules = {
  keep: [/\bhead\b/iu],
  ic: [/\bsoftware engineer\b/iu],
  wrong: [/\bmarketing\b/iu],
  junior: [/\bjunior\b/iu],
  blockers: [],
  comp: { enabled: false, margin: 0.8 },
};

test('override control accepts only an exact bounded URL and deterministic rule', () => {
  assert.deepEqual(
    validatePrefilterOverrideRequest({
      version: '1',
      action: 'allow',
      url,
      rule: 'ic_role_family',
    }),
    { version: '1', action: 'allow', url, rule: 'ic_role_family' },
  );

  for (const request of [
    null,
    [],
    { version: '1', action: 'allow', url: 'file:///tmp/job', rule: 'ic_role_family' },
    { version: '1', action: 'allow', url, rule: 'posting_expired' },
    { version: '1', action: 'allow', url, rule: '../escape' },
    { version: '1', action: 'allow', url, rule: 'ic_role_family', path: '/tmp/other' },
  ]) {
    assert.throws(() => validatePrefilterOverrideRequest(request));
  }
});

test('one explicit override restores the audited pipeline row and records its evidence', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-prefilter-override-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pipeline = join(dir, 'pipeline.md');
  const rejects = join(dir, 'prefilter-rejects.tsv');
  const overridesFile = join(dir, 'prefilter-overrides.tsv');
  const activeInput = join(dir, 'liveness-active.tsv');

  writeFileSync(
    pipeline,
    '# Pipeline\n\n## Processed\n\n'
      + `- [x] ${url} | Acme | Staff Software Engineer | result: prefilter rejected (ic_role_family)\n`,
  );
  writeFileSync(
    rejects,
    `url\tcompany\ttitle\trule\tevidence\n${url}\tAcme\tStaff Software Engineer\tic_role_family\tSoftware Engineer\n`,
  );

  const result = await allowRejectedRole({
    url,
    rule: 'ic_role_family',
    pipeline,
    rejects,
    overridesFile,
    activeInput,
    now: () => new Date('2026-07-29T12:00:00.000Z'),
  });

  assert.equal(result.role.company, 'Acme');
  assert.match(readFileSync(pipeline, 'utf8'), /^-\s*\[\s*\]\s*https:\/\/jobs\.example\.com\/42 \| Acme \| Staff Software Engineer$/mu);
  assert.doesNotMatch(readFileSync(pipeline, 'utf8'), /result:\s*prefilter rejected/iu);

  const active = readPrefilterOverrides(overridesFile);
  assert.equal(matchingPrefilterOverride(url, 'ic_role_family', active)?.title, 'Staff Software Engineer');
  assert.equal(matchingPrefilterOverride(url, 'wrong_function', active), null);
});

test('prefilter and mandatory evaluator gate honor only the exact URL-plus-rule decision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-prefilter-override-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'active.tsv');
  const rejects = join(dir, 'rejects.tsv');
  const out = join(dir, 'batch.tsv');
  writeFileSync(
    input,
    `id\turl\tsource\tnotes\n1\t${url}\tscan\tAcme — Staff Software Engineer\n`,
  );
  const overrides = parsePrefilterOverrides(
    `recorded_at\turl\tcompany\ttitle\trule\tevidence\n`
      + `2026-07-29T12:00:00.000Z\t${url}\tAcme\tStaff Software Engineer\tic_role_family\tSoftware Engineer\n`,
  );

  const filtered = runPrefilter({
    input,
    jdsDir: dir,
    out,
    rejects,
    profile: { minComp: 0, currency: 'GBP' },
    rules,
    overrides,
  });
  assert.equal(filtered.kept.length, 1);
  assert.equal(filtered.kept[0].overrideRule, 'ic_role_family');
  assert.equal(filtered.rejected.length, 0);

  const allowed = evaluateDeterministicGate({
    jdText: '# Staff Software Engineer\n\nBuild systems.',
    profile: { minComp: 0, currency: 'GBP' },
    rules,
    sourceUrl: url,
    overrides,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.rule, 'user_override');
  assert.equal(allowed.overriddenRule, 'ic_role_family');

  const otherUrl = evaluateDeterministicGate({
    jdText: '# Staff Software Engineer\n\nBuild systems.',
    profile: { minComp: 0, currency: 'GBP' },
    rules,
    sourceUrl: 'https://jobs.example.com/other',
    overrides,
  });
  assert.equal(otherUrl.allowed, false);

  const otherRule = evaluateDeterministicGate({
    jdText: '# Head of Marketing\n\nOwn demand generation.',
    profile: { minComp: 0, currency: 'GBP' },
    rules,
    sourceUrl: url,
    overrides,
  });
  assert.equal(otherRule.allowed, false);
  assert.equal(otherRule.rule, 'wrong_function');
});

test('separate explicit rules for one posting remain independently active', () => {
  const overrides = parsePrefilterOverrides(
    `recorded_at\turl\tcompany\ttitle\trule\tevidence\n`
      + `2026-07-29T12:00:00.000Z\t${url}\tAcme\tRole\tic_role_family\tEngineer\n`
      + `2026-07-30T12:00:00.000Z\t${url}\tAcme\tRole\twrong_function\tMarketing\n`,
  );

  assert.equal(
    matchingPrefilterOverride(url, 'ic_role_family', overrides)?.evidence,
    'Engineer',
  );
  assert.equal(
    matchingPrefilterOverride(url, 'wrong_function', overrides)?.evidence,
    'Marketing',
  );
});
