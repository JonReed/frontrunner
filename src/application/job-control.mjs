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
  validateApplicationRequest,
} from './contract.mjs';
import { createApplicationJobManager } from './job-manager.mjs';
import { readBoundedRequest } from './run.mjs';

const JOB_ID = /^cv-\d+-[a-z0-9]+$/u;
const CONTROL_KEYS = new Set(['version', 'action', 'request', 'id']);

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
    if (value.id !== undefined) throw controlError('start does not accept an id');
    if (!value.request || typeof value.request !== 'object') {
      throw controlError('start requires an application request');
    }
    const request = validateApplicationRequest(value.request);
    if (request.operation !== 'cv.build') {
      throw controlError('job-control start supports only cv.build');
    }
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: 'start',
      request,
    });
  }
  if (value.action === 'read') {
    if (value.request !== undefined) throw controlError('read does not accept an application request');
    if (typeof value.id !== 'string' || !JOB_ID.test(value.id)) {
      throw controlError('read requires a valid job id');
    }
    return Object.freeze({
      version: APPLICATION_API_VERSION,
      action: 'read',
      id: value.id,
    });
  }
  throw controlError(`unsupported job-control action: ${String(value.action ?? '')}`);
}

export async function main({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  managerFactory = createApplicationJobManager,
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
      onOperation(operation) {
        completion = operation;
      },
    });
    const job = control.action === 'read'
      ? manager.readJob(control.id)
      : await manager.startCvBuild(
        control.request.input?.roleNum,
        control.request.input?.jobUrl,
        control.request.input?.reportPath ?? null,
      );
    output.write(`${JSON.stringify(job)}\n`);
    if (completion) await completion;
    return job;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code: error?.code ?? 'APPLICATION_JOB_PROTOCOL_ERROR',
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
if (direct) await main();
