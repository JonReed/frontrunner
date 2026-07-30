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

test('config compiler rejects malformed structures and non-linear regex features', () => {
  const cases = [
    [{ ...base, below_level: 'junior' }, /below_level must be an array/],
    [{ ...base, below_leveel: [] }, /unknown key "below_leveel"/],
    [{ ...base, keep_signals: ['('] }, /not valid linear-time regex syntax/],
    [{ ...base, keep_signals: ['   '] }, /non-empty regex string/],
    [{ ...base, keep_signals: ['\\bassociate\\b(?!\\s+director)'] }, /not valid linear-time regex syntax/],
    [{ ...base, keep_signals: ['(a)\\1'] }, /not valid linear-time regex syntax/],
    [{ ...base, comp: { enabled: true, clearance_margin: 'nope' } }, /clearance_margin/],
    [{ ...base, comp: { enabled: true, clearance_margin: true } }, /clearance_margin/],
    [{
      ...base,
      hard_blockers: [{ id: 'empty', enabled: true, all: [] }],
    }, /must contain at least one pattern/],
    [{
      ...base,
      hard_blockers: [{
        id: 'too_many_conditions',
        enabled: true,
        all: Array.from({ length: 21 }, (_, index) => `condition-${index}`),
      }],
    }, /has more than 20 patterns/],
    [{
      ...base,
      hard_blockers: [{ id: 'disabled_but_broken', enabled: false, all: ['('] }],
    }, /not valid linear-time regex syntax/],
    [{
      ...base,
      hard_blockers: [
        { id: 'duplicate', enabled: false, all: ['one'] },
        { id: 'duplicate', enabled: true, all: ['two'] },
      ],
    }, /duplicates "duplicate"/],
    [{
      ...base,
      hard_blockers: [{ id: 'unknown_key', enabled: false, all: ['one'], typo: true }],
    }, /unknown key "typo"/],
    [{
      ...base,
      hard_blockers: [{
        id: 'long_reason',
        enabled: true,
        all: ['one'],
        reason: 'x'.repeat(501),
      }],
    }, /reason must be non-empty and at most 500 characters/],
    [{
      ...base,
      keep_signals: Array.from({ length: 100 }, (_, index) => `keep-${index}`),
      ic_families: Array.from({ length: 100 }, (_, index) => `ic-${index}`),
      wrong_functions: Array.from({ length: 100 }, (_, index) => `wrong-${index}`),
      below_level: Array.from({ length: 100 }, (_, index) => `junior-${index}`),
      hard_blockers: Array.from({ length: 6 }, (_, blocker) => ({
        id: `blocker_${blocker}`,
        enabled: false,
        all: Array.from({ length: 20 }, (_, index) => `blocker-${blocker}-${index}`),
      })),
    }, /more than 500 regex patterns in total/],
  ];

  for (const [config, expected] of cases) {
    assert.throws(
      () => compilePrefilterConfig(config, { source: 'fixture.yml' }),
      (error) => error instanceof PrefilterConfigError && expected.test(error.message),
    );
  }
});

test('hostile descriptions cannot trigger native-regex catastrophic backtracking', () => {
  const rules = compilePrefilterConfig({
    ...base,
    hard_blockers: [{
      id: 'hostile_pattern',
      enabled: true,
      all: ['^(a|aa)+$'],
      reason: 'fixture',
    }],
  });
  const startedAt = performance.now();
  const result = classify('Role', `${'a'.repeat(23_999)}!`, {}, rules);
  assert.equal(result.verdict, 'keep');
  assert.ok(performance.now() - startedAt < 1_000, 'linear-time regex evaluation exceeded one second');
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
