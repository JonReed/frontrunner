/**
 * search-write.mjs — the only way `workspace/search/portals.yml` gets written
 * on behalf of a local interface.
 *
 * This is profile-write.mjs's sibling and follows the same three rules, for the
 * same reasons: writes are surgical rather than regenerated, only allowlisted
 * paths are writable, and every write is locked and atomic. What differs is
 * what the file means.
 *
 * WHY THIS EXISTS AT ALL. Onboarding used to end with a working profile and no
 * portals file, so the first thing a new user clicked — search — died with
 * "workspace/search/portals.yml not found. Run onboarding first." after they
 * had just finished onboarding. The file was reachable only by copying a
 * template from a terminal, which this project says it will not require.
 *
 * WHY IT IS SEEDED FROM THE TEMPLATE. `templates/portals.example.yml` carries
 * the tracked company list and the comments explaining every filter. A
 * generated skeleton would give UI-created installs a strictly worse file than
 * hand-created ones, and a scan with no companies finds nothing at all.
 *
 * WHY ONLY FILTERS AND AN ENABLED FLAG ARE WRITABLE. The rest of the file
 * selects hosts to talk to: careers URLs, ATS API endpoints, parser commands.
 * A browser request must never be able to name any of those. Adding a company
 * is therefore not a write path here — it goes through the ATS discovery
 * operation, which resolves a real board from a name and appends the entry
 * itself.
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';

import { ROOT } from '#paths';
import { mutateFileLocked } from '../lib/locked-file.mjs';

/**
 * Resolved per call and overridable, for the same reason profileBase() is: a
 * suite that exercised this against the real checkout would rewrite the
 * developer's own search configuration.
 */
export function searchBase() {
  return process.env.FRONTRUNNER_SEARCH_BASE || ROOT;
}

export const searchConfigPath = () =>
  process.env.FRONTRUNNER_PORTALS || join(searchBase(), 'workspace', 'search', 'portals.yml');
export const searchTemplatePath = (base = searchBase()) =>
  join(base, 'templates', 'portals.example.yml');

const MAX_ITEMS = 60;
const MAX_ITEM_LENGTH = 80;
const MAX_COMPANY_NAME = 120;

/**
 * Every list the UI may write, and nothing else.
 *
 * `minimum: 1` on the positive titles is not a formality. An absent
 * `title_filter.positive` means every title passes, so saving an empty list
 * from a form would silently turn a targeted search into a firehose — the
 * opposite of what someone clearing a box intends.
 */
export const WRITABLE_LISTS = Object.freeze({
  'title_filter.positive': { minimum: 1 },
  'title_filter.negative': { minimum: 0 },
  'location_filter.allow': { minimum: 0 },
  'location_filter.block': { minimum: 0 },
});

function fail(message, code = 'INVALID_SEARCH_WRITE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Normalise one list of short keywords.
 *
 * Case is preserved because the file is read by a human as well as a matcher,
 * but duplicates are folded case-insensitively: "Remote" and "remote" are one
 * intention typed twice, and keeping both makes the saved form look like it
 * misunderstood the user.
 */
export function normalizeList(value, path, { enforceMinimum = true } = {}) {
  if (!Array.isArray(value)) throw fail(`"${path}" must be a list.`);
  if (value.length > MAX_ITEMS) throw fail(`"${path}" has too many entries.`);
  const seen = new Set();
  const clean = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw fail(`"${path}" must contain only text.`);
    const item = raw.trim();
    if (!item) continue;
    if (item.length > MAX_ITEM_LENGTH) throw fail(`An entry in "${path}" is too long.`);
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(item);
  }
  const rule = enforceMinimum ? WRITABLE_LISTS[path] : null;
  if (rule && clean.length < rule.minimum) {
    throw fail(`"${path}" needs at least ${rule.minimum} entry.`, 'SEARCH_LIST_EMPTY');
  }
  return clean;
}

