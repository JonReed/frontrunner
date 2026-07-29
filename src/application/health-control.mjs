#!/usr/bin/env node

/**
 * Bounded JSON adapter for "can Frontrunner actually work right now?".
 *
 * Every AI action in this product spawns the Claude CLI. If that CLI is
 * missing or signed out, the user finds out the way they find out today: they
 * click Build my CV, wait, and get a failure. That is the worst possible
 * moment to learn it, and it is indistinguishable from the product being
 * broken.
 *
 * `claude auth status --json` answers the question directly and costs nothing
 * — no model call, no allowance. This exposes it to the UI through the same
 * boundary as every other backend operation.
 *
 * Two actions: `read` reports state, `connect` starts the CLI's own sign-in.
 *
 * `connect` was deliberately absent at first, on the grounds that starting an
 * authentication flow was not ours to do. That was wrong for this product.
 * Claude Code and the Claude desktop app keep separate credentials
 * (anthropics/claude-code#62206), so a user who installs the app, signs in and
 * uses it to set Frontrunner up still has an unauthenticated CLI — and finds
 * out when their first CV build fails. Requiring a terminal at that moment is
 * the exact failure this project says it will not ship.
 *
 * What `connect` does is narrow: spawn `claude auth login`, which opens the
 * user's own browser against Anthropic's own domain and writes to the user's
 * own keychain. Frontrunner never sees a password, a token or a callback. It
 * runs the command the user would otherwise type, because they clicked a
 * button that says so.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { APPLICATION_API_VERSION } from './contract.mjs';
import {
  shouldDetachProcessTree,
  signalProcessTree,
} from './process-tree.mjs';
import { readBoundedRequest } from './run.mjs';

const CONTROL_KEYS = new Set(['version', 'action']);
const ACTIONS = new Set(['read', 'connect']);
const TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 1_000;
const OUTPUT_LIMIT = 64 * 1024;

/** The engine every AI action in the product actually runs. */
const ENGINE = 'claude';
const ENGINE_ARGS = ['auth', 'status', '--json'];

function controlError(message, code = 'INVALID_HEALTH_REQUEST') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateHealthRequest(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw controlError('health-control request must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!CONTROL_KEYS.has(key)) throw controlError(`unsupported health-control field: ${key}`);
  }
  if (value.version !== APPLICATION_API_VERSION) {
    throw controlError(`unsupported health-control version: ${String(value.version ?? '')}`);
  }
  if (!ACTIONS.has(value.action)) {
    throw controlError(`unsupported health-control action: ${String(value.action ?? '')}`);
  }
  return Object.freeze({ version: APPLICATION_API_VERSION, action: value.action });
}

/**
 * Reduce the CLI's answer to the few fields the interface needs.
 *
 * Deliberately not a pass-through. `claude auth status` also returns orgId and
 * orgName; neither helps anyone decide anything here, and forwarding fields
 * because they happen to exist is how identifiers end up rendered in a UI
 * nobody meant to put them in.
 */
export function summariseAuth(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw controlError('the CLI returned an unexpected auth payload', 'HEALTH_UNPARSEABLE');
  }
  const text = (v, max = 120) => (typeof v === 'string' && v ? v.slice(0, max) : null);
  return {
    engine: ENGINE,
    installed: true,
    signedIn: parsed.loggedIn === true,
    account: text(parsed.email),
    plan: text(parsed.subscriptionType, 40),
    method: text(parsed.authMethod, 40),
  };
}

/** The shape returned when the CLI cannot be reached at all. */
export function notInstalled() {
  return { engine: ENGINE, installed: false, signedIn: false, account: null, plan: null, method: null };
}

