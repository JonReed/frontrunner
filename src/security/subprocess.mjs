/**
 * Canonical bounded subprocess boundary for backend runtime code.
 *
 * Callers choose a fixed executable and argv; this module owns the mechanics:
 * no shell, bounded input/output, timeout/cancellation, detached process-group
 * supervision, and whole-tree TERM/KILL cleanup.
 */

import { spawn as nodeSpawn } from 'node:child_process';

import {
  shouldDetachProcessTree,
  signalProcessTree,
} from '../application/process-tree.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_INPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const MAX_ARG_COUNT = 512;
const MAX_ARG_BYTES = 1024 * 1024;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function invocation(command, args) {
  if (typeof command !== 'string' || !command || command.includes('\0')) {
    throw new TypeError('subprocess command must be a non-empty NUL-free string');
  }
  if (!Array.isArray(args) || args.length > MAX_ARG_COUNT) {
    throw new TypeError(`subprocess args must contain at most ${MAX_ARG_COUNT} entries`);
  }
  let bytes = 0;
  const normalized = args.map((arg) => {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new TypeError('subprocess arguments must be NUL-free strings');
    }
    bytes += Buffer.byteLength(arg);
    return arg;
  });
  if (bytes > MAX_ARG_BYTES) throw new TypeError('subprocess arguments are too large');
  return { command, args: normalized };
}

function appendBounded(chunks, chunk, state, limit) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.bytes += value.byteLength;
  if (state.bytes > limit) return false;
  chunks.push(value);
  return true;
}

function publicError(message) {
  return String(message ?? 'subprocess failed')
    .replace(/[\0\r\n]+/gu, ' ')
    .slice(0, 1_000);
}

export class SubprocessFailure extends Error {
  constructor(message, result) {
    super(message);
    this.name = 'SubprocessFailure';
    this.code = result.code;
    this.result = result;
  }
}

/**
 * Run a child and return a bounded immutable result. Non-zero exits are
 * represented in the result; launch, timeout, cancellation and output-limit
 * failures reject with SubprocessFailure after the process tree is reaped.
 */
