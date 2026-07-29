/**
 * Process supervision for the local application-service boundary.
 *
 * This module owns lifecycle semantics shared by every future consumer:
 * bounded output, structured events/results, timeouts, cancellation, and a
 * fixed process specification resolved from application data.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ROOT } from '#paths';
import {
  APPLICATION_API_VERSION,
  APPLICATION_RESULT_STATUSES,
} from './contract.mjs';
import { resolveApplicationOperation } from './operations.mjs';
import {
  shouldDetachProcessTree,
  signalProcessTree,
} from './process-tree.mjs';
import {
  APPLICATION_PROGRESS_FD_ENV,
  createApplicationProgressDecoder,
} from './progress.mjs';
import { APPLICATION_RUN_ID_ENV } from './run-history.mjs';

const RESULT_STATUSES = new Set(APPLICATION_RESULT_STATUSES);
const OUTPUT_TAIL_LIMIT = 16 * 1024;
const EVENT_TEXT_LIMIT = 4 * 1024;
const TERMINATION_GRACE_MS = 2_000;
const OPERATION_WORKER = join(ROOT, 'src', 'application', 'operation-worker.mjs');

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
  const useWorker = options.useWorker ?? options.resolveOperation === undefined;
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
    let stopExitCode = null;
    let stopSignal = null;

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
      const signalled = signalProcessTree(child, 'SIGTERM', {
        platform: options.platform,
        processKill: options.processKill,
        windowsTreeKill: options.windowsTreeKill,
      });
      if (!signalled) {
        finish({ status, error: message });
        return;
      }
      forceTimer = setTimeout(() => {
        const forced = signalProcessTree(child, 'SIGKILL', {
          platform: options.platform,
          processKill: options.processKill,
          windowsTreeKill: options.windowsTreeKill,
        });
        finish({
          status,
          exitCode: stopExitCode,
          signal: forced ? 'SIGKILL' : stopSignal,
          error: message,
        });
      }, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
    };

    const abort = () => requestStop('cancelled', 'Operation cancelled.');

    try {
      const childEnvironment = {
        ...(options.env ?? process.env),
        [APPLICATION_RUN_ID_ENV]: runId,
        [APPLICATION_PROGRESS_FD_ENV]: '3',
      };
      child = spawn(
        useWorker ? process.execPath : spec.command,
        useWorker ? [options.workerPath ?? OPERATION_WORKER] : spec.args,
        {
          cwd: useWorker ? ROOT : spec.cwd,
          env: childEnvironment,
          shell: false,
          windowsHide: true,
          detached: shouldDetachProcessTree(options.platform),
          stdio: [useWorker ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      finish({ status: 'failed', error });
      return;
    }

    emit('started', { pid: Number.isSafeInteger(child.pid) ? child.pid : null });
    if (useWorker) {
      child.stdin?.once?.('error', (error) => {
        finish({ status: 'failed', error });
      });
      try {
        child.stdin.write(`${JSON.stringify(spec.request)}\n`);
      } catch (error) {
        finish({ status: 'failed', error });
        return;
      }
    }

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
    const progress = createApplicationProgressDecoder({
      onEvent(event) {
        emit('progress', {
          stage: event.stage,
          state: event.state,
          ...(event.counts ? { counts: event.counts } : {}),
        });
      },
      onWarning(error) {
        emit('progress_warning', { error: publicError(error) });
      },
    });
    const progressStream = child.stdio?.[3] ?? child.progress;
    progressStream?.on('data', chunk => progress.push(chunk));
    progressStream?.once('end', () => progress.end());
    child.once('error', (error) => {
      if (stopStatus) {
        stopMessage = `${stopMessage} ${publicError(error)}`.trim();
        return;
      }
      finish({ status: 'failed', error });
    });
    child.once('close', (exitCode, signal) => {
      if (stopStatus) {
        // The supervised parent can exit while a model/browser descendant is
        // still alive. Keep the grace timer armed so SIGKILL is sent to the
        // original process group/tree before returning a terminal result.
        stopExitCode = Number.isInteger(exitCode) ? exitCode : null;
        stopSignal = signal ?? null;
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
