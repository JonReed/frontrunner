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
import { ROOT } from './root';

const STATUS_CONTROL = join(ROOT, 'src', 'application', 'status-control.mjs');
const RESPONSE_LIMIT = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 25_000;

/** States represented by honest user-observed workflow actions. */
export type UiState =
  | 'Evaluated'
  | 'Applied'
  | 'Responded'
  | 'Interview'
  | 'Offer'
  | 'Hired'
  | 'Rejected'
  | 'Discarded'
  | 'SKIP';
export type WorkflowHandle = {
  revision: string;
  undoToken: string;
  followupPending: boolean;
};

function controllerError(stderr: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stderr.trim()) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error.slice(0, 500);
  } catch {
    // Fall through to the bounded generic transport failure.
  }
  return fallback;
}

export function setRoleStatus(
  roleNum: number,
  state: UiState,
  note: string,
  expectedRevision: string,
  undoToken: string,
): Promise<WorkflowHandle> {
  return invokeStatusControl({
    version: '1',
    action: 'set',
    roleNum,
    state,
    note,
    expectedRevision,
    undoToken,
  });
}

export function restoreRoleStatus(
  roleNum: number,
  handle: WorkflowHandle,
): Promise<WorkflowHandle> {
  return invokeStatusControl({
    version: '1',
    action: 'restore',
    roleNum,
    expectedRevision: handle.revision,
    undoToken: handle.undoToken,
  });
}

function invokeStatusControl(payload: object): Promise<WorkflowHandle> {
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
      if (code === 0) {
        try {
          const value = JSON.parse(stdout.trim()) as {
            revision?: unknown;
            undoToken?: unknown;
            followup?: { pending?: unknown };
          };
          if (
            typeof value.revision !== 'string'
            || !/^[a-f0-9]{64}$/.test(value.revision)
            || typeof value.undoToken !== 'string'
            || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.undoToken)
          ) {
            reject(new Error('The tracker returned an incomplete workflow result.'));
            return;
          }
          resolve({
            revision: value.revision,
            undoToken: value.undoToken,
            followupPending: value.followup?.pending === true,
          });
        } catch {
          reject(new Error('The tracker returned an invalid workflow result.'));
        }
      } else reject(new Error(controllerError(stderr, `The tracker did not accept the change (exit ${String(code)}).`)));
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail('The tracker did not respond in time.');
    }, RESPONSE_TIMEOUT_MS);

    child.stdin.end(JSON.stringify(payload));
  });
}
