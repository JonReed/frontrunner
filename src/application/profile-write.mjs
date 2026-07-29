/**
 * profile-write.mjs — the only way user-layer profile files get written.
 *
 * Two callers need this and they are the same operation at different moments:
 * onboarding creates `config/profile.yml` and `cv.md` from nothing, and the
 * profile screen updates fields in them later. Building it once means the
 * second is nearly free.
 *
 * Three rules shape everything below.
 *
 * WRITES ARE SURGICAL, NEVER REGENERATED. `config/profile.example.yml` is 273
 * lines of which 183 are comments — they are the documentation for every knob
 * in the file. A load/dump round-trip through js-yaml destroys all of them and
 * silently drops any key it does not know about (measured: 273 lines in, 76
 * out). So edits go through the `yaml` package's Document API, which preserves
 * comments, ordering and unknown keys. js-yaml is still correct for *reading*
 * and is used everywhere else in the project; the two coexist deliberately.
 *
 * ONLY ALLOWLISTED PATHS ARE WRITABLE. The request comes from a browser, and
 * this file drives scoring, evaluation and CV generation. Without an allowlist,
 * "update my profile" means "set arbitrary keys in the file that decides what
 * the model is told about you". Anything not named below is rejected, not
 * ignored — silently discarding a field the caller believed it saved is worse
 * than refusing it.
 *
 * WRITES ARE LOCKED AND ATOMIC. The UI, the CLI and a coding agent can all be
 * running at once. mutateFileLocked is the same primitive the tracker uses:
 * read, mutate, atomic rename, all under a file lock.
 *
 * What this module does NOT do: decide content. It never invents a value,
 * never calls a model, and never merges one CV into another. It writes what it
 * is given, to paths it recognises, or it fails.
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

import { ROOT } from '#paths';
import { mutateFileLocked, replaceFileAtomic } from '../lib/locked-file.mjs';

/**
 * Where the user-layer files live.
 *
 * Resolved per call rather than at import, and overridable, because these are
 * the two files it would be worst to write during a test run. A suite that
 * exercises this module against the real checkout overwrites the developer's
 * own CV — which has already happened once in this project, with
 * src/cv/generate-pdf.mjs writing into the real data/pdf-index.tsv.
 * FRONTRUNNER_PDF_BASE is the precedent this mirrors.
 */
export function profileBase() {
  return process.env.FRONTRUNNER_PROFILE_BASE || ROOT;
}

export const profilePath = () => join(profileBase(), 'config', 'profile.yml');
export const profileTemplatePath = (base = profileBase()) =>
  join(base, 'config', 'profile.example.yml');
export const cvPath = () => join(profileBase(), 'cv.md');
/**
 * Additional CV versions. Same trust level as writing-samples/ — the user's own
 * words, kept as reference material for tailoring, never a source of fact on
 * their own. Gitignored like every other user-layer directory.
 */
export const cvVersionsDir = () => join(profileBase(), 'cv-versions');

const MAX_FIELD = 500;
const MAX_LIST = 40;
const MAX_CV_BYTES = 512 * 1024;

/**
 * Every field the UI may write, and nothing else.
 *
 * `list` fields are arrays of short strings; `enum` fields must match exactly.
 * The dotted key is the path into the YAML document.
 */
export const WRITABLE_FIELDS = Object.freeze({
  'candidate.full_name': { type: 'text' },
  'candidate.email': { type: 'text' },
  'candidate.phone': { type: 'text' },
  'candidate.location': { type: 'text' },
  'candidate.linkedin': { type: 'text' },
  'candidate.portfolio_url': { type: 'text' },
  'candidate.github': { type: 'text' },
  'target_roles.primary': { type: 'list' },
  'compensation.target_range': { type: 'text' },
  'compensation.minimum': { type: 'text' },
  'compensation.currency': { type: 'text' },
  'compensation.location_flexibility': { type: 'text' },
  'location.country': { type: 'text' },
  'location.city': { type: 'text' },
  'location.timezone': { type: 'text' },
  'location.visa_status': { type: 'text' },
  'spend_tier': { type: 'enum', values: ['economy', 'standard', 'premium'] },
});

