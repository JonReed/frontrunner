import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  filtersFromAnswers,
  normalizeList,
  readSearchConfig,
  seedSearchConfig,
  setCompanyEnabled,
  updateSearchConfig,
  validateSearchPatch,
} from '../../src/application/search-write.mjs';
import { validateSearchControlRequest } from '../../src/application/search-control.mjs';

/**
 * Point the writer at a scratch file for the duration of one test.
 *
 * FRONTRUNNER_PORTALS is the same override discover-ats.mjs already honours,
 * so a suite that forgot this would rewrite the developer's own search
 * configuration rather than a fixture.
 */
function scratchPortals(t) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-search-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.FRONTRUNNER_PORTALS;
  const file = join(dir, 'portals.yml');
  process.env.FRONTRUNNER_PORTALS = file;
  t.after(() => {
    if (previous === undefined) delete process.env.FRONTRUNNER_PORTALS;
    else process.env.FRONTRUNNER_PORTALS = previous;
  });
  return file;
}

test('only allowlisted search lists are writable', () => {
  assert.deepEqual(
    validateSearchPatch({ 'title_filter.positive': ['Operations Manager'] }),
    { 'title_filter.positive': ['Operations Manager'] },
  );

  for (const patch of [
    null,
    [],
    {},
    // Not on the allowlist: this one selects hosts the scanner talks to, which
    // a browser request must never be able to name.
    { tracked_companies: [{ name: 'Acme' }] },
    { 'title_filter.positive': 'Operations Manager' },
    { 'title_filter.positive': [{}] },
  ]) {
    assert.throws(() => validateSearchPatch(patch));
  }
});

test('an empty positive title list is refused rather than silently widening the search', () => {
  // An absent title_filter.positive means every title passes, so accepting an
  // empty list from a form would turn a targeted search into a firehose.
  assert.throws(
    () => normalizeList([], 'title_filter.positive'),
    (error) => error.code === 'SEARCH_LIST_EMPTY',
  );
  assert.deepEqual(normalizeList([], 'location_filter.allow'), []);
});

test('keyword lists are trimmed and deduplicated case-insensitively', () => {
  assert.deepEqual(
    normalizeList(['  Remote ', 'remote', 'REMOTE', '', 'London'], 'location_filter.allow'),
    ['Remote', 'London'],
  );
  assert.throws(() => normalizeList(['x'.repeat(200)], 'location_filter.allow'));
  assert.throws(
    () => normalizeList(Array.from({ length: 200 }, (_, i) => `k${i}`), 'location_filter.allow'),
  );
});

test('onboarding answers become the first set of filters', () => {
  assert.deepEqual(
    filtersFromAnswers({
      roles: ['Practice Manager', 'Operations Manager'],
      location: 'Manchester, UK',
      remote: 'hybrid',
    }),
    {
      'title_filter.positive': ['Practice Manager', 'Operations Manager'],
      // Remote plus the home city, not Remote alone: an allow-list of just
      // "Remote" would drop a hybrid role in the user's own town.
      'location_filter.allow': ['Remote', 'Manchester'],
    },
  );

  assert.deepEqual(
    filtersFromAnswers({ roles: ['Chef'], location: '', remote: 'onsite' }),
    { 'title_filter.positive': ['Chef'] },
  );

  // Job titles are optional during setup, so skipping every question must
  // still produce a usable file rather than refusing to create one.
  assert.equal(filtersFromAnswers({ roles: [], location: '', remote: '' }), null);
  assert.deepEqual(
    filtersFromAnswers({ roles: [], location: 'Bristol', remote: '' }),
    { 'location_filter.allow': ['Bristol'] },
  );
});

test('setup with no answers at all still creates a working search', async (t) => {
  scratchPortals(t);
  const result = await seedSearchConfig(filtersFromAnswers({ roles: [], location: '', remote: '' }));

  assert.equal(result.created, true);
  const config = readSearchConfig();
  assert.equal(config.exists, true);
  // The template's own keywords remain — wrong for most people, but correctable
  // on the Where to search screen, which a missing file would not be.
  assert.ok(config.keywords.length > 0);
  assert.ok(config.companies.length > 10);
});

