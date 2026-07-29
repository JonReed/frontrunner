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
 * READ ONLY. There is deliberately no sign-in action here. `claude auth login`
 * is an interactive browser flow that belongs to the user and their terminal,
 * and a local web page spawning an authentication flow on their behalf is not
 * a thing this project should do. The UI reports state and says what to run.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { APPLICATION_API_VERSION } from './contract.mjs';
import { readBoundedRequest } from './run.mjs';

const CONTROL_KEYS = new Set(['version', 'action']);
const TIMEOUT_MS = 10_000;
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
  if (value.action !== 'read') {
    throw controlError(`unsupported health-control action: ${String(value.action ?? '')}`);
  }
  return Object.freeze({ version: APPLICATION_API_VERSION, action: 'read' });
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
  const spawn = options.spawn ?? nodeSpawn;
  return new Promise((resolvePromise) => {
    let child;
    let settled = false;
    let stdout = '';
    let timer;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    try {
      child = spawn(ENGINE, ENGINE_ARGS, {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(notInstalled());
      return;
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > OUTPUT_LIMIT) {
        stdout = stdout.slice(0, OUTPUT_LIMIT);
        child.kill('SIGTERM');
      }
    });
    // stderr is drained and discarded: a CLI that chatters on stderr while
    // still answering on stdout should not be reported as broken.
    child.stderr?.on('data', () => {});

    // ENOENT — the CLI is not installed, which is a state, not a failure.
    child.once('error', () => finish(notInstalled()));

    child.once('close', () => {
      // A non-zero exit with parseable JSON still tells us what we need; some
      // versions exit non-zero precisely because the user is signed out.
      try {
        finish(summariseAuth(stdout));
      } catch {
        finish(notInstalled());
      }
    });

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(notInstalled());
    }, options.timeoutMs ?? TIMEOUT_MS);
  });
}

export async function main({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  try {
    validateHealthRequest(await readBoundedRequest(input));
    const status = await readAuthStatus();
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
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
