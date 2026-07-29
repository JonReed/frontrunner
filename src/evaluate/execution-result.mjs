/**
 * Closed evaluator-to-pipeline accounting channel.
 *
 * Human output remains on stdout/stderr. When the canonical pipeline supplies
 * file descriptor 3, evaluators write exactly one small JSON envelope there.
 * No job content, URL, score, report text, prompt, error, or model response is
 * permitted in this contract.
 */

import { writeSync } from 'node:fs';

export const EVALUATION_EXECUTION_RESULT_VERSION = '1';
export const EVALUATION_RESULT_FD_ENV = 'FRONTRUNNER_EVALUATION_RESULT_FD';

const STATUSES = new Set(['succeeded', 'skipped']);
const ALLOWED_KEYS = new Set(['version', 'status', 'usage', 'requestCount']);
const ALLOWED_USAGE_KEYS = new Set([
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cachedTokens',
]);
const MAX_TOKEN_COUNT = 10_000_000_000;

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_COUNT
    ? value
    : null;
}

export function normalizeEvaluatorUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const promptTokens = tokenCount(
    value.promptTokens
    ?? value.prompt_tokens
    ?? value.input_tokens
    ?? value.inputTokens,
  );
  const completionTokens = tokenCount(
    value.completionTokens
    ?? value.completion_tokens
    ?? value.output_tokens
    ?? value.outputTokens,
  );
  const explicitTotal = tokenCount(
    value.totalTokens
    ?? value.total_tokens
  );
  const cachedTokens = tokenCount(
    value.cachedTokens
    ?? value.cached_tokens
    ?? value.cache_read_input_tokens
    ?? value.cacheReadInputTokens,
  );
  if (
    promptTokens === null
    && completionTokens === null
    && explicitTotal === null
    && cachedTokens === null
  ) return undefined;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return Object.freeze({
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: explicitTotal ?? (prompt + completion),
    cachedTokens: cachedTokens ?? 0,
  });
}

export function normalizeEvaluationExecutionResult(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError('evaluation execution result must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new TypeError(`unsupported evaluation execution field: ${key}`);
    }
  }
  if (value.version !== EVALUATION_EXECUTION_RESULT_VERSION) {
    throw new TypeError('unsupported evaluation execution result version');
  }
  if (!STATUSES.has(value.status)) {
    throw new TypeError('invalid evaluation execution status');
  }
  const requestCount = tokenCount(value.requestCount);
  if (requestCount === null || requestCount > 100) {
    throw new TypeError('invalid evaluation request count');
  }
  const usage = normalizeEvaluatorUsage(value.usage);
  if (value.usage !== undefined) {
    if (!usage) throw new TypeError('invalid evaluation usage');
    for (const key of Object.keys(value.usage)) {
      if (!ALLOWED_USAGE_KEYS.has(key)) {
        throw new TypeError(`unsupported evaluation usage field: ${key}`);
      }
    }
  }
  if (value.status === 'skipped' && (requestCount !== 0 || usage)) {
    throw new TypeError('skipped evaluation cannot report model activity');
  }
  return Object.freeze({
    version: EVALUATION_EXECUTION_RESULT_VERSION,
    status: value.status,
    requestCount,
    ...(usage ? { usage } : {}),
  });
}

export function evaluationExecutionResult({
  status = 'succeeded',
  usage,
  requestCount = status === 'skipped' ? 0 : 1,
} = {}) {
  const normalizedUsage = normalizeEvaluatorUsage(usage);
  return normalizeEvaluationExecutionResult({
    version: EVALUATION_EXECUTION_RESULT_VERSION,
    status,
    requestCount,
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
  });
}

export function parseEvaluationExecutionResult(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
  if (!text.trim() || Buffer.byteLength(text) > 2_048) {
    throw new Error('missing or oversized evaluator execution result');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('evaluator execution result is not valid JSON');
  }
  return normalizeEvaluationExecutionResult(parsed);
}

export function emitEvaluationExecutionResult(value, options = {}) {
  const rawFd = options.fd ?? process.env[EVALUATION_RESULT_FD_ENV];
  if (rawFd === undefined) return false;
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd !== 3) {
    throw new Error('invalid evaluator execution result file descriptor');
  }
  const record = normalizeEvaluationExecutionResult(value);
  writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
  return true;
}
