import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classify } from '../../src/scan/prefilter.mjs';
import {
  PrefilterConfigError,
  compilePrefilterConfig,
} from '../../src/scan/prefilter-config.mjs';

const base = {
  keep_signals: [],
  ic_families: [],
  wrong_functions: [],
  below_level: [],
  hard_blockers: [],
  comp: { enabled: true, clearance_margin: 0.8 },
};

test('config compiler rejects malformed structures and unsafe regexes', () => {
  const cases = [
    [{ ...base, below_level: 'junior' }, /below_level must be an array/],
    [{ ...base, keep_signals: ['('] }, /not a valid regex/],
    [{ ...base, keep_signals: ['^(a+)+$'] }, /super-linear regex/],
    [{ ...base, comp: { enabled: true, clearance_margin: 'nope' } }, /clearance_margin/],
    [{
      ...base,
      hard_blockers: [{ id: 'empty', enabled: true, all: [] }],
    }, /must contain at least one pattern/],
  ];

  for (const [config, expected] of cases) {
    assert.throws(
      () => compilePrefilterConfig(config, { source: 'fixture.yml' }),
      (error) => error instanceof PrefilterConfigError && expected.test(error.message),
    );
  }
});

test('unsupported compensation currencies bias toward keeping', () => {
  const rules = compilePrefilterConfig(base);
  const result = classify(
    'Director of Engineering',
    'Salary €20,000',
    { minComp: 150_000, currency: 'CAD' },
    rules,
  );
  assert.equal(result.verdict, 'keep');
});
