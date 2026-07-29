// prefilter.test.mjs — destructive tests for the deterministic pass.
//
// The unit-test trap this suite exists to avoid: career-ops ships passing
// unit tests for aggregate-tokens.mjs (parseTokenVal, estimateCost,
// formatBreakdown) while the tool reports 0.0k in production, because nothing
// ever asserted that real usage reaches the formatter. Green tests, dead
// feature.
//
// So these tests do not check that the classifier returns a shape. They check
// the two things that can actually hurt:
//
//   1. PROPERTY — the filter must never reject a role that a real LLM pass
//      scored well. Run against a checked-in corpus with real
//      scores. This is the claim the README makes; it must stay true through
//      every future rule change.
//   2. REGRESSION — the two false positives found during the first audit,
//      both of which silently killed real roles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { ROOT } from '#paths';
import { classify } from '../../src/scan/prefilter.mjs';
import { compilePrefilterConfig } from '../../src/scan/prefilter-config.mjs';

/** Compile a rule set the way prefilter.mjs does, from an explicit config. */
function rulesFrom(cfg) {
  return compilePrefilterConfig(cfg);
}

const exampleCfg = yaml.load(readFileSync(join(ROOT, 'config/prefilter.example.yml'), 'utf8'));
const leadershipCfg = yaml.load(readFileSync(join(ROOT, 'benchmarks/prefilter-leadership.yml'), 'utf8'));

const leadership = rulesFrom(leadershipCfg);
const shipped = rulesFrom(exampleCfg);
const noProfile = { minComp: 0, currency: 'GBP' };

// ---------------------------------------------------------------------------
// 1. PROPERTY — never reject what the model rated highly
// ---------------------------------------------------------------------------

const corpus = JSON.parse(readFileSync(join(ROOT, 'benchmarks/prefilter-scored-corpus.json'), 'utf8'));

test('property: no role scoring >= 4.0 is ever rejected', () => {
  const wrongly = corpus
    .filter((r) => r.score >= 4.0)
    .map((r) => ({ ...r, res: classify(r.title, '', noProfile, leadership) }))
    .filter((r) => r.res.verdict === 'reject');

  assert.deepEqual(
    wrongly.map((w) => `${w.score} ${w.title} [${w.res.rule}]`),
    [],
    'the deterministic pass discarded a role the LLM rated a real candidate',
  );
});

test('property: no role scoring >= 3.0 is ever rejected', () => {
  // The README claims this explicitly. If a rule change breaks it, the claim
  // is false and someone will check.
  const wrongly = corpus
    .filter((r) => r.score >= 3.0)
    .map((r) => ({ ...r, res: classify(r.title, '', noProfile, leadership) }))
    .filter((r) => r.res.verdict === 'reject');

  assert.deepEqual(wrongly.map((w) => `${w.score} ${w.title} [${w.res.rule}]`), []);
});

test('the filter is not a no-op: unambiguous non-fits are rejected', () => {
  // Guards the tests above, which a filter that keeps EVERYTHING would pass
  // trivially. Deliberately not measured against the scored corpus: most of
  // its low scorers are titles like "Engineering Manager" or "Delivery
  // Manager" that the filter correctly keeps and the model then rates 1.8 for
  // contextual reasons no regex can see. Rejecting those would be a false
  // positive, not a win.
  const mustReject = [
    'Staff Software Engineer',
    'Senior Machine Learning Scientist',
    'Graduate Developer',
    'Data Analyst',
    'Head of Brand Marketing',
    'Senior Tax Accountant',
  ];
  for (const t of mustReject) {
    assert.equal(classify(t, '', noProfile, leadership).verdict, 'reject', `should reject: ${t}`);
  }
});

test('the filter is not over-eager: leadership titles survive', () => {
  const mustKeep = [
    'Head of Forward Deployment',
    'Director, Global Solutions Architecture',
    'Engineering Manager, AI Models Infrastructure',
    'VP Engineering',
    'Applied AI Architect, Industries',
    'Associate Director, Delivery',
    'Chief Operating Officer',
  ];
  for (const t of mustKeep) {
    const r = classify(t, '', noProfile, leadership);
    assert.equal(r.verdict, 'keep', `should keep: ${t} (rejected by ${r.rule})`);
  }
});

// ---------------------------------------------------------------------------
// 2. REGRESSION — false positives found in the first audit
// ---------------------------------------------------------------------------

test('regression: export-control boilerplate is not a visa refusal', () => {
  // Killed "Director, Customer Engineering" on the first run. "without
  // sponsorship" appears in export-licence text and has nothing to do with
  // immigration.
  const cfg = structuredClone(leadershipCfg);
  cfg.hard_blockers = cfg.hard_blockers.map((b) =>
    b.id === 'no_visa_sponsorship' ? { ...b, enabled: true } : b,
  );
  const jd = 'Subject to export laws without sponsorship for an export license.';
  const res = classify('Director, Customer Engineering', jd, noProfile, rulesFrom(cfg));
  assert.equal(res.verdict, 'keep', `rejected via ${res.rule}: ${res.evidence}`);
});