export function runBoundedSubprocess(command, args = [], options = {}) {
  const spec = invocation(command, args);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'subprocess timeout');
  const maxStdoutBytes = positiveInteger(
    options.maxStdoutBytes ?? DEFAULT_OUTPUT_BYTES,
    'subprocess stdout limit',
  );
  const maxStderrBytes = positiveInteger(
    options.maxStderrBytes ?? DEFAULT_OUTPUT_BYTES,
    'subprocess stderr limit',
  );
  const maxInputBytes = positiveInteger(
    options.maxInputBytes ?? DEFAULT_INPUT_BYTES,
    'subprocess input limit',
  );
  const terminationGraceMs = positiveInteger(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    'subprocess termination grace',
  );
  const extraPipes = options.extraPipes ?? 0;
  if (!Number.isSafeInteger(extraPipes) || extraPipes < 0 || extraPipes > 4) {
    throw new TypeError('subprocess extraPipes must be an integer from 0 to 4');
  }
  const input = options.input === undefined || options.input === null
    ? null
    : Buffer.isBuffer(options.input)
      ? options.input
      : Buffer.from(String(options.input));
  if (input && input.byteLength > maxInputBytes) {
    throw new SubprocessFailure('subprocess input exceeds the configured limit', Object.freeze({
      code: 'SUBPROCESS_INPUT_LIMIT',
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      extraOutput: Object.freeze([]),
    }));
  }
  const spawn = options.spawn ?? nodeSpawn;
  const abortSignal = options.signal;
  if (abortSignal?.aborted) {
    return Promise.reject(new SubprocessFailure('subprocess cancelled before launch', Object.freeze({
      code: 'SUBPROCESS_CANCELLED',
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      extraOutput: Object.freeze([]),
    })));
  }

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stop = null;
    let timeout;
    let forceTimer;
    let closeStatus = null;
    let closeSignal = null;
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    const extraChunks = Array.from({ length: extraPipes }, () => []);
    const extraStates = Array.from({ length: extraPipes }, () => ({ bytes: 0 }));

    const result = (code = null) => Object.freeze({
      code,
      status: Number.isInteger(closeStatus) ? closeStatus : null,
      signal: closeSignal ?? null,
      stdout: Buffer.concat(stdoutChunks).toString(options.encoding ?? 'utf8'),
      stderr: Buffer.concat(stderrChunks).toString(options.encoding ?? 'utf8'),
      extraOutput: Object.freeze(extraChunks.map(chunks => Buffer.concat(chunks))),
    });

    const finish = (errorCode = null, message = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      abortSignal?.removeEventListener('abort', abort);
      const output = result(errorCode);
      if (errorCode) reject(new SubprocessFailure(publicError(message), output));
      else resolve(output);
    };

    const requestStop = (code, message) => {
      if (settled || stop) return;
      stop = { code, message };
      signalProcessTree(child, 'SIGTERM', options);
      forceTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', options);
        finish(code, message);
      }, terminationGraceMs);
      forceTimer.unref?.();
    };
    const abort = () => requestStop('SUBPROCESS_CANCELLED', 'subprocess cancelled');

    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: shouldDetachProcessTree(options.platform),
        stdio: ['pipe', 'pipe', 'pipe', ...Array(extraPipes).fill('pipe')],
      });
    } catch (error) {
      finish('SUBPROCESS_LAUNCH_FAILED', error?.message);
      return;
    }

    const capture = (chunks, state, limit, callback, label) => (chunk) => {
      if (settled) return;
      if (!appendBounded(chunks, chunk, state, limit)) {
        requestStop('SUBPROCESS_OUTPUT_LIMIT', `${label} exceeds ${limit} bytes`);
        return;
      }
      try {
        callback?.(chunk);
      } catch {
        // Observers cannot affect the child lifecycle.
      }
    };
    child.stdout?.on('data', capture(
      stdoutChunks,
      stdoutState,
      maxStdoutBytes,
      options.onStdout,
      'subprocess stdout',
    ));
    child.stderr?.on('data', capture(
      stderrChunks,
      stderrState,
      maxStderrBytes,
      options.onStderr,
      'subprocess stderr',
    ));
    for (let index = 0; index < extraPipes; index++) {
      child.stdio?.[index + 3]?.on('data', capture(
        extraChunks[index],
        extraStates[index],
        maxStdoutBytes,
        options.onExtraOutput?.[index],
        `subprocess fd ${index + 3}`,
      ));
    }
    child.once('error', (error) => {
      if (stop) return;
      finish('SUBPROCESS_LAUNCH_FAILED', error?.message);
    });
    child.once('close', (status, signal) => {
      closeStatus = status;
      closeSignal = signal;
      if (stop) {
        // Keep the grace timer alive: descendants may remain after their
        // immediate parent closes.
        return;
      }
      finish();
    });

    if (input) {
      child.stdin?.once?.('error', (error) => {
        if (!stop) requestStop('SUBPROCESS_STDIN_FAILED', error?.message);
      });
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
    if (!settled) {
      timeout = setTimeout(
        () => requestStop('SUBPROCESS_TIMEOUT', `subprocess timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
      timeout.unref?.();
    }
    abortSignal?.addEventListener('abort', abort, { once: true });
  });
}

export async function runCheckedSubprocess(command, args = [], options = {}) {
  const result = await runBoundedSubprocess(command, args, options);
  if (result.status !== 0) {
    const detail = result.stderr.trim().slice(-500);
    throw new SubprocessFailure(
      `${command} exited ${String(result.status)}${detail ? `: ${detail}` : ''}`,
      Object.freeze({ ...result, code: 'SUBPROCESS_EXIT_NONZERO' }),
    );
  }
  return result;
}
