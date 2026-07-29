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
import { ROOT } from './roles';

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
 * Never throws.
 *
 * A page that cannot determine health should render as "not connected" rather
 * than 500. The whole point is to be the thing that still works when the
 * engine does not.
 */
export function readHealth(): Promise<Health> {
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
