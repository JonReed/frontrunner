#!/usr/bin/env node

/**
 * Bounded JSON adapter between isolated local interfaces and the profile writer.
 *
 * Same contract as job-control.mjs: the UI starts this one fixed script and
 * sends a bounded JSON request on stdin. Request data can never select an
 * executable, a script, a working directory or a flag — and here it can never
 * select a file path either. The action names a known operation; the writer
 * decides where anything lands.
 *
 * Turbopack stays rooted inside ui/, so no backend module is bundled into
 * Next.js. This process boundary is what keeps that true.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { APPLICATION_API_VERSION } from './contract.mjs';
import { readBoundedRequest } from './run.mjs';
import {
  readProfileFields,
  WRITABLE_FIELDS,
} from './profile-write.mjs';
import {
  publishProfileSave,
  recoverProfileSave,
} from './profile-transaction.mjs';

const CONTROL_KEYS = new Set(['version', 'action', 'fields', 'cv', 'versions']);
const ACTIONS = new Set(['read', 'save']);
const MAX_VERSIONS = 20;

function controlError(message, code = 'INVALID_PROFILE_CONTROL_REQUEST') {
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

export function validateProfileControlRequest(value) {
  if (!plainObject(value)) throw controlError('profile-control request must be a plain object');
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported profile-control field: ${key}`);
  }
  if (value.version !== APPLICATION_API_VERSION) {
    throw controlError(`unsupported profile-control version: ${String(value.version ?? '')}`);
  }
  if (!ACTIONS.has(value.action)) {
    throw controlError(`unsupported profile-control action: ${String(value.action ?? '')}`);
  }

  if (value.action === 'read') {
    for (const key of ['fields', 'cv', 'versions']) {
      if (value[key] !== undefined) throw controlError(`read does not accept ${key}`);
    }
    return Object.freeze({ version: APPLICATION_API_VERSION, action: 'read' });
  }

  const fields = value.fields ?? {};
  if (!plainObject(fields)) throw controlError('fields must be a plain object');
  // Rejected here as well as in the writer. This is the process boundary the
  // browser talks to, so it should never forward a field name it does not
  // recognise, even to a module that would also refuse it.
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(WRITABLE_FIELDS, key)) {
      throw controlError(`unsupported profile field: ${key}`, 'FIELD_NOT_WRITABLE');
    }
  }

  if (value.cv !== undefined && typeof value.cv !== 'string') {
    throw controlError('cv must be a string');
  }

  const versions = value.versions ?? [];
  if (!Array.isArray(versions)) throw controlError('versions must be an array');
  if (versions.length > MAX_VERSIONS) throw controlError('too many CV versions');
  for (const entry of versions) {
    if (!plainObject(entry)) throw controlError('each CV version must be a plain object');
    for (const key of Object.keys(entry)) {
      if (key !== 'label' && key !== 'text') throw controlError(`unsupported version field: ${key}`);
    }
    if (typeof entry.text !== 'string') throw controlError('each CV version needs text');
    if (entry.label !== undefined && typeof entry.label !== 'string') {
      throw controlError('a CV version label must be a string');
    }
  }

  if (Object.keys(fields).length === 0 && value.cv === undefined && versions.length === 0) {
    throw controlError('save must change something');
  }

  return Object.freeze({
    version: APPLICATION_API_VERSION,
    action: 'save',
    fields: Object.freeze({ ...fields }),
    cv: value.cv,
    versions: Object.freeze(versions.map(v => Object.freeze({ ...v }))),
  });
}

export async function main({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  try {
    const control = validateProfileControlRequest(await readBoundedRequest(input));

    if (control.action === 'read') {
      await recoverProfileSave();
      const result = { version: APPLICATION_API_VERSION, fields: readProfileFields() };
      output.write(`${JSON.stringify(result)}\n`);
      return result;
    }

    await publishProfileSave(control);
    const written = [
      ...(typeof control.cv === 'string' ? ['cv.md'] : []),
      ...control.versions.map((_version, index) => `cv-versions/${index + 1}`),
      ...Object.keys(control.fields),
    ];

    const result = { version: APPLICATION_API_VERSION, written };
    output.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code: error?.code ?? 'PROFILE_CONTROL_PROTOCOL_ERROR',
    })}\n`);
    process.exitCode = 1;
    return null;
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
