/**
 * Crash-safe, concurrent model blacklist persistence.
 */

import { lstatSync, readFileSync } from 'node:fs';

import { mutateFileLocked } from '../lib/locked-file.mjs';

const MAX_MODELS = 10_000;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._:+-]{0,255}$/iu;

function normalizeModels(value) {
  if (!Array.isArray(value)) throw new Error('model blacklist must be a JSON array');
  if (value.length > MAX_MODELS) throw new Error(`model blacklist exceeds ${MAX_MODELS} entries`);
  const models = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !MODEL_ID_RE.test(item)) {
      throw new Error('model blacklist contains an invalid model id');
    }
    models.add(item);
  }
  return models;
}

function assertSafeTarget(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('model blacklist must be a regular file');
  }
  return true;
}

export function readModelBlacklist(file) {
  if (!assertSafeTarget(file)) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('model blacklist is not valid JSON');
  }
  return normalizeModels(parsed);
}

export async function addModelsToBlacklist(file, additions, options = {}) {
  const requested = normalizeModels([...additions]);
  assertSafeTarget(file);
  let result;
  await mutateFileLocked(file, current => {
    let existing = [];
    if (current.trim()) {
      try {
        existing = JSON.parse(current);
      } catch {
        throw new Error('model blacklist is not valid JSON');
      }
    }
    const merged = normalizeModels(existing);
    for (const model of requested) merged.add(model);
    result = merged;
    return `${JSON.stringify([...merged].sort(), null, 2)}\n`;
  }, {
    initial: '[]\n',
    lockOptions: options.lockOptions,
    writeOptions: {
      mode: 0o600,
      afterWrite: options.afterWrite,
    },
  });
  return result;
}
