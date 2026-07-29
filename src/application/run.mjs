#!/usr/bin/env node

/**
 * NDJSON/stdin adapter for the local application service.
 *
 * One JSON request is read from stdin. Lifecycle events and the final result
 * are written as NDJSON, giving non-JavaScript consumers a stable local
 * protocol without accepting arbitrary commands or shell fragments.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { executeApplicationOperation } from './service.mjs';
import {
  applicationRunHistoryRecord,
  writeRunHistory,
  writeRunHistorySafely,
} from './run-history.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;

export async function readBoundedRequest(stream = process.stdin) {
  let body = '';
  for await (const chunk of stream) {
    body += String(chunk);
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      const error = new Error(`application request exceeds ${MAX_REQUEST_BYTES} bytes`);
      error.code = 'APPLICATION_REQUEST_TOO_LARGE';
      throw error;
    }
  }
  return JSON.parse(body);
}

export async function main({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  auditWriter = null,
  execute = executeApplicationOperation,
} = {}) {
  const abortController = new AbortController();
  const cancel = () => abortController.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const request = await readBoundedRequest(input);
    let costsTokens = false;
    const result = await execute(request, {
      signal: abortController.signal,
      onEvent(event) {
        if (event.type === 'accepted') costsTokens = event.costsTokens;
        output.write(`${JSON.stringify(event)}\n`);
      },
    });
    await writeRunHistorySafely(
      auditWriter,
      applicationRunHistoryRecord(result, { costsTokens }),
      error => errorOutput.write(`${JSON.stringify({
        version: '1',
        type: 'audit_warning',
        error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 500),
      })}\n`),
    );
    if (result.status !== 'succeeded') process.exitCode = 1;
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: '1',
      type: 'protocol_error',
      error: String(error?.message ?? error).slice(0, 1_000),
      code: error?.code ?? 'APPLICATION_PROTOCOL_ERROR',
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
