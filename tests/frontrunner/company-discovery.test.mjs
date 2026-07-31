import assert from 'node:assert/strict';
import test from 'node:test';

import { validateApplicationRequest } from '../../src/application/contract.mjs';
import {
  COMPANY_CONTRACT_VERSION,
  buildCompanySystemPrompt,
  parseCompanyResponse,
} from '../../src/cv/company-contract.mjs';
import { scanAll } from '../../src/scan/scan-all.mjs';

const request = (operation, input) => ({ version: '1', operation, input });

/* ------------------------------------------------ names becoming arguments */

test('real employer names survive validation', () => {
  const normalized = validateApplicationRequest(request('companies.discover', {
    names: ['Marks & Spencer', "Sainsbury's", 'L’Oréal', 'BT Group (UK)', '3M', 'Kingfisher plc'],
  }));
  assert.deepEqual(normalized.input.names, [
    'Marks & Spencer',
    "Sainsbury's",
    'L’Oréal',
    'BT Group (UK)',
    '3M',
    'Kingfisher plc',
  ]);
});

test('a name that could be read as a flag is refused', () => {
  // The whole reason the pattern is anchored on a letter or digit: these reach
  // argv, and a company called "--write" is not a company.
  for (const names of [
    ['--write'],
    ['-x'],
    ['--in=/etc/passwd'],
    ['-'],
  ]) {
    assert.throws(() => validateApplicationRequest(request('companies.discover', { names })));
  }
});

test('the name list is bounded and deduplicated', () => {
  assert.deepEqual(
    validateApplicationRequest(request('companies.discover', {
      names: ['Acme', 'acme', ' Acme ', 'Other'],
    })).input.names,
    ['Acme', 'Other'],
  );

  for (const names of [
    [],
    ['x'.repeat(200)],
    Array.from({ length: 21 }, (_, i) => `Company ${i}`),
    [42],
    'Acme',
  ]) {
    assert.throws(() => validateApplicationRequest(request('companies.discover', { names })));
  }
});

test('discovery takes nothing from the request but names', () => {
  assert.throws(() => validateApplicationRequest(request('companies.discover', {
    names: ['Acme'],
    write: true,
  })));
});

/* --------------------------------------------------- the suggestion contract */

test('a suggestion response keeps only usable names', () => {
  const parsed = parseCompanyResponse(JSON.stringify({
    version: COMPANY_CONTRACT_VERSION,
    companies: [
      { name: 'Marks & Spencer', why: 'National retailer near you' },
      // Dropped rather than rejecting the whole response: one odd suggestion
      // should not cost the user the good ones.
      { name: '--write', why: 'hostile' },
      { name: '', why: 'empty' },
      { name: 'Marks & Spencer', why: 'duplicate' },
      { name: 'Boots', why: '' },
    ],
  }));
  assert.deepEqual(parsed.companies, [
    { name: 'Marks & Spencer', why: 'National retailer near you' },
    { name: 'Boots', why: '' },
  ]);
});

test('a suggestion response from the wrong contract is refused outright', () => {
  for (const raw of [
    JSON.stringify({ version: '0.9', companies: [] }),
    JSON.stringify({ version: COMPANY_CONTRACT_VERSION }),
    JSON.stringify([]),
    'null',
  ]) {
    assert.throws(() => parseCompanyResponse(raw), (error) => error.code === 'INVALID_COMPANY_RESPONSE');
  }
});

test('every suggested name would also pass the follow request', () => {
  const parsed = parseCompanyResponse(JSON.stringify({
    version: COMPANY_CONTRACT_VERSION,
    companies: [
      { name: "Sainsbury's", why: 'a' },
      { name: 'L’Oréal', why: 'b' },
      { name: 'BT Group (UK)', why: 'c' },
    ],
  }));
  // The two validators are deliberately separate modules; this is the test
  // that stops them drifting into a state where the product suggests something
  // it then refuses to act on.
  assert.doesNotThrow(() => validateApplicationRequest(request('companies.discover', {
    names: parsed.companies.map((entry) => entry.name),
  })));
});

test('the prompt forbids addresses and repeats what is already followed', () => {
  const prompt = buildCompanySystemPrompt({
    cv: '# CV\nPractice manager.',
    profile: 'candidate:\n  full_name: Jane\n',
    following: ['Boots'],
    keywords: ['Practice Manager'],
    location: 'Manchester',
  });
  assert.match(prompt, /never a URL/u);
  assert.match(prompt, /Do not invent organisations/u);
  assert.match(prompt, /ALREADY FOLLOWED:\nBoots/u);
  assert.match(prompt, /Practice Manager/u);
});

/* -------------------------------------------------------- the search passes */

test('a search runs the tracked pass and the bounded sweep, in that order', async () => {
  const calls = [];
  const result = await scanAll({
    log: () => {},
    run: async (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /scan\.mjs$/u);
  assert.match(calls[1][0], /scan-ats-full\.mjs$/u);
  // --resume is what makes each bounded search continue the directory rather
  // than restarting at the top.
  assert.ok(calls[1].includes('--resume'));
  assert.ok(calls[1].includes('--since'));
  assert.deepEqual(result.passes.map((p) => p.status), ['ok', 'ok']);
  assert.equal(result.ok, true);
});

test('the sweep hitting its time budget is success, not failure', async () => {
  const result = await scanAll({
    log: () => {},
    run: async (_command, args) => {
      if (args.includes('--resume')) {
        const error = new Error('timed out');
        error.code = 'SUBPROCESS_TIMEOUT';
        throw error;
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.passes[1].status, 'budget-reached');
});

test('one failing pass does not throw away the other', async () => {
  const result = await scanAll({
    log: () => {},
    run: async (_command, args) => {
      if (args.includes('--resume')) return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'portals.yml not found' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.passes[0].status, 'failed');
  assert.match(result.passes[0].detail, /portals\.yml/u);
});

test('a search only fails when both passes do', async () => {
  const result = await scanAll({
    log: () => {},
    run: async () => ({ status: 1, stdout: '', stderr: 'offline' }),
  });
  assert.equal(result.ok, false);
});
