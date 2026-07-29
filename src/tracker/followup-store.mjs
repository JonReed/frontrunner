/**
 * Canonical transaction boundary for data/follow-ups.md.
 *
 * The complete read/decision/publication sequence runs under the shared
 * owner-verified file lock. Replacement is fsync-backed and atomic, so a
 * crashed writer cannot expose a partial file or erase another writer's
 * update.
 */

import { existsSync, readFileSync } from 'node:fs';

import { withFileLock } from '../lib/file-lock.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';

/**
 * @template T
 * @param {string} filePath
 * @param {(current: string|null) => Promise<{value: T, content?: string}>|{value: T, content?: string}} decide
 * @param {{lockOptions?: object, writeOptions?: object}} [options]
 * @returns {Promise<T>}
 */
export async function transactFollowups(filePath, decide, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('follow-ups path must be a non-empty string');
  }
  if (typeof decide !== 'function') {
    throw new TypeError('follow-ups transaction must be a function');
  }

  const lockOptions = options.lockOptions ?? {};
  return withFileLock(filePath, async () => {
    const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    const decision = await decide(current);
    if (!decision || typeof decision !== 'object' || !Object.hasOwn(decision, 'value')) {
      throw new TypeError('follow-ups transaction must return an object containing value');
    }

    if (Object.hasOwn(decision, 'content')) {
      if (typeof decision.content !== 'string') {
        throw new TypeError('follow-ups replacement content must be a string');
      }
      if (current === null || decision.content !== current) {
        replaceFileAtomic(filePath, decision.content, options.writeOptions);
      }
    }
    return decision.value;
  }, {
    ...lockOptions,
    ownerFields: {
      ...(lockOptions.ownerFields ?? {}),
      followups: filePath,
    },
  });
}
