import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jaccardSimilarity,
  recommendCvReuse,
  seniorityLevel,
  tokenizeJobDescription,
} from '../../src/cv/jd-similarity.mjs';

test('tokenization is deterministic, multilingual and stop-word filtered', () => {
  assert.deepEqual(
    [...tokenizeJobDescription('The Senior C++ Engineer 负责 RAG pipelines.')],
    ['senior', 'c++', 'engineer', 'rag', 'pipelines'],
  );
});

test('Jaccard similarity handles empty and overlapping descriptions', () => {
  assert.equal(jaccardSimilarity('', ''), 1);
  assert.equal(jaccardSimilarity('', 'Python'), 0);
  assert.equal(jaccardSimilarity('Python Docker', 'Python Kubernetes'), 1 / 3);
});

test('seniority mismatch always forces regeneration', () => {
  assert.equal(seniorityLevel('Staff Platform Engineer'), 4);
  assert.equal(seniorityLevel('Senior Platform Engineer'), 3);
  assert.deepEqual(
    recommendCvReuse(
      'Staff Platform Engineer Python Docker',
      'Senior Platform Engineer Python Docker',
      { mediumThreshold: 0, highThreshold: 0, minTokens: 1 },
    ),
    {
      decision: 'regenerate',
      score: 4 / 6,
      reason: 'level-mismatch',
    },
  );
});

test('reuse thresholds produce stable auditable decisions', () => {
  assert.equal(
    recommendCvReuse('Senior Python Docker', 'Senior Python Docker', { minTokens: 1 }).decision,
    'reuse',
  );
  assert.equal(
    recommendCvReuse('Python Docker Kubernetes', 'Python Docker Terraform', {
      mediumThreshold: 0.4,
      highThreshold: 0.8,
      minTokens: 1,
    }).decision,
    'reuse-with-edits',
  );
  assert.equal(
    recommendCvReuse('Python', 'Rust', { minTokens: 1 }).decision,
    'regenerate',
  );
  assert.throws(
    () => recommendCvReuse('a', 'b', {
      mediumThreshold: 0.9,
      highThreshold: 0.5,
      minTokens: 1,
    }),
    /similarity options/,
  );
});

test('reuse fails closed when either description lacks enough evidence', () => {
  assert.deepEqual(
    recommendCvReuse('', ''),
    { decision: 'regenerate', score: 1, reason: 'insufficient-content' },
  );
  assert.equal(
    recommendCvReuse('Senior Python', 'Senior Python').reason,
    'insufficient-content',
  );
});
