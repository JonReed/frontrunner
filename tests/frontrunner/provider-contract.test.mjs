import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  enforceProviderResult,
  fetchProviderJobs,
  PROVIDER_CONTRACT_LIMITS,
  ProviderContractError,
} from '../../providers/_contract.mjs';

const valid = (overrides = {}) => ({
  title: ' Engineer ',
  url: 'https://jobs.example.com/roles/1',
  company: ' Acme ',
  location: ' Remote ',
  ...overrides,
});

test('non-array provider results fail closed instead of masquerading as an empty board', async () => {
  assert.throws(
    () => enforceProviderResult('hostile', { jobs: [] }),
    error => error instanceof ProviderContractError && /must return an array/.test(error.message),
  );
  await assert.rejects(
    fetchProviderJobs({ id: 'broken', fetch: async () => null }, {}, {}),
    /provider contract violation/,
  );
  const invalidLength = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return Number.POSITIVE_INFINITY;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => enforceProviderResult('hostile-length', invalidLength),
    /array with an invalid length/,
  );
});

test('malformed, credentialed, executable, duplicate and unreadable records are dropped centrally', () => {
  const unreadable = new Proxy({}, {
    get() {
      throw new Error('hostile getter');
    },
  });
  const jobs = enforceProviderResult('hostile', [
    null,
    { title: '', url: 'https://jobs.example.com/empty' },
    valid({ url: 'javascript:alert(1)' }),
    valid({ url: 'https://user:secret@jobs.example.com/roles/2' }),
    valid(),
    valid(),
    unreadable,
  ], { name: 'Fallback Co' });

  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs.providerContract.droppedReasons, {
    not_object: 1,
    invalid_title: 1,
    invalid_url: 2,
    duplicate_url: 1,
    unreadable_record: 1,
  });
});

test('accepted jobs use a closed, bounded schema with deterministic fallbacks', () => {
  const now = Date.now();
  const jobs = enforceProviderResult('bounded', [valid({
    title: `A${'x'.repeat(PROVIDER_CONTRACT_LIMITS.maxTitleChars + 50)}`,
    company: '',
    location: `L${'x'.repeat(PROVIDER_CONTRACT_LIMITS.maxLocationChars + 50)}`,
    description: `D${'x'.repeat(PROVIDER_CONTRACT_LIMITS.maxDescriptionChars + 50)}`,
    postedAt: now,
    salary: { min: 100_000, max: Infinity, currency: ' usd ', injected: 'no' },
    note: `N${'x'.repeat(PROVIDER_CONTRACT_LIMITS.maxNoteChars + 50)}`,
    arbitraryRemoteField: { deep: ['payload'] },
    trustScore: 100,
  })], { name: 'Fallback Co' });

  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.deepEqual(Object.keys(job), [
    'title', 'url', 'company', 'location', 'description', 'postedAt', 'salary', 'note',
  ]);
  assert.equal(job.title.length, PROVIDER_CONTRACT_LIMITS.maxTitleChars);
  assert.equal(job.company, 'Fallback Co');
  assert.equal(job.location.length, PROVIDER_CONTRACT_LIMITS.maxLocationChars);
  assert.equal(job.description.length, PROVIDER_CONTRACT_LIMITS.maxDescriptionChars);
  assert.equal(job.note.length, PROVIDER_CONTRACT_LIMITS.maxNoteChars);
  assert.deepEqual(job.salary, { min: 100_000, currency: 'USD' });
  assert.equal(job.postedAt, Math.trunc(now));
});

test('one fetch has hard job and aggregate-description budgets', () => {
  const hugeDescription = 'd'.repeat(PROVIDER_CONTRACT_LIMITS.maxDescriptionChars);
  const raw = Array.from({ length: PROVIDER_CONTRACT_LIMITS.maxJobs + 25 }, (_, index) =>
    valid({
      url: `https://jobs.example.com/roles/${index}`,
      description: hugeDescription,
    }));
  const jobs = enforceProviderResult('flood', raw);
  assert.equal(jobs.length, PROVIDER_CONTRACT_LIMITS.maxJobs);
  assert.equal(jobs.providerContract.truncated, true);
  assert.equal(jobs.providerContract.droppedReasons.result_limit, 25);
  assert.ok(jobs.providerContract.descriptionChars
    <= PROVIDER_CONTRACT_LIMITS.maxDescriptionCharsPerFetch);
  assert.equal(jobs.providerContract.descriptionBudgetExhausted, true);
  assert.ok(jobs.filter(job => job.description).length < jobs.length);
});

test('provider array status flags survive normalization without becoming job data', () => {
  const raw = [valid()];
  raw.workdayTruncated = true;
  raw.workdayNoDateSkip = true;
  raw.icimsTruncated = true;
  raw.attackerFlag = true;
  const jobs = enforceProviderResult('workday', raw);
  assert.equal(jobs.workdayTruncated, true);
  assert.equal(jobs.workdayNoDateSkip, true);
  assert.equal(jobs.icimsTruncated, true);
  assert.equal(jobs.attackerFlag, undefined);
  assert.equal(Object.keys(jobs).includes('providerContract'), false);
});

test('every core provider consumer routes fetch results through the contract', () => {
  const consumers = [
    'src/scan/scan.mjs',
    'src/scan/scan-ats-full.mjs',
    'src/scan/verify-portals.mjs',
    'src/scan/discover-ats.mjs',
  ];
  for (const relative of consumers) {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    assert.match(source, /fetchProviderJobs\s*\(/, relative);
    assert.doesNotMatch(
      source,
      /await\s+(?:provider|workday|(?:source|cfg)\.provider)\.fetch\s*\(/,
      `${relative} bypasses the provider-result contract`,
    );
  }

});