test('seeding creates portals.yml from the template and applies the answers', async (t) => {
  const file = scratchPortals(t);

  const first = await seedSearchConfig(filtersFromAnswers({
    roles: ['Practice Manager'],
    location: 'Leeds',
    remote: 'remote',
  }));
  assert.equal(first.created, true);

  const config = readSearchConfig();
  assert.equal(config.exists, true);
  assert.deepEqual(config.keywords, ['Practice Manager']);
  assert.deepEqual(config.locations, ['Remote', 'Leeds']);
  // The template's company list is what makes a first scan find anything at
  // all, so seeding has to carry it across rather than write a bare skeleton.
  assert.ok(config.companies.length > 10);
  // And its comments, which document every filter the user can change.
  assert.match(readFileSync(file, 'utf8'), /# Portal Scanner Configuration/u);
});

test('seeding is idempotent and never restores filters the user removed', async (t) => {
  scratchPortals(t);
  await seedSearchConfig(filtersFromAnswers({ roles: ['Chef'], location: '', remote: '' }));
  await updateSearchConfig({ 'title_filter.positive': ['Sous Chef'] });

  const again = await seedSearchConfig();
  assert.equal(again.created, false);
  assert.deepEqual(readSearchConfig().keywords, ['Sous Chef']);
});

test('a company is switched by name, and an unknown name changes nothing', async (t) => {
  const file = scratchPortals(t);
  await seedSearchConfig(filtersFromAnswers({ roles: ['Chef'], location: '', remote: '' }));

  const target = readSearchConfig().companies.find((company) => company.enabled);
  assert.ok(target, 'the template ships at least one enabled company');

  await setCompanyEnabled(target.name, false);
  const after = readSearchConfig().companies.find((c) => c.name === target.name);
  assert.equal(after.enabled, false);

  const before = readFileSync(file, 'utf8');
  await assert.rejects(
    () => setCompanyEnabled('A Company That Is Not Listed', false),
    (error) => error.code === 'COMPANY_NOT_FOUND',
  );
  assert.equal(readFileSync(file, 'utf8'), before, 'a failed toggle leaves the file untouched');
});

test('updating refuses to seed, so a stale form cannot recreate deleted settings', async (t) => {
  scratchPortals(t);
  await assert.rejects(
    () => updateSearchConfig({ 'title_filter.positive': ['Chef'] }),
    (error) => error.code === 'SEARCH_CONFIG_MISSING',
  );
});

test('unparseable settings are reported rather than overwritten', async (t) => {
  const file = scratchPortals(t);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'title_filter:\n  positive:\n   - "unclosed\n  bad: [1, 2\n');

  assert.throws(() => readSearchConfig(), (error) => error.code === 'SEARCH_UNPARSEABLE');
  const before = readFileSync(file, 'utf8');
  await assert.rejects(() => updateSearchConfig({ 'title_filter.positive': ['Chef'] }));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('an unreadable file reports its own error rather than looking absent', async (t) => {
  const file = scratchPortals(t);
  writeFileSync(file, 'title_filter:\n  positive:\n   - "unclosed\n  bad: [1, 2\n');

  // The UI adapter distinguishes these two states by matching this wording. A
  // malformed file that read as "missing" would be offered a create button
  // that refuses, returning the same screen forever.
  assert.throws(
    () => readSearchConfig(),
    (error) => error.code === 'SEARCH_UNPARSEABLE' && /could not be read/u.test(error.message),
  );
});

test('the search control refuses anything outside its fixed protocol', () => {
  assert.deepEqual(
    validateSearchControlRequest({ version: '1', action: 'read' }),
    { version: '1', action: 'read' },
  );
  assert.deepEqual(
    validateSearchControlRequest({ version: '1', action: 'company', company: 'Acme', enabled: false }),
    { version: '1', action: 'company', company: 'Acme', enabled: false },
  );

  for (const request of [
    null,
    [],
    { version: '2', action: 'read' },
    { version: '1', action: 'delete' },
    { version: '1', action: 'read', lists: {} },
    { version: '1', action: 'save', lists: {} },
    { version: '1', action: 'save', lists: { tracked_companies: [] } },
    { version: '1', action: 'company', company: '', enabled: false },
    { version: '1', action: 'company', company: 'Acme', enabled: 'no' },
    { version: '1', action: 'seed', answers: { roles: 'Chef' } },
    { version: '1', action: 'seed', answers: { remote: 'sometimes' } },
    { version: '1', action: 'seed', answers: { path: '/etc/passwd' } },
  ]) {
    assert.throws(() => validateSearchControlRequest(request));
  }
});

test('the shipped template is present, because seeding depends on it', () => {
  assert.match(
    readFileSync(join(ROOT, 'templates', 'portals.example.yml'), 'utf8'),
    /^title_filter:/mu,
  );
});
