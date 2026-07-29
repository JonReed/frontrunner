/**
 * Crash-recoverable publication for confirmed candidate-source additions.
 *
 * `cv.md` and `article-digest.md` are both canonical user inputs. A confirmed
 * `/add` operation may update both, so publishing them as unrelated writes can
 * leave a half-applied fact after interruption. This module journals the exact
 * before/after transition and replays it idempotently under fixed-path locks.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';

import { withFileLock } from '../lib/file-lock.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';

const JOURNAL_VERSION = 1;
const MAX_SOURCE_BYTES = 4_000_000;
const MAX_JOURNAL_BYTES = 50_000_000;
const TARGET_NAMES = new Set(['cv', 'articleDigest']);
const JOURNAL_KEYS = new Set(['version', 'targets']);
const TARGET_KEYS = new Set([
  'name',
  'beforeExists',
  'beforeHash',
  'content',
  'contentHash',
]);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function currentFile(filePath) {
  if (!existsSync(filePath)) {
    return { exists: false, content: null, hash: null };
  }
  const content = readFileSync(filePath, 'utf8');
  return { exists: true, content, hash: digest(content) };
}

function validateTarget(target) {
  if (
    !target
    || typeof target !== 'object'
    || Object.keys(target).some(key => !TARGET_KEYS.has(key))
    || !TARGET_NAMES.has(target.name)
    || typeof target.beforeExists !== 'boolean'
    || (target.beforeExists
      ? typeof target.beforeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(target.beforeHash)
      : target.beforeHash !== null)
    || typeof target.content !== 'string'
    || Buffer.byteLength(target.content) > MAX_SOURCE_BYTES
    || typeof target.contentHash !== 'string'
    || target.contentHash !== digest(target.content)
  ) {
    throw new Error('invalid add-entry publication target');
  }
  return target;
}

function validateJournal(value, journalPath) {
  if (
    !value
    || typeof value !== 'object'
    || Object.keys(value).some(key => !JOURNAL_KEYS.has(key))
    || value.version !== JOURNAL_VERSION
    || !Array.isArray(value.targets)
    || value.targets.length < 1
    || value.targets.length > 2
  ) {
    throw new Error(`invalid add-entry publication journal: ${basename(journalPath)}`);
  }
  const targets = value.targets.map(validateTarget);
  if (new Set(targets.map(target => target.name)).size !== targets.length) {
    throw new Error('duplicate add-entry publication target');
  }
  return { version: JOURNAL_VERSION, targets };
}

function readJournal(journalPath) {
  const raw = readFileSync(journalPath, 'utf8');
  if (Buffer.byteLength(raw) > MAX_JOURNAL_BYTES) {
    throw new Error(`add-entry publication journal is too large: ${basename(journalPath)}`);
  }
  try {
    return validateJournal(JSON.parse(raw), journalPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`add-entry publication journal is not valid JSON: ${basename(journalPath)}`);
    }
    throw error;
  }
}

function targetPath(target, paths) {
  return target.name === 'cv' ? paths.cvPath : paths.articlePath;
}

function validatePaths(paths) {
  for (const [name, value] of Object.entries(paths)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty path`);
    }
  }
  const resolved = [paths.cvPath, paths.articlePath, paths.journalPath]
    .map(value => resolve(value));
  if (new Set(resolved).size !== resolved.length) {
    throw new Error('add-entry source and journal paths must be distinct');
  }
  return paths;
}

async function withTargetLocks(paths, fn) {
  const targets = [...new Set([paths.cvPath, paths.articlePath])].sort();
  const visit = index => (
    index === targets.length
      ? fn()
      : withFileLock(targets[index], () => visit(index + 1))
  );
  return visit(0);
}

async function replayJournalUnlocked(journalPath, paths, afterStage) {
  if (!existsSync(journalPath)) return null;
  const journal = readJournal(journalPath);

  const states = journal.targets.map(target => {
    const filePath = targetPath(target, paths);
    const current = currentFile(filePath);
    const published = current.exists && current.hash === target.contentHash;
    const unchanged = (
      current.exists === target.beforeExists
      && current.hash === target.beforeHash
    );
    if (!published && !unchanged) {
      throw new Error(
        `refusing to recover ${target.name}: source changed after publication was journaled`,
      );
    }
    return { target, filePath, published };
  });

  for (const { target, filePath, published } of states) {
    if (!published) {
      replaceFileAtomic(filePath, target.content, { mode: 0o600 });
    }
    await afterStage?.(target.name, journal);
  }

  unlinkSync(journalPath);
  await afterStage?.('complete', journal);
  return journal;
}

/**
 * Recover an interrupted publication without accepting paths from the journal.
 */
export async function recoverAddEntryPublication({
  cvPath,
  articlePath,
  journalPath,
}, options = {}) {
  validatePaths({ cvPath, articlePath, journalPath });
  return withFileLock(journalPath, () => withTargetLocks(
    { cvPath, articlePath },
    () => replayJournalUnlocked(
      journalPath,
      { cvPath, articlePath },
      options.afterStage,
    ),
  ));
}

/**
 * Recover any prior transaction, compute a new mutation from current files,
 * journal it, and publish every changed source.
 */
export async function mutateAddEntrySources({
  cvPath,
  articlePath,
  journalPath,
  compute,
}, options = {}) {
  if (typeof compute !== 'function') throw new TypeError('compute must be a function');
  validatePaths({ cvPath, articlePath, journalPath });

  return withFileLock(journalPath, () => withTargetLocks(
    { cvPath, articlePath },
    async () => {
      await replayJournalUnlocked(
        journalPath,
        { cvPath, articlePath },
        options.afterStage,
      );

      const cvBefore = currentFile(cvPath);
      const articleBefore = currentFile(articlePath);
      const output = await compute({
        cvText: cvBefore.content,
        articleText: articleBefore.content,
      });
      if (!output || typeof output !== 'object' || !output.result) {
        throw new Error('add-entry computation returned an invalid result');
      }

      const candidates = [
        {
          name: 'cv',
          before: cvBefore,
          content: output.cv,
          changed: output.result.cv?.status === 'added',
        },
        {
          name: 'articleDigest',
          before: articleBefore,
          content: output.articleDigest,
          changed: ['added', 'created'].includes(output.result.articleDigest?.status),
        },
      ];
      const targets = candidates.filter(candidate => candidate.changed).map(candidate => {
        if (
          typeof candidate.content !== 'string'
          || Buffer.byteLength(candidate.content) > MAX_SOURCE_BYTES
        ) {
          throw new Error(`${candidate.name} publication content is invalid`);
        }
        return {
          name: candidate.name,
          beforeExists: candidate.before.exists,
          beforeHash: candidate.before.hash,
          content: candidate.content,
          contentHash: digest(candidate.content),
        };
      });

      if (targets.length === 0) return output;
      const journal = validateJournal({
        version: JOURNAL_VERSION,
        targets,
      }, journalPath);
      replaceFileAtomic(
        journalPath,
        `${JSON.stringify(journal, null, 2)}\n`,
        { mode: 0o600 },
      );
      await options.afterStage?.('journal', journal);
      await replayJournalUnlocked(
        journalPath,
        { cvPath, articlePath },
        options.afterStage,
      );
      return output;
    },
  ));
}
