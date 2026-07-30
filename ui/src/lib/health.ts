/**
 * health.ts — can Frontrunner actually work right now?
 *
 * Same bounded adapter as jobs.ts, profile-save.ts and status.ts: one fixed
 * controller script, JSON over stdin, Turbopack stays rooted in ui/.
 *
 * Read-only and cheap — no model call, no allowance — so every screen that is
 * about to offer an AI action can ask first rather than letting the user find
 * out by waiting a minute for a failure.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './root';

const HEALTH_CONTROL = join(ROOT, 'src', 'application', 'health-control.mjs');
const RESPONSE_LIMIT = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 12_000;

export interface Health {
  engine: string;
  /** The CLI is on PATH. */
  installed: boolean;
  /** The CLI is installed AND signed in — the only state where AI actions work. */
  signedIn: boolean;
  account: string | null;
  plan: string | null;
  method: string | null;
}

const UNREACHABLE: Health = {
  engine: 'claude',
  installed: false,
  signedIn: false,
  account: null,
  plan: null,
  method: null,
};

function isHealth(value: unknown): value is Health {
  if (!value || typeof value !== 'object') return false;
  const h = value as Partial<Health>;
  return typeof h.installed === 'boolean' && typeof h.signedIn === 'boolean';
}

/**
 * Cache the good news, never the bad.
 *
 * Checking spawns a process that spawns the Claude CLI: ~200ms on every page
 * load, for a fact that changes about twice in a user's lifetime — once at
 * setup and once if a token ever expires. Measured before caching: pages with
 * the check served in 219ms against 51ms for a page without it.
 *
 * The asymmetry is deliberate. A connected result is cached, because it is the
 * state someone spends months in and re-checking it constantly buys nothing.
 * A disconnected result is NOT cached, because the copy tells the user to sign
 * in and reload — and a cache that made them wait 60 seconds to see their own
 * fix take effect would be worse than the delay it saved.
 */
const CACHE_MS = 60_000;
let cached: { at: number; value: Health } | null = null;

export function readHealth(): Promise<Health> {
  if (cached && cached.value.signedIn && Date.now() - cached.at < CACHE_MS) {
    return Promise.resolve(cached.value);
  }
  return readHealthUncached().then((value) => {
    cached = { at: Date.now(), value };
    return value;
  });
}

/**
 * Never throws. A page that cannot determine health renders as "not connected"
 * rather than 500 — the whole point is to still work when the engine does not.
 */
function readHealthUncached(): Promise<Health> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Health) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child;
    try {
      child = spawn(process.execPath, [HEALTH_CONTROL], {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      done(UNREACHABLE);
      return;
    }

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > RESPONSE_LIMIT) {
        child.kill('SIGTERM');
        done(UNREACHABLE);
      }
    });
    child.stderr.on('data', () => {});
    child.once('error', () => done(UNREACHABLE));
    child.once('close', () => {
      try {
        const parsed: unknown = JSON.parse(stdout.split('\n')[0] ?? '');
        done(isHealth(parsed) ? parsed : UNREACHABLE);
      } catch {
        done(UNREACHABLE);
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(UNREACHABLE);
    }, RESPONSE_TIMEOUT_MS);

    child.stdin.end(JSON.stringify({ version: '1', action: 'read' }));
  });
}

/**
 * Ask the backend to start `claude auth login`.
 *
 * Returns as soon as the CLI has been launched — the browser flow that follows
 * belongs to the user and takes as long as it takes. Callers poll readHealth()
 * for the result rather than waiting on this.
 */
export function startConnect(): Promise<{ started: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [HEALTH_CONTROL], {
        cwd: ROOT, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ started: false });
      return;
    }
    let stdout = '';
    const done = (v: { started: boolean }) => { clearTimeout(timer); resolve(v); };
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString().slice(0, 4096); });
    child.stderr.on('data', () => {});
    child.once('error', () => done({ started: false }));
    child.once('close', () => {
      try {
        const parsed = JSON.parse(stdout.split('\n')[0] ?? '') as { started?: unknown };
        done({ started: parsed.started === true });
      } catch {
        done({ started: false });
      }
    });
    const timer = setTimeout(() => { child.kill('SIGTERM'); done({ started: false }); }, RESPONSE_TIMEOUT_MS);
    child.stdin.end(JSON.stringify({ version: '1', action: 'connect' }));
  });
}

/** Force the next readHealth() to re-check, used right after a sign-in attempt. */
export function invalidateHealth(): void {
  cached = null;
}
