/**
 * Process supervision for the local application-service boundary.
 *
 * This module owns lifecycle semantics shared by every future consumer:
 * bounded output, structured events/results, timeouts, cancellation, and a
 * fixed process specification resolved from application data.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  APPLICATION_API_VERSION,
  APPLICATION_RESULT_STATUSES,
} from './contract.mjs';
import { resolveApplicationOperation } from './operations.mjs';

const RESULT_STATUSES = new Set(APPLICATION_RESULT_STATUSES);
const OUTPUT_TAIL_LIMIT = 16 * 1024;
const EVENT_TEXT_LIMIT = 4 * 1024;
const TERMINATION_GRACE_MS = 2_000;

function appendTail(current, value) {
  const combined = `${current}${value}`;
  return combined.length <= OUTPUT_TAIL_LIMIT
    ? combined
    : combined.slice(-OUTPUT_TAIL_LIMIT);
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return message.replace(/[\0\r]+/gu, ' ').slice(0, 1_000);
}

/**
 * Execute one validated operation and return its terminal result envelope.
 */
export async function executeApplicationOperation(request, options = {}) {
  const resolveOperation = options.resolveOperation ?? resolveApplicationOperation;
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? (() => Date.now());
  const runId = options.runId ?? randomUUID();
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const abortSignal = options.signal;
  const spec = resolveOperation(request);
  let sequence = 0;
  let outputTail = '';

  const emit = (type, fields = {}) => {
    try {
      onEvent(Object.freeze({
        version: APPLICATION_API_VERSION,
        runId,
        sequence: sequence++,
        at: now(),
        type,
        operation: spec.request.operation,
        ...fields,
      }));
    } catch {
      // Presentation/event consumers must never take down the backend run.
    }
  };

  const startedAt = now();
  emit('accepted', {
    costsTokens: spec.costsTokens,
    dedupeKey: spec.dedupeKey,
  });

  if (abortSignal?.aborted) {
    const finishedAt = now();
    const result = Object.freeze({
      version: APPLICATION_API_VERSION,
      runId,
      operation: spec.request.operation,
      status: 'cancelled',
      startedAt,
      finishedAt,
      exitCode: null,
      signal: null,
      outputTail,
      error: 'Operation cancelled before launch.',
    });
    emit('finished', { result });
    return result;
  }

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timeout;
    let forceTimer;
    let stopStatus = null;
    let stopMessage = '';

    const finish = ({
      status,
      exitCode = null,
      signal = null,
      error = null,
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      abortSignal?.removeEventListener('abort', abort);
      if (!RESULT_STATUSES.has(status)) status = 'failed';
      const result = Object.freeze({
        version: APPLICATION_API_VERSION,
        runId,
        operation: spec.request.operation,
        status,
        startedAt,
        finishedAt: now(),
        exitCode,
        signal,
        outputTail,
        error: error ? publicError(error) : null,
      });
      emit('finished', { result });
      resolve(result);
    };

    const requestStop = (status, message) => {
      if (settled || stopStatus) return;
      stopStatus = status;
      stopMessage = message;
      emit(status === 'timed_out' ? 'timed_out' : 'cancelling');
      try {
        child?.kill('SIGTERM');
      } catch {
        finish({ status, error: message });
        return;
      }
      forceTimer = setTimeout(() => {
        try {
          child?.kill('SIGKILL');
        } catch {
          // The close/error handler or forced terminal result below wins.
        }
        finish({ status, signal: 'SIGKILL', error: message });
      }, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
    };

    const abort = () => requestStop('cancelled', 'Operation cancelled.');

    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ status: 'failed', error });
      return;
    }

    emit('started', { pid: Number.isSafeInteger(child.pid) ? child.pid : null });

    const capture = (stream) => (chunk) => {
      const text = String(chunk ?? '');
      outputTail = appendTail(outputTail, text);
      emit('output', {
        stream,
        text: text.slice(0, EVENT_TEXT_LIMIT),
        truncated: text.length > EVENT_TEXT_LIMIT,
      });
    };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));
    child.once('error', error => finish({ status: 'failed', error }));
    child.once('close', (exitCode, signal) => {
      if (stopStatus) {
        finish({
          status: stopStatus,
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          signal: signal ?? null,
          error: stopMessage,
        });
      } else {
        finish({
          status: exitCode === 0 ? 'succeeded' : 'failed',
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          signal: signal ?? null,
          error: exitCode === 0 ? null : `Backend operation exited with code ${String(exitCode)}.`,
        });
      }
    });

    if (abortSignal?.aborted) {
      abort();
    } else {
      abortSignal?.addEventListener('abort', abort, { once: true });
    }
    if (!settled) {
      timeout = setTimeout(
        () => requestStop('timed_out', `Operation exceeded its ${spec.timeoutMs}ms timeout.`),
        options.timeoutMs ?? spec.timeoutMs,
      );
    }
  });
}