function fail(message, code = 'INVALID_PROFILE_WRITE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validate a patch before anything is opened for writing.
 *
 * Deliberately whole-patch-first: a partially applied update would leave the
 * profile in a state the user never asked for and cannot see.
 */
export function validateProfilePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw fail('A profile update must be an object of field paths.');
  }
  const entries = Object.entries(patch);
  if (entries.length === 0) throw fail('A profile update must change something.');

  const clean = {};
  for (const [path, raw] of entries) {
    const rule = WRITABLE_FIELDS[path];
    if (!rule) throw fail(`"${path}" is not a writable profile field.`, 'FIELD_NOT_WRITABLE');

    if (rule.type === 'list') {
      if (!Array.isArray(raw)) throw fail(`"${path}" must be a list.`);
      if (raw.length > MAX_LIST) throw fail(`"${path}" has too many entries.`);
      const items = raw
        .map(v => (typeof v === 'string' ? v.trim() : null))
        .filter(v => v !== null && v !== '');
      if (items.some(v => v.length > MAX_FIELD)) throw fail(`An entry in "${path}" is too long.`);
      clean[path] = items;
      continue;
    }

    if (typeof raw !== 'string') throw fail(`"${path}" must be text.`);
    const value = raw.trim();
    if (value.length > MAX_FIELD) throw fail(`"${path}" is too long.`);
    if (rule.type === 'enum' && value !== '' && !rule.values.includes(value)) {
      throw fail(`"${path}" must be one of: ${rule.values.join(', ')}.`);
    }
    clean[path] = value;
  }
  return clean;
}

/**
 * Seed content for a profile that does not exist yet.
 *
 * The shipped example is the template on purpose: it carries the comments that
 * explain every field, so a profile created from the UI is as self-documenting
 * as one created by hand. Falling back to a bare skeleton would quietly give
 * UI-created installs a worse file than CLI-created ones.
 */
function seedProfile(base = profileBase()) {
  const template = profileTemplatePath(base);
  if (existsSync(template)) return readFileSync(template, 'utf8');
  return 'candidate:\ncompensation:\nlocation:\ntarget_roles:\nspend_tier: standard\n';
}

export function renderProfilePatch(current, patch, options = {}) {
  const clean = validateProfilePatch(patch);
  const doc = parseDocument(
    current && current.trim() ? current : seedProfile(options.base),
  );
  if (doc.errors?.length) {
    throw fail(
      `config/profile.yml could not be parsed, so it was left untouched: ${doc.errors[0].message}`,
      'PROFILE_UNPARSEABLE',
    );
  }
  for (const [path, value] of Object.entries(clean)) {
    const key = path.split('.');
    if (value === '' || (Array.isArray(value) && value.length === 0)) doc.deleteIn(key);
    else doc.setIn(key, value);
  }
  return String(doc);
}

/**
 * Apply an allowlisted patch to config/profile.yml.
 *
 * Returns the paths actually written. Creates the file from the template when
 * it does not exist, so onboarding and later edits are the same code path.
 */
export async function updateProfile(patch) {
  const clean = validateProfilePatch(patch);

  mkdirSync(join(profileBase(), 'config'), { recursive: true });

  await mutateFileLocked(
    profilePath(),
    current => renderProfilePatch(current, clean),
    { initial: seedProfile() },
  );

  return Object.keys(clean);
}

/** Read the current profile as plain data. Reading never needs the Document API. */
export function readProfileFields() {
  const file = profilePath();
  if (!existsSync(file)) return {};
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const out = {};
  for (const path of Object.keys(WRITABLE_FIELDS)) {
    const value = doc.getIn(path.split('.'), false);
    if (value === undefined || value === null) continue;
    out[path] = typeof value === 'object' && typeof value.toJSON === 'function'
      ? value.toJSON()
      : value;
  }
  return out;
}

export function normalizeCvText(markdown, label = 'CV') {
  if (typeof markdown !== 'string') throw fail(`${label} must be text.`);
  const text = markdown.trim();
  if (!text) throw fail(`${label} is empty.`);
  if (Buffer.byteLength(text, 'utf8') > MAX_CV_BYTES) throw fail(`${label} is too large.`);
  return `${text}\n`;
}

/**
 * Write cv.md — the canonical CV.
 *
 * A whole-file replace, because unlike the profile this file has no structure
 * to preserve; it is the user's own prose. Still locked and atomic: it is the
 * single most valuable file in the installation and a torn write costs someone
 * their CV.
 */
export async function writeCv(markdown) {
  const text = normalizeCvText(markdown);
  const file = cvPath();
  await mutateFileLocked(file, () => text);
  return file;
}

export function cvVersionFilename(label, index = 0) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 20) {
    throw fail('CV version index is outside the supported range.');
  }
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${String(index + 1).padStart(2, '0')}-${slug || 'version'}.md`;
}

/**
 * Store an additional CV version.
 *
 * Reference material, never canonical — see CV_VERSIONS_DIR. The label is the
 * user's own words ("the ops one"), so it is slugged rather than trusted as a
 * filename: it arrives from a browser and must never be able to escape the
 * directory or collide with a dotfile.
 */
export async function writeCvVersion(label, markdown, index = 0) {
  const text = normalizeCvText(markdown, 'CV version');
  const name = cvVersionFilename(label, index);

  const dir = cvVersionsDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  replaceFileAtomic(target, text);
  return target;
}
