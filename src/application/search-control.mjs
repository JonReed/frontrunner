#!/usr/bin/env node

/**
 * Bounded JSON adapter between isolated local interfaces and the search-config
 * writer.
 *
 * Same contract as profile-control.mjs: one fixed script, one bounded JSON
 * request on stdin, and no request field that can select a path, an executable
 * or a flag. The action names a known operation; search-write.mjs decides
 * where anything lands.
 *
 * `seed` is separate from `save` on purpose. Onboarding needs "create this
 * from the template if it is absent", which must be idempotent and must not
 * fail when the file already exists; the settings screen needs "apply exactly
 * this change to a file that must already exist". Collapsing them would make
 * a stale form able to silently recreate settings the user had deleted.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { APPLICATION_API_VERSION } from './contract.mjs';
import { readBoundedRequest } from './run.mjs';
import {
  filtersFromAnswers,
  readSearchConfig,
  seedSearchConfig,
  setCompanyEnabled,
  updateSearchConfig,
  WRITABLE_LISTS,
} from './search-write.mjs';

const CONTROL_KEYS = new Set(['version', 'action', 'lists', 'company', 'enabled', 'answers']);
const ACTIONS = new Set(['read', 'save', 'seed', 'company']);
const ANSWER_KEYS = new Set(['roles', 'location', 'remote']);
const REMOTE_VALUES = new Set(['remote', 'hybrid', 'onsite', '']);

function controlError(message, code = 'INVALID_SEARCH_CONTROL_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateAnswers(value) {
  if (!plainObject(value)) throw controlError('answers must be a plain object');
  for (const key of Object.keys(value)) {
    if (!ANSWER_KEYS.has(key)) throw controlError(`unsupported answers field: ${key}`);
  }
  const roles = value.roles ?? [];
  if (!Array.isArray(roles)) throw controlError('answers.roles must be an array');
  for (const role of roles) {
    if (typeof role !== 'string') throw controlError('answers.roles must contain only text');
  }
  if (value.location !== undefined && typeof value.location !== 'string') {
    throw controlError('answers.location must be text');
  }
  if (value.remote !== undefined && !REMOTE_VALUES.has(value.remote)) {
    throw controlError('answers.remote is not a supported working pattern');
  }
  return Object.freeze({
    roles,
    location: value.location ?? '',
    remote: value.remote ?? '',
  });
}

export function validateSearchControlRequest(value) {
  if (!plainObject(value)) throw controlError('search-control request must be a plain object');
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported search-control field: ${key}`);
  }
  if (value.version !== APPLICATION_API_VERSION) {
    throw controlError(`unsupported search-control version: ${String(value.version ?? '')}`);
  }
  if (!ACTIONS.has(value.action)) {
    throw controlError(`unsupported search-control action: ${String(value.action ?? '')}`);
  }

  if (value.action === 'read') {
    for (const key of ['lists', 'company', 'enabled', 'answers']) {
      if (value[key] !== undefined) throw controlError(`read does not accept ${key}`);
    }
    return Object.freeze({ version: APPLICATION_API_VERSION, action: 'read' });
  }

  if (value.action === 'seed') {
    for (const key of ['lists', 'company', 'enabled']) {
      if (value[key] !== undefined) throw controlError(`seed does not accept ${key}`);
    }
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: 'seed',
      answers: value.answers === undefined ? null : validateAnswers(value.answers),
    });
  }

  if (value.action === 'company') {
    for (const key of ['lists', 'answers']) {
      if (value[key] !== undefined) throw controlError(`company does not accept ${key}`);
    }
    if (typeof value.company !== 'string' || !value.company.trim()) {
      throw controlError('company must be a name');
    }
    if (typeof value.enabled !== 'boolean') {
      throw controlError('enabled must be true or false');
    }
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: 'company',
      company: value.company,
      enabled: value.enabled,
    });
  }

  const lists = value.lists ?? {};
  if (!plainObject(lists)) throw controlError('lists must be a plain object');
  // Refused at the process boundary as well as in the writer: this is what the
  // browser talks to, and it should never forward a list name it does not
  // recognise even to a module that would also refuse it.
  for (const key of Object.keys(lists)) {
    if (!Object.hasOwn(WRITABLE_LISTS, key)) {
      throw controlError(`unsupported search list: ${key}`, 'FIELD_NOT_WRITABLE');
    }
  }
  if (Object.keys(lists).length === 0) throw controlError('save must change something');

  return Object.freeze({
    version: APPLICATION_API_VERSION,
    action: 'save',
    lists: Object.freeze({ ...lists }),
  });
}

export async function main({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  try {
    const control = validateSearchControlRequest(await readBoundedRequest(input));
    let result;

    if (control.action === 'read') {
      result = { version: APPLICATION_API_VERSION, config: readSearchConfig() };
    } else if (control.action === 'seed') {
      const patch = control.answers ? filtersFromAnswers(control.answers) : null;
      const seeded = await seedSearchConfig(patch);
      result = { version: APPLICATION_API_VERSION, created: seeded.created };
    } else if (control.action === 'company') {
      const changed = await setCompanyEnabled(control.company, control.enabled);
      result = { version: APPLICATION_API_VERSION, company: changed.name, enabled: changed.enabled };
    } else {
      const written = await updateSearchConfig(control.lists);
      result = { version: APPLICATION_API_VERSION, written };
    }

    output.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code: error?.code ?? 'SEARCH_CONTROL_PROTOCOL_ERROR',
    })}\n`);
    process.exitCode = 1;
    return null;
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