export function validateSearchPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw fail('A search update must be an object of list paths.');
  }
  const entries = Object.entries(patch);
  if (entries.length === 0) throw fail('A search update must change something.');
  const clean = {};
  for (const [path, value] of entries) {
    if (!Object.hasOwn(WRITABLE_LISTS, path)) {
      throw fail(`"${path}" is not a writable search list.`, 'FIELD_NOT_WRITABLE');
    }
    clean[path] = normalizeList(value, path);
  }
  return clean;
}

/**
 * Seed content for a search configuration that does not exist yet.
 *
 * Copied rather than re-serialised: the template is 1,900 lines of which most
 * are the tracked company list and the comments documenting each filter, and a
 * load/dump round trip would discard all of it.
 */
function seedSearchDocument(base = searchBase()) {
  const template = searchTemplatePath(base);
  if (existsSync(template)) return readFileSync(template, 'utf8');
  throw fail(
    'The search configuration template is missing from this installation.',
    'SEARCH_TEMPLATE_MISSING',
  );
}

export function renderSearchPatch(current, patch, options = {}) {
  const clean = validateSearchPatch(patch);
  const doc = parseDocument(
    current && current.trim() ? current : seedSearchDocument(options.base),
  );
  if (doc.errors?.length) {
    throw fail(
      `Your search settings could not be read, so they were left untouched: ${doc.errors[0].message}`,
      'SEARCH_UNPARSEABLE',
    );
  }
  for (const [path, value] of Object.entries(clean)) {
    const key = path.split('.');
    if (value.length === 0) doc.deleteIn(key);
    else doc.setIn(key, value);
  }
  return String(doc);
}

/** True when the user already has a search configuration. */
export function searchConfigExists() {
  return existsSync(searchConfigPath());
}

/**
 * Create the search configuration from the template if it is absent, applying
 * an optional first patch in the same locked write.
 *
 * Idempotent: an existing file is never re-seeded, because the second call
 * would silently restore filters the user had since removed. Returns whether
 * this call was the one that created it, so onboarding can say so honestly.
 */
export async function seedSearchConfig(patch = null) {
  const file = searchConfigPath();
  const existed = existsSync(file);
  mkdirSync(dirname(file), { recursive: true });

  if (existed && !patch) return { created: false, path: file };

  await mutateFileLocked(
    file,
    current => {
      const base = current && current.trim() ? current : seedSearchDocument();
      return patch ? renderSearchPatch(base, patch) : base;
    },
    { initial: seedSearchDocument() },
  );
  return { created: !existed, path: file };
}

/** Apply an allowlisted patch. Fails rather than seeding when nothing exists. */
export async function updateSearchConfig(patch) {
  const clean = validateSearchPatch(patch);
  const file = searchConfigPath();
  if (!existsSync(file)) {
    throw fail('There are no search settings to update yet.', 'SEARCH_CONFIG_MISSING');
  }
  await mutateFileLocked(file, current => renderSearchPatch(current, clean));
  return Object.keys(clean);
}

function listAt(doc, path) {
  const value = doc.getIn(path.split('.'), false);
  const plain = value && typeof value.toJSON === 'function' ? value.toJSON() : value;
  return Array.isArray(plain) ? plain.filter(item => typeof item === 'string') : [];
}

/**
 * Read the bounded view the interface is allowed to see.
 *
 * Careers URLs, API endpoints and parser commands are deliberately not
 * returned. The screen needs to show which companies are searched and let the
 * user turn one off; it has no reason to publish the hosts this installation
 * talks to into a browser.
 */
