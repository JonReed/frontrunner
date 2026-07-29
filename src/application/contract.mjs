/**
 * Versioned contract for Frontrunner's local application-service boundary.
 *
 * The UI and CLIs may choose how to present an operation, but they do not
 * choose commands, paths, flags, or working directories. This module accepts a
 * small data request and returns a normalized, frozen value for the fixed
 * operation catalog.
 */

import { isAbsolute, resolve, sep } from 'node:path';

import { DATA_DIR, REPORTS_DIR, ROOT } from '#paths';

export const APPLICATION_API_VERSION = '1';
export const APPLICATION_OPERATIONS = Object.freeze([
  'cv.build',
  'pipeline.run',
  'pipeline.prepare',
  'scan.run',
]);
export const APPLICATION_RESULT_STATUSES = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

const OPERATIONS = new Set(APPLICATION_OPERATIONS);
const ENGINES = new Set(['claude', 'openrouter', 'openai', 'gemini', 'none']);
const REQUEST_KEYS = new Set(['version', 'operation', 'input', 'idempotencyKey']);
const INPUT_KEYS = Object.freeze({
  'cv.build': new Set(['roleNum', 'jobUrl', 'reportPath', 'model']),
  'pipeline.run': new Set(['engine', 'scan', 'input']),
  'pipeline.prepare': new Set(['scan', 'input']),
  'scan.run': new Set([]),
});

function contractError(message, code = 'INVALID_APPLICATION_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw contractError(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw contractError(`${label} contains unsupported field: ${key}`);
  }
}

function boundedString(value, label, { max = 500, optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string') throw contractError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\0\r\n]/u.test(normalized)) {
    throw contractError(`${label} is empty, too long, or contains control characters`);
  }
  return normalized;
}

function containedPath(base, candidate, label) {
  const root = resolve(base);
  const file = resolve(candidate);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    throw contractError(`${label} escapes its allowed directory`);
  }
  return file;
}

function normalizeReportPath(value) {
  const raw = boundedString(value, 'input.reportPath', { max: 500, optional: true });
  if (!raw) return '';
  if (isAbsolute(raw) || raw.includes('\\')) {
    throw contractError('input.reportPath must use repository-relative separators');
  }
  const repositoryRelative = raw.startsWith('../reports/')
    ? raw.slice(3)
    : raw;
  const file = containedPath(REPORTS_DIR, resolve(ROOT, repositoryRelative), 'input.reportPath');
  if (!file.endsWith('.md')) throw contractError('input.reportPath must identify a Markdown report');
  return file.slice(ROOT.length + 1).split(sep).join('/');
}

function normalizePipelineInput(value) {
  const raw = boundedString(value, 'input.input', { max: 500, optional: true });
  if (!raw) return 'data/pipeline.md';
  if (isAbsolute(raw) || raw.includes('\\')) {
    throw contractError('input.input must use repository-relative separators');
  }
  const file = containedPath(DATA_DIR, resolve(ROOT, raw), 'input.input');
  if (!/\.(?:md|tsv)$/u.test(file)) {
    throw contractError('input.input must identify a Markdown or TSV file');
  }
  return file.slice(ROOT.length + 1).split(sep).join('/');
}

function normalizeCvBuild(input) {
  if (!Number.isSafeInteger(input.roleNum) || input.roleNum < 1 || input.roleNum > 999_999) {
    throw contractError('input.roleNum must be a positive safe tracker number');
  }
  const jobUrl = boundedString(input.jobUrl, 'input.jobUrl', { max: 2_000 });
  let parsed;
  try {
    parsed = new URL(jobUrl);
  } catch {
    throw contractError('input.jobUrl must be an absolute HTTPS URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname ||
    parsed.href.length > 2_000
  ) {
    throw contractError('input.jobUrl must be an uncredentialed absolute HTTPS URL');
  }

  const reportPath = normalizeReportPath(input.reportPath);
  const model = boundedString(input.model, 'input.model', { max: 120, optional: true });
  if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(model)) {
    throw contractError('input.model contains unsupported characters');
  }
  return Object.freeze({
    roleNum: input.roleNum,
    jobUrl: parsed.href,
    reportPath: reportPath || null,
    model: model || null,
  });
}

function normalizePipeline(operation, input) {
  const scan = input.scan === undefined ? true : input.scan;
  if (typeof scan !== 'boolean') throw contractError('input.scan must be a boolean');
  const normalized = {
    scan,
    input: normalizePipelineInput(input.input),
  };
  if (operation === 'pipeline.run') {
    const engine = boundedString(input.engine ?? 'claude', 'input.engine', { max: 30 });
    if (!ENGINES.has(engine)) throw contractError(`unsupported pipeline engine: ${engine}`);
    normalized.engine = engine;
  }
  return Object.freeze(normalized);
}

/**
 * Validate and normalize an application-service request.
 */
export function validateApplicationRequest(request) {
  plainObject(request, 'request');
  exactKeys(request, REQUEST_KEYS, 'request');
  if (request.version !== APPLICATION_API_VERSION) {
    throw contractError(
      `unsupported application API version: ${String(request.version ?? '')}`,
      'UNSUPPORTED_APPLICATION_API_VERSION',
    );
  }
  if (!OPERATIONS.has(request.operation)) {
    throw contractError(`unsupported application operation: ${String(request.operation ?? '')}`);
  }
  const input = plainObject(request.input ?? {}, 'request.input');
  exactKeys(input, INPUT_KEYS[request.operation], 'request.input');

  const idempotencyKey = boundedString(
    request.idempotencyKey,
    'request.idempotencyKey',
    { max: 120, optional: true },
  );
  if (idempotencyKey && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(idempotencyKey)) {
    throw contractError('request.idempotencyKey contains unsupported characters');
  }

  let normalizedInput;
  if (request.operation === 'cv.build') {
    normalizedInput = normalizeCvBuild(input);
  } else if (request.operation === 'pipeline.run' || request.operation === 'pipeline.prepare') {
    normalizedInput = normalizePipeline(request.operation, input);
  } else {
    normalizedInput = Object.freeze({});
  }

  return Object.freeze({
    version: APPLICATION_API_VERSION,
    operation: request.operation,
    input: normalizedInput,
    idempotencyKey: idempotencyKey || null,
  });
}
