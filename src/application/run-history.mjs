/**
 * Bounded, local-only operational history for backend runs.
 *
 * Records deliberately exclude request input, URLs, job descriptions, model
 * output, prompts and environment data. The file is user state, never sent
 * anywhere, and is rewritten atomically under a cross-process lock so a crash
 * or concurrent UI/CLI run cannot leave a partial record.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { mutateFileLocked } from '../lib/locked-file.mjs';
import { PIPELINE_STAGES } from './progress.mjs';

export const RUN_HISTORY_VERSION = '1';
export const APPLICATION_RUN_ID_ENV = 'FRONTRUNNER_APPLICATION_RUN_ID';
export const DEFAULT_RUN_HISTORY_FILE = join(ROOT, 'workspace', '.state', 'run-history.ndjson');
export const DEFAULT_RUN_HISTORY_RECORDS = 1_000;
export const DEFAULT_RUN_HISTORY_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_HISTORY_READ_RECORDS = 50;

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const TERMINAL_STATUS_PRIORITY = Object.freeze({
  succeeded: 0,
  failed: 1,
  cancelled: 2,
  timed_out: 2,
});
const OPERATION_RE = /^[a-z][a-z0-9.-]{0,79}$/u;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PIPELINE_STAGE_SET = new Set(PIPELINE_STAGES);

function safeInteger(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function resolveRunHistoryRunId(value, fallbackFactory) {
  if (typeof value === 'string' && RUN_ID_RE.test(value)) return value;
  if (typeof fallbackFactory !== 'function') {
    throw new TypeError('run history fallback factory must be a function');
  }
  const fallback = fallbackFactory();
  if (typeof fallback !== 'string' || !RUN_ID_RE.test(fallback)) {
    throw new TypeError('run history fallback factory returned an invalid run id');
  }
  return fallback;
}

export function redactRunHistoryText(value, limit = 500) {
  return String(value ?? '')
    .replace(/[\0\r\n\t]+/gu, ' ')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, '[redacted]')
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|secret)\b(["']?\s*[:=]\s*["']?)[^\s,;"']+/giu,
      '$1$2[redacted]',
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/giu, '$1[redacted]@')
    .slice(0, limit);
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = {
    promptTokens: safeInteger(value.promptTokens ?? value.prompt_tokens, 0),
    completionTokens: safeInteger(value.completionTokens ?? value.completion_tokens, 0),
    totalTokens: safeInteger(value.totalTokens ?? value.total_tokens, 0),
    cachedTokens: safeInteger(value.cachedTokens ?? value.cached_tokens, 0),
  };
  if (usage.totalTokens === 0) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return usage;
}

function normalizeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const counts = {};
  for (const [key, raw] of Object.entries(value).slice(0, 32)) {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/u.test(key)) continue;
    const number = safeInteger(raw);
    if (number !== null) counts[key] = number;
  }
  return Object.keys(counts).length ? counts : undefined;
}

function normalizeStages(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > PIPELINE_STAGES.length) {
    throw new TypeError('invalid run history stages');
  }
  const seen = new Set();
  return Object.freeze(value.map((stage) => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new TypeError('invalid run history stage');
    }
    if (!PIPELINE_STAGE_SET.has(stage.stage) || seen.has(stage.stage)) {
      throw new TypeError('invalid or duplicate run history stage name');
    }
    seen.add(stage.stage);
    if (!['succeeded', 'failed'].includes(stage.status)) {
      throw new TypeError('invalid run history stage status');
    }
    const startedAt = safeInteger(stage.startedAt);
    const finishedAt = safeInteger(stage.finishedAt);
    if (startedAt === null || finishedAt === null || finishedAt < startedAt) {
      throw new TypeError('invalid run history stage timestamps');
    }
    const counts = normalizeCounts(stage.counts);
    return Object.freeze({
      stage: stage.stage,
      status: stage.status,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      ...(counts ? { counts } : {}),
    });
  }));
}

export function normalizeRunHistoryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('run history record must be an object');
  }
  const operation = String(value.operation ?? '');
  const runId = String(value.runId ?? '');
  const status = String(value.status ?? '');
  if (!OPERATION_RE.test(operation)) throw new TypeError('invalid run history operation');
  if (!RUN_ID_RE.test(runId)) throw new TypeError('invalid run history run id');
  if (!TERMINAL_STATUSES.has(status)) throw new TypeError('invalid run history status');

  const startedAt = safeInteger(value.startedAt);
  const finishedAt = safeInteger(value.finishedAt);
  if (startedAt === null || finishedAt === null || finishedAt < startedAt) {
    throw new TypeError('invalid run history timestamps');
  }

  const record = {
    version: RUN_HISTORY_VERSION,
    runId,
    operation,
    status,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    costsTokens: Boolean(value.costsTokens),
  };
  const counts = normalizeCounts(value.counts);
  const usage = normalizeUsage(value.usage);
  const stages = normalizeStages(value.stages);
  const exitCode = value.exitCode === null || Number.isInteger(value.exitCode)
    ? value.exitCode
    : undefined;
  const error = value.error ? redactRunHistoryText(value.error) : '';
  if (counts) record.counts = counts;
  if (usage) record.usage = usage;
  if (stages) record.stages = stages;
  if (exitCode !== undefined) record.exitCode = exitCode;
  if (error) record.error = error;
  return Object.freeze(record);
}

function assertSafeHistoryTarget(file) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error('run history path must not be a symbolic link');
  }
}

function parseHistory(content) {
  if (!content.trim()) return [];
  return content.trimEnd().split('\n').map((line, index) => {
    try {
      return normalizeRunHistoryRecord(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid run history record at line ${String(index + 1)}: ${error.message}`);
    }
  });
}

function mergeTerminalStatus(existing, next) {
  return TERMINAL_STATUS_PRIORITY[existing] > TERMINAL_STATUS_PRIORITY[next]
    ? existing
    : next;
}

export function readRunHistory(options = {}) {
  const file = options.file ?? DEFAULT_RUN_HISTORY_FILE;
  const limit = options.limit ?? 20;
  const operation = options.operation ?? null;
  const status = options.status ?? null;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_RUN_HISTORY_READ_RECORDS
  ) {
    throw new TypeError(
      `run history read limit must be between 1 and ${String(MAX_RUN_HISTORY_READ_RECORDS)}`,
    );
  }
  if (operation !== null && (typeof operation !== 'string' || !OPERATION_RE.test(operation))) {
    throw new TypeError('invalid run history operation filter');
  }
  if (status !== null && !TERMINAL_STATUSES.has(status)) {
    throw new TypeError('invalid run history status filter');
  }
  assertSafeHistoryTarget(file);
  if (!existsSync(file)) return Object.freeze([]);
  if (lstatSync(file).size > DEFAULT_RUN_HISTORY_BYTES) {
    throw new Error('run history exceeds the maximum readable size');
  }
  const records = parseHistory(readFileSync(file, 'utf8'))
    .filter(record => operation === null || record.operation === operation)
    .filter(record => status === null || record.status === status)
    .slice(-limit)
    .reverse();
  return Object.freeze(records);
}

export async function writeRunHistory(value, options = {}) {
  const file = options.file ?? DEFAULT_RUN_HISTORY_FILE;
  const maxRecords = options.maxRecords ?? DEFAULT_RUN_HISTORY_RECORDS;
  const maxBytes = options.maxBytes ?? DEFAULT_RUN_HISTORY_BYTES;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new TypeError('maxRecords must be a positive integer');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024) {
    throw new TypeError('maxBytes must be an integer of at least 1024');
  }
  const record = normalizeRunHistoryRecord(value);

  assertSafeHistoryTarget(file);
  await mutateFileLocked(file, (content) => {
    assertSafeHistoryTarget(file);
    const records = parseHistory(content);
    const existingIndex = records.findIndex(item =>
      item.runId === record.runId && item.operation === record.operation);
    if (existingIndex >= 0) {
      const existing = records[existingIndex];
      records.splice(existingIndex, 1);
      records.push(normalizeRunHistoryRecord({
        ...existing,
        ...record,
        status: mergeTerminalStatus(existing.status, record.status),
        counts: record.counts ?? existing.counts,
        usage: record.usage ?? existing.usage,
        stages: record.stages ?? existing.stages,
      }));
    } else {
      records.push(record);
    }
    records.splice(0, Math.max(0, records.length - maxRecords));
    while (records.length > 1) {
      const serialized = `${records.map(item => JSON.stringify(item)).join('\n')}\n`;
      if (Buffer.byteLength(serialized) <= maxBytes) return serialized;
      records.shift();
    }
    const serialized = `${JSON.stringify(records[0])}\n`;
    if (Buffer.byteLength(serialized) > maxBytes) {
      throw new Error('run history record exceeds the configured byte limit');
    }
    return serialized;
  }, {
    lockOptions: options.lockOptions,
    writeOptions: {
      mode: 0o600,
      ...options.writeOptions,
    },
  });
  return record;
}

export async function writeRunHistorySafely(writer, value, onError = () => {}) {
  if (typeof writer !== 'function') return null;
  try {
    return await writer(value);
  } catch (error) {
    try {
      onError(error);
    } catch {
      // Observability must never change the operation result.
    }
    return null;
  }
}

export function applicationRunHistoryRecord(result, options = {}) {
  return normalizeRunHistoryRecord({
    runId: result.runId,
    operation: result.operation,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    costsTokens: options.costsTokens,
    usage: options.usage,
    exitCode: result.exitCode,
    error: result.error,
  });
}

export function pipelineRunHistoryRecord(result, options = {}) {
  const evaluation = result?.evaluation ?? {};
  return normalizeRunHistoryRecord({
    runId: options.runId,
    operation: options.operation ?? 'pipeline.run',
    status: options.status ?? (evaluation.failed?.length ? 'failed' : 'succeeded'),
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    costsTokens: options.costsTokens
      ?? (options.engine !== 'none' && Number(evaluation.attempted ?? 0) > 0),
    usage: evaluation.usage,
    stages: result?.stageMetrics,
    error: options.error,
    counts: {
      inputRoles: result?.inputRoles,
      descriptionHttpRequests: result?.cache?.requests,
      liveActive: result?.liveness?.active,
      liveUncertain: result?.liveness?.uncertain,
      liveExpired: result?.liveness?.expired,
      prefilterKept: result?.prefilter?.kept,
      prefilterRejected: result?.prefilter?.rejected,
      evaluationsAttempted: evaluation.attempted,
      evaluationsCompleted: evaluation.completed?.length,
      evaluationsFailed: evaluation.failed?.length,
      modelRequests: evaluation.modelRequests,
      usageReported: evaluation.usageReported,
      usageMissing: evaluation.usageMissing,
    },
  });
}