test('regression: a real visa refusal IS still caught', () => {
  // The fix above must not neuter the rule.
  const cfg = structuredClone(leadershipCfg);
  cfg.hard_blockers = cfg.hard_blockers.map((b) =>
    b.id === 'no_visa_sponsorship' ? { ...b, enabled: true } : b,
  );
  const jd = 'Applicants must have the right to work in the UK; we are unable to sponsor visas.';
  const res = classify('Director of Delivery', jd, noProfile, rulesFrom(cfg));
  assert.equal(res.verdict, 'reject');
  assert.equal(res.rule, 'no_visa_sponsorship');
});

test('regression: base salary near the floor is not rejected against total comp', () => {
  // Killed "Machine Learning Manager, Operations" at £145,200 base against a
  // £150,000 TOTAL comp floor. Bonus and equity routinely close that gap.
  const profile = { minComp: 150000, currency: 'GBP' };
  const jd = 'The base salary for this role is £145,200 plus bonus and equity.';
  const res = classify('Head of Machine Learning Operations', jd, profile, leadership);
  assert.equal(res.verdict, 'keep', `rejected via ${res.rule}: ${res.evidence}`);
});

test('regression: comp far below the floor IS still rejected', () => {
  const profile = { minComp: 150000, currency: 'GBP' };
  const jd = 'Salary: £75,000 per annum.';
  const res = classify('Head of IT Operations', jd, profile, leadership);
  assert.equal(res.verdict, 'reject');
  assert.equal(res.rule, 'comp_below_floor');
});

test('regression: clearance blocker needs "already hold", not just the word', () => {
  const cfg = structuredClone(leadershipCfg);
  cfg.hard_blockers = cfg.hard_blockers.map((b) =>
    b.id === 'active_security_clearance' ? { ...b, enabled: true } : b,
  );
  const rules = rulesFrom(cfg);

  const willSponsor = 'We will sponsor SC clearance for the successful candidate.';
  assert.equal(classify('Delivery Director', willSponsor, noProfile, rules).verdict, 'keep');

  const mustHold = 'Active SC clearance is mandatory and must be held at application.';
  assert.equal(classify('Delivery Director', mustHold, noProfile, rules).verdict, 'reject');
});

// ---------------------------------------------------------------------------
// 3. SHIPPED DEFAULTS — the config must have no opinions out of the box
// ---------------------------------------------------------------------------

test('shipped config does not judge IC vs leadership', () => {
  assert.deepEqual(exampleCfg.ic_families, [], 'ic_families must ship empty');
  assert.deepEqual(exampleCfg.wrong_functions, [], 'wrong_functions must ship empty');
  assert.equal(classify('Staff Software Engineer', '', noProfile, shipped).verdict, 'keep');
  assert.equal(classify('Head of Marketing', '', noProfile, shipped).verdict, 'keep');
});

test('shipped config ships both hard blockers disabled', () => {
  for (const b of exampleCfg.hard_blockers ?? []) {
    assert.equal(b.enabled, false, `${b.id} must ship disabled`);
  }
});

test('shipped config does not assume early-career roles are below the candidate level', () => {
  assert.deepEqual(exampleCfg.below_level, [], 'below_level must ship empty');
  for (const t of ['Graduate Software Engineer', 'Engineering Intern', 'Apprentice Developer']) {
    assert.equal(classify(t, '', noProfile, shipped).verdict, 'keep', t);
  }
});

// ---------------------------------------------------------------------------
// 4. ADVERSARIAL INPUT — must never throw
// ---------------------------------------------------------------------------

test('adversarial: malformed and hostile input does not throw', () => {
  const nasties = [
    '',
    null,
    undefined,
    'x'.repeat(50_000),
    'Head of  ￿ Delivery',
    'Director (CI/CD) — Ops',
    '📊 Head of Data',
    'a'.repeat(5) + '\n'.repeat(1000),
  ];
  for (const t of nasties) {
    assert.doesNotThrow(() => classify(t, 'body', noProfile, leadership), String(t).slice(0, 30));
  }
});

test('adversarial: title and JD inputs are bounded before regex matching', () => {
  const titleTail = `${'x'.repeat(500)} Head of Marketing`;
  const jdTail = `${'x'.repeat(24_000)} Active SC clearance must already be held.`;
  assert.equal(classify(titleTail, '', noProfile, leadership).verdict, 'keep');

  const cfg = structuredClone(exampleCfg);
  cfg.hard_blockers = cfg.hard_blockers.map((b) =>
    b.id === 'active_security_clearance' ? { ...b, enabled: true } : b,
  );
  assert.equal(classify('Delivery Director', jdTail, noProfile, rulesFrom(cfg)).verdict, 'keep');
});

test('adversarial: an empty rule set keeps everything rather than crashing', () => {
  const empty = rulesFrom({});
  const res = classify('Anything At All', 'body', noProfile, empty);
  assert.equal(res.verdict, 'keep');
});