export function readSearchConfig() {
  const file = searchConfigPath();
  if (!existsSync(file)) {
    return {
      exists: false,
      keywords: [],
      excluded: [],
      locations: [],
      blockedLocations: [],
      companies: [],
    };
  }
  const doc = parseDocument(readFileSync(file, 'utf8'));
  if (doc.errors?.length) {
    throw fail(
      `Your search settings could not be read: ${doc.errors[0].message}`,
      'SEARCH_UNPARSEABLE',
    );
  }
  const tracked = doc.get('tracked_companies', false);
  const companies = [];
  if (tracked && Array.isArray(tracked.items)) {
    for (const item of tracked.items) {
      const entry = typeof item?.toJSON === 'function' ? item.toJSON() : item;
      if (!entry || typeof entry.name !== 'string') continue;
      const name = entry.name.trim();
      if (!name || name.length > MAX_COMPANY_NAME) continue;
      companies.push({ name, enabled: entry.enabled !== false });
    }
  }
  return {
    exists: true,
    keywords: listAt(doc, 'title_filter.positive'),
    excluded: listAt(doc, 'title_filter.negative'),
    locations: listAt(doc, 'location_filter.allow'),
    blockedLocations: listAt(doc, 'location_filter.block'),
    companies,
  };
}

/**
 * Turn one tracked company on or off, matched by its exact name.
 *
 * A name, never an index: the list is edited by hand and by ATS discovery, so
 * a position captured when the page rendered can refer to a different company
 * by the time the click arrives.
 */
export async function setCompanyEnabled(name, enabled) {
  if (typeof name !== 'string' || !name.trim() || name.length > MAX_COMPANY_NAME) {
    throw fail('That is not a company name this can change.');
  }
  if (typeof enabled !== 'boolean') throw fail('A company must be switched on or off.');
  const wanted = name.trim();
  const file = searchConfigPath();
  if (!existsSync(file)) {
    throw fail('There are no search settings to update yet.', 'SEARCH_CONFIG_MISSING');
  }

  let matched = false;
  await mutateFileLocked(file, current => {
    const doc = parseDocument(current);
    if (doc.errors?.length) {
      throw fail(
        `Your search settings could not be read, so they were left untouched: ${doc.errors[0].message}`,
        'SEARCH_UNPARSEABLE',
      );
    }
    const tracked = doc.get('tracked_companies', false);
    if (tracked && Array.isArray(tracked.items)) {
      for (const item of tracked.items) {
        if (typeof item?.get !== 'function') continue;
        if (String(item.get('name') ?? '').trim() !== wanted) continue;
        matched = true;
        item.set('enabled', enabled);
      }
    }
    if (!matched) throw fail('That company is no longer in your search settings.', 'COMPANY_NOT_FOUND');
    return String(doc);
  });
  return { name: wanted, enabled };
}

/**
 * Turn the onboarding answers into a first set of filters.
 *
 * The job titles someone would accept are exactly the keywords a title filter
 * needs, so they are carried across verbatim rather than paraphrased — this is
 * the only place the two questions are connected, and inventing synonyms here
 * would mean the saved search no longer matched what they typed.
 *
 * Location is deliberately additive rather than restrictive when they chose
 * remote work: "Remote" plus their own city keeps a hybrid role in their town
 * visible, which a bare "Remote" allow-list would drop.
 */
export function filtersFromAnswers({ roles = [], location = '', remote = '' } = {}) {
  const patch = {};

  /*
    Job titles are optional during setup — only the CV is required — so this
    has to survive being given none. Leaving the template's own keywords in
    place is the right failure: they are wrong for most people, but a search
    that returns the wrong roles can be corrected on the Where to search
    screen, whereas a setup that refused to create the file at all leaves
    someone with no search and no way to make one.
  */
  const keywords = normalizeList(roles, 'title_filter.positive', { enforceMinimum: false });
  if (keywords.length > 0) patch['title_filter.positive'] = keywords;

  const places = [];
  if (remote === 'remote' || remote === 'hybrid') places.push('Remote');
  const city = String(location ?? '').split(',')[0].trim();
  if (city) places.push(city);
  if (places.length > 0) {
    patch['location_filter.allow'] = normalizeList(places, 'location_filter.allow');
  }

  // An empty patch means every answer was skipped. Seeding still has to
  // happen; it just has nothing of the user's to apply.
  return Object.keys(patch).length > 0 ? patch : null;
}