export function readAuthStatus(options = {}) {
  const abortSignal = options.signal;
  if (abortSignal?.aborted) return Promise.resolve(notInstalled());
  const spawn = options.spawn ?? nodeSpawn;
  return new Promise((resolvePromise) => {
    let child;
    let settled = false;
    let stopping = false;
    let stdout = Buffer.alloc(0);
    let timer;
    let forceTimer;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      abortSignal?.removeEventListener('abort', abort);
      resolvePromise(value);
    };
    const treeOptions = {
      platform: options.platform,
      processKill: options.processKill,
      windowsTreeKill: options.windowsTreeKill,
    };
    const requestStop = () => {
      if (settled || stopping) return;
      stopping = true;
      const signalled = signalProcessTree(child, 'SIGTERM', treeOptions);
      if (!signalled) {
        finish(notInstalled());
        return;
      }
      forceTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', treeOptions);
        finish(notInstalled());
      }, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
    };
    const abort = () => requestStop();

    try {
      child = spawn(ENGINE, ENGINE_ARGS, {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        detached: shouldDetachProcessTree(options.platform),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(notInstalled());
      return;
    }

    child.stdout?.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = OUTPUT_LIMIT - stdout.length;
      if (bytes.length > remaining) {
        if (remaining > 0) stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
        requestStop();
        return;
      }
      stdout = Buffer.concat([stdout, bytes]);
    });
    // stderr is drained and discarded: a CLI that chatters on stderr while
    // still answering on stdout should not be reported as broken.
    child.stderr?.on('data', () => {});

    // ENOENT — the CLI is not installed, which is a state, not a failure.
    child.once('error', () => {
      if (!stopping) finish(notInstalled());
    });

    child.once('close', () => {
      // A direct child can exit after SIGTERM while a descendant ignores it.
      // Keep the process group owned until the forced-stop deadline.
      if (stopping) return;
      // A non-zero exit with parseable JSON still tells us what we need; some
      // versions exit non-zero precisely because the user is signed out.
      try {
        finish(summariseAuth(stdout.toString('utf8')));
      } catch {
        finish(notInstalled());
      }
    });

    if (abortSignal?.aborted) abort();
    else abortSignal?.addEventListener('abort', abort, { once: true });
    if (!settled && !stopping) {
      timer = setTimeout(requestStop, options.timeoutMs ?? TIMEOUT_MS);
    }
  });
}

/**
 * Start the CLI's own sign-in and return immediately.
 *
 * `claude auth login` is interactive: it opens a browser and waits for the
 * user to finish on Anthropic's site. Awaiting it would hang the request for
 * as long as someone takes to log in, so the child is detached and unref'd and
 * the UI polls `read` until it flips. That also means closing the tab, or
 * Next.js reloading the module, cannot orphan a half-finished login.
 *
 * Fixed argv. `--claudeai` is explicit rather than relying on it staying the
 * default, since the alternative (`--console`) puts the user on API billing
 * instead of their subscription — a wrong default here costs real money.
 */
export function startSignIn(options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  try {
    const child = spawn(ENGINE, ['auth', 'login', '--claudeai'], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.unref?.();
    return { started: true };
  } catch {
    // The CLI is not installed. The UI already reports that state, and it is
    // the reason this button should not have been offered in the first place.
    return { started: false };
  }
}

export async function main({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  readStatus = readAuthStatus,
} = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const request = validateHealthRequest(await readBoundedRequest(input));

    if (request.action === 'connect') {
      // Refuse to launch a sign-in for a CLI that is not there: the browser
      // would never open and the user would be left watching a spinner.
      const before = await readStatus({ signal: controller.signal });
      const started = before.installed ? startSignIn().started : false;
      const connectResult = { version: APPLICATION_API_VERSION, started };
      output.write(`${JSON.stringify(connectResult)}\n`);
      return connectResult;
    }

    const status = await readStatus({ signal: controller.signal });
    const result = { version: APPLICATION_API_VERSION, ...status };
    output.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    errorOutput.write(`${JSON.stringify({
      version: APPLICATION_API_VERSION,
      type: 'protocol_error',
      error: String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 1_000),
      code: error?.code ?? 'HEALTH_CONTROL_PROTOCOL_ERROR',
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
