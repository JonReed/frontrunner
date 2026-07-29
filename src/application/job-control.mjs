#!/usr/bin/env node

/**
 * Bounded JSON adapter between isolated local interfaces and the persistent
 * application job manager.
 *
 * The UI starts this one fixed script; request data can never select an
 * executable, script, working directory, or flag. A start process remains
 * alive while its supervised backend child runs, so UI module reloads do not
 * orphan lifecycle state.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  APPLICATION_API_VERSION,
  APPLICATION_OPERATIONS,
  validateApplicationRequest,
} from './contract.mjs';
import {
  ApplicationOperationBusyError,
  APPLICATION_JOB_ID_RE,
  createApplicationJobManager,
} from './job-manager.mjs';
import { readBoundedRequest } from './run.mjs';
import {
  MAX_RUN_HISTORY_READ_RECORDS,
  readRunHistory,
  writeRunHistory,
} from './run-history.mjs';

const CONTROL_KEYS = new Set([
  'version',
  'action',
  'request',
  'id',
  'limit',
  'operation',
  'status',
]);
const JOB_LIST_STATUSES = new Set(['running', 'done', 'failed']);
const HISTORY_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const OPERATIONS = new Set(APPLICATION_OPERATIONS);

function controlError(message) {
  const error = new Error(message);
  error.code = 'INVALID_APPLICATION_JOB_REQUEST';
  return error;
}

export function validateJobControlRequest(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw controlError('job-control request must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported job-control field: ${key}`);
  }
  if (value.version !== APPLICATION_API_VERSION) {
    throw controlError(`unsupported job-control version: ${String(value.version ?? '')}`);
  }
  if (value.action === 'start') {
    if (
      value.id !== undefined
      || value.limit !== undefined
      || value.operation !== undefined
      || value.status !== undefined
    ) {
      throw controlError('start accepts only an application request');
    }
    if (!value.request || typeof value.request !== 'object') {
      throw controlError('start requires an application request');
    }
    const request = validateApplicationRequest(value.request);
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: 'start',
      request,
    });
  }
  if (value.action === 'read' || value.action === 'cancel') {
    if (
      value.request !== undefined
      || value.limit !== undefined
      || value.operation !== undefined
      || value.status !== undefined
    ) {
      throw controlError(`${value.action} accepts only a job id`);
    }
    if (typeof value.id !== 'string' || !APPLICATION_JOB_ID_RE.test(value.id)) {
      throw controlError(`${value.action} requires a valid job id`);
    }
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: value.action,
      id: value.id,
    });
  }
  if (value.action === 'list' || value.action === 'history') {
    if (value.request !== undefined || value.id !== undefined) {
      throw controlError(`${value.action} does not accept a request or job id`);
    }
    const limit = value.limit ?? 20;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_RUN_HISTORY_READ_RECORDS
    ) {
      throw controlError(
        `${value.action} limit must be between 1 and ${String(MAX_RUN_HISTORY_READ_RECORDS)}`,
      );
    }
    const operation = value.operation ?? null;
    if (operation !== null && !OPERATIONS.has(operation)) {
      throw controlError(`${value.action} has an unsupported operation filter`);
    }
    const statuses = value.action === 'list' ? JOB_LIST_STATUSES : HISTORY_STATUSES;
    const status = value.status ?? null;
    if (status !== null && !statuses.has(status)) {
      throw controlError(`${value.action} has an unsupported status filter`);
    }
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: value.action,
      limit,
      operation,
      status,
    });
  }
  throw controlError(`unsupported job-control action: ${String(value.action ?? '')}`);
}

export function summarizeApplicationJob(job) {
  const operation = APPLICATION_OPERATIONS.includes(job?.operation)
    ? job.operation
    : job?.kind === 'build-cv'
      ? 'cv.build'
      : undefined;
  return Object.freeze({
    id: job.id,
    ...(operation ? { operation } : {}),
    kind: job.kind,
    ...(Number.isSafeInteger(job.roleNum) ? { roleNum: job.roleNum } : {}),
    status: job.status,
    ...(typeof job.stage === 'string' ? { stage: job.stage } : {}),
    startedAt: job.startedAt,
    ...(Number.isSafeInteger(job.finishedAt) ? { finishedAt: job.finishedAt } : {}),
    ...(Number.isInteger(job.exitCode) ? { exitCode: job.exitCode } : {}),
    costsTokens: Boolean(job.costsTokens),
  });
}

export async function main({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  managerFactory = createApplicationJobManager,
  auditWriter = null,
  historyReader = readRunHistory,
} = {}) {
  const controller = new AbortController();
  let completion = null;
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const control = validateJobControlRequest(await readBoundedRequest(input));
    const manager = managerFactory({
      signal: controller.signal,
      auditWriter,
      onOperation(operation) {
        completion = operation;
      },
    });
    let response;
    if (control.action === 'read') {
      response = await manager.readJob(control.id);
    } else if (control.action === 'cancel') {
      response = await manager.cancelJob(control.id);
    } else if (control.action === 'list') {
      if (typeof manager.pruneJobsSafely === 'function') {
        await manager.pruneJobsSafely();
      }
      const jobs = (await manager.listJobs())
        .map(summarizeApplicationJob)
        .filter(job => control.operation === null || job.operation === control.operation)
        .filter(job => control.status === null || job.status === control.status)
        .slice(0, control.limit);
      response = Object.freeze({
        version: APPLICATION_API_VERSION,
        action: 'list',
        jobs: Object.freeze(jobs),
      });
    } else if (control.action === 'history') {
      response = Object.freeze({
        version: APPLICATION_API_VERSION,
        action: 'history',
        records: historyReader({
          limit: control.limit,
          operation: control.operation,
          status: control.status,
        }),
      });
    } else {
      response = await manager.start(control.request);
    }
    output.write(`${JSON.stringify(response)}\n`);
    if (completion) await completion;
    return response;
  } catch (error) {
    const busy = error instanceof ApplicationOperationBusyError;
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: busy ? 'operation_busy' : 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code: error?.code ?? 'APPLICATION_JOB_PROTOCOL_ERROR',
      ...(busy ? {
        requestedOperation: error.requestedOperation,
        activeJob: error.activeJob,
      } : {}),
    })}\n`);
    process.exitCode = 1;
    return null;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main({ auditWriter: writeRunHistory });
