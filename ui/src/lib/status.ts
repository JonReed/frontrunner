/**
 * status.ts — bounded UI adapter for tracker status changes.
 *
 * Same shape as jobs.ts and profile-save.ts: Turbopack stays rooted inside
 * ui/, so the UI spawns one fixed controller script and sends bounded JSON
 * over stdin. The controller validates, and the write itself goes through
 * src/tracker/set-status.mjs — the project's single canonical tracker writer.
 *
 * A move names a role number and one of five states. Undo names only the role;
 * the backend derives the previous state from its own bounded marker. Neither
 * request can name a path, a flag, or an arbitrary tracker cell.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './roles';

const STATUS_CONTROL = join(ROOT, 'src', 'application', 'status-control.mjs');
const RESPONSE_LIMIT = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 25_000;

/** States represented by honest user-observed workflow actions. */
export type UiState = 'Evaluated' | 'Applied' | 'Responded' | 'Discarded' | 'SKIP';

function controllerError(stderr: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stderr.trim()) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error.slice(0, 500);
  } catch {
    // Fall through to the bounded generic transport failure.
  }
  return fallback;
}

export function setRoleStatus(roleNum: number, state: UiState, note?: string): Promise<void> {
  return invokeStatusControl({ version: '1', action: 'set', roleNum, state, note });
}

export function restoreRoleStatus(roleNum: number): Promise<void> {
  return invokeStatusControl({ version: '1', action: 'restore', roleNum });
}

function invokeStatusControl(payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STATUS_CONTROL], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > RESPONSE_LIMIT) {
        child.kill('SIGTERM');
        fail('The tracker returned too much data.');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.once('error', (error) => fail(error.message));
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(controllerError(stderr, `The tracker did not accept the change (exit ${String(code)}).`)));
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail('The tracker did not respond in time.');
    }, RESPONSE_TIMEOUT_MS);

    child.stdin.end(JSON.stringify(payload));
  });
}
