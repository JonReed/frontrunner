/**
 * Crash-recoverable publication for one complete local profile save.
 *
 * The browser submits CV, CV versions and profile fields as one decision. A
 * private write-ahead journal makes that one logical operation even though the
 * durable user data spans several files. Every path is derived here; request
 * data can never select a destination.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { withFileLock } from '../lib/file-lock.mjs';
import { removeFileProtected, replaceFileAtomic } from '../lib/locked-file.mjs';
import {
  cvPath,
  cvVersionFilename,
  cvVersionsDir,
  normalizeCvText,
  profileBase,
  profilePath,
  renderProfilePatch,
  validateProfilePatch,
} from './profile-write.mjs';

const JOURNAL_VERSION = 1;
const JOURNAL_NAME = 'profile-save-journal.json';
const MAX_JOURNAL_BYTES = 12 * 1024 * 1024;
const MAX_TARGET_BYTES = 1024 * 1024;
const MAX_ENTRIES = 22;
const ENTRY_KEYS = new Set(['path', 'beforeHash', 'content']);
const JOURNAL_KEYS = new Set(['version', 'createdAt', 'entries']);
const VERSION_KEYS = new Set(['label', 'text']);
const VERSION_PATH_RE = /^cv-versions\/\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u;

function fail(message, code = 'PROFILE_TRANSACTION_FAILED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw fail(`${label} contains an unsupported field: ${key}`);
  }
}

function hash(content) {
  return content === null
    ? null
    : createHash('sha256').update(content).digest('hex');
}

function journalPath(base = profileBase()) {
  return join(base, 'data', JOURNAL_NAME);
}

function resolveTarget(relativePath, base = profileBase()) {
  if (relativePath === 'cv.md') return join(base, 'cv.md');
  if (relativePath === 'config/profile.yml') return join(base, 'config', 'profile.yml');
  if (VERSION_PATH_RE.test(relativePath)) return join(base, ...relativePath.split('/'));
  throw fail(`profile journal contains an invalid target: ${relativePath}`);
}

function readTarget(file) {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TARGET_BYTES) {
    throw fail(`profile target is not a bounded regular file: ${file}`);
  }
  const content = readFileSync(file, 'utf8');
  if (Buffer.byteLength(content) > MAX_TARGET_BYTES) {
    throw fail(`profile target exceeds its byte limit: ${file}`);
  }
  return content;
}

function validateJournal(value, base, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('profile save journal must be an object');
  }
  exactKeys(value, JOURNAL_KEYS, 'profile save journal');
  if (value.version !== JOURNAL_VERSION) throw fail('unsupported profile save journal version');
  if (typeof value.createdAt !== 'string' || value.createdAt.length > 40) {
    throw fail('profile save journal timestamp is invalid');
  }
  if (
    !Array.isArray(value.entries)
    || value.entries.length < 1
    || value.entries.length > MAX_ENTRIES
  ) {
    throw fail('profile save journal entries are invalid');
  }
  const seen = new Set();
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw fail('profile save journal entry must be an object');
    }
    exactKeys(entry, ENTRY_KEYS, 'profile save journal entry');
    if (
      typeof entry.path !== 'string'
      || seen.has(entry.path)
      || typeof entry.content !== 'string'
      || Buffer.byteLength(entry.content) > MAX_TARGET_BYTES
      || (
        entry.beforeHash !== null
        && (
          typeof entry.beforeHash !== 'string'
          || !/^[a-f0-9]{64}$/u.test(entry.beforeHash)
        )
      )
    ) {
      throw fail('profile save journal entry is invalid');
    }
    seen.add(entry.path);
    return Object.freeze({
      path: entry.path,
      target: resolveTarget(entry.path, base),
      beforeHash: entry.beforeHash,
      content: entry.content,
    });
  });
  return Object.freeze({
    version: JOURNAL_VERSION,
    createdAt: value.createdAt,
    file,
    entries: Object.freeze(entries),
  });
}

function readJournal(base = profileBase()) {
  const file = journalPath(base);
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) {
    throw fail('profile save journal is not a bounded regular file');
  }
  const raw = readFileSync(file, 'utf8');
  if (Buffer.byteLength(raw) > MAX_JOURNAL_BYTES) {
    throw fail('profile save journal exceeds its byte limit');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail('profile save journal is not valid JSON');
  }
  return validateJournal(parsed, base, file);
}

async function withTargetLocks(entries, callback, index = 0) {
  if (index >= entries.length) return callback();
  return withFileLock(
    entries[index].target,
    () => withTargetLocks(entries, callback, index + 1),
  );
}

async function replayJournalUnlocked(publication, options = {}) {
  const entries = [...publication.entries].sort((left, right) =>
    left.target.localeCompare(right.target));
  return withTargetLocks(entries, async () => {
    for (const [index, entry] of entries.entries()) {
      const current = readTarget(entry.target);
      const currentHash = hash(current);
      const contentHash = hash(entry.content);
      if (currentHash !== contentHash) {
        if (currentHash !== entry.beforeHash) {
          throw fail(
            `profile target changed after the save was journalled: ${entry.path}`,
            'PROFILE_TRANSACTION_CONFLICT',
          );
        }
        replaceFileAtomic(entry.target, entry.content, { mode: 0o600 });
      }
      await options.afterStage?.('target', entry, index);
    }
    removeFileProtected(publication.file, { force: true });
    await options.afterStage?.('complete', publication);
    return publication;
  });
}

async function recoverUnlocked(base, options = {}) {
  const pending = readJournal(base);
  return pending ? replayJournalUnlocked(pending, options) : null;
}

function normalizedSave({ fields = {}, cv, versions = [] }) {
  if (
    !fields
    || typeof fields !== 'object'
    || Array.isArray(fields)
    || Object.getPrototypeOf(fields) !== Object.prototype
  ) {
    throw fail('profile fields must be an object');
  }
  const cleanFields = Object.keys(fields).length > 0 ? validateProfilePatch(fields) : {};
  if (!Array.isArray(versions) || versions.length > 20) {
    throw fail('profile CV versions are invalid');
  }
  const cleanCv = cv === undefined ? undefined : normalizeCvText(cv);
  const cleanVersions = versions.map((version, index) => {
    if (
      !version
      || typeof version !== 'object'
      || Array.isArray(version)
      || Object.getPrototypeOf(version) !== Object.prototype
    ) {
      throw fail('profile CV version must be an object');
    }
    exactKeys(version, VERSION_KEYS, 'profile CV version');
    const label = version.label ?? '';
    if (typeof label !== 'string' || typeof version.text !== 'string') {
      throw fail('profile CV version needs a text label and content');
    }
    return Object.freeze({
      path: `cv-versions/${cvVersionFilename(label, index)}`,
      content: normalizeCvText(version.text, 'CV version'),
    });
  });
  if (cleanCv === undefined && cleanVersions.length === 0 && Object.keys(cleanFields).length === 0) {
    throw fail('profile save must change something');
  }
  return { fields: cleanFields, cv: cleanCv, versions: cleanVersions };
}

export async function publishProfileSave(save, options = {}) {
  const base = options.base ?? profileBase();
  const file = journalPath(base);
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    await recoverUnlocked(base, options);
    const clean = normalizedSave(save);
    const relativeTargets = [
      ...(clean.cv === undefined ? [] : [{ path: 'cv.md', content: clean.cv }]),
      ...clean.versions,
      ...(Object.keys(clean.fields).length === 0 ? [] : [{
        path: 'config/profile.yml',
        content: null,
      }]),
    ];
    const entries = relativeTargets.map(entry => ({
      ...entry,
      target: resolveTarget(entry.path, base),
    })).sort((left, right) => left.target.localeCompare(right.target));

    return withTargetLocks(entries, async () => {
      const journalEntries = entries.map((entry) => {
        const current = readTarget(entry.target);
        const content = entry.path === 'config/profile.yml'
          ? renderProfilePatch(current ?? '', clean.fields, { base })
          : entry.content;
        return {
          path: entry.path,
          beforeHash: hash(current),
          content,
        };
      });
      const publication = validateJournal({
        version: JOURNAL_VERSION,
        createdAt: new Date().toISOString(),
        entries: journalEntries,
      }, base, file);
      replaceFileAtomic(
        file,
        `${JSON.stringify({
          version: publication.version,
          createdAt: publication.createdAt,
          entries: journalEntries,
        })}\n`,
        { mode: 0o600 },
      );
      await options.afterStage?.('journal', publication);

      for (const [index, entry] of publication.entries.entries()) {
        replaceFileAtomic(entry.target, entry.content, { mode: 0o600 });
        await options.afterStage?.('target', entry, index);
      }
      removeFileProtected(file, { force: true });
      await options.afterStage?.('complete', publication);
      return publication;
    });
  });
}

export async function recoverProfileSave(options = {}) {
  const base = options.base ?? profileBase();
  const file = journalPath(base);
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(file, () => recoverUnlocked(base, options));
}

export function profileSaveJournalPath(base = profileBase()) {
  return journalPath(base);
}
