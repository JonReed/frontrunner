/**
 * setup-draft.ts — bounded UI adapter for the unfinished setup draft.
 *
 * The draft used to live in sessionStorage, which put a CV, contact details
 * and salary expectations into browser storage in clear text — a finding
 * CodeQL raised and was right about. It now goes to disk through the same
 * bounded controller pattern as every other write, so the browser holds
 * nothing and the draft survives closing the tab rather than only a reload.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './root';

const DRAFT_CONTROL = join(ROOT, 'src', 'application', 'draft-control.mjs');
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 15_000;

function invokeDraftControl(payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRAFT_CONTROL], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    const consume = () => {
      const newline = stdout.indexOf('\n');
      if (newline < 0 || settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch {
        child.kill('SIGTERM');
        reject(new Error('The secure backend returned an invalid response.'));
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > RESPONSE_LIMIT) {
        child.kill('SIGTERM');
        fail('The secure backend returned too much data.');
        return;
      }
      consume();
    });
    child.stderr.on('data', () => {});
    child.once('error', (error) => fail(error.message));
    child.once('close', (code) => {
      consume();
      if (!settled) fail(`The secure backend stopped before responding (exit ${String(code)}).`);
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail('The secure backend did not respond in time.');
    }, RESPONSE_TIMEOUT_MS);
    child.stdin.end(JSON.stringify(payload));
  });
}

/**
 * Never throws. A missing or unreadable draft means the form starts empty,
 * which is the behaviour before any of this existed — not a reason to fail
 * the screen that replaces it.
 */
export async function readSetupDraft(): Promise<Record<string, unknown> | null> {
  try {
    const value = await invokeDraftControl({ version: '1', action: 'read' });
    const draft = (value as { draft?: unknown })?.draft;
    return draft && typeof draft === 'object' && !Array.isArray(draft)
      ? draft as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function saveSetupDraft(draft: Record<string, unknown>): Promise<boolean> {
  try {
    const value = await invokeDraftControl({ version: '1', action: 'save', draft });
    return (value as { saved?: unknown })?.saved === true;
  } catch {
    return false;
  }
}

export async function clearSetupDraft(): Promise<void> {
  try {
    await invokeDraftControl({ version: '1', action: 'clear' });
  } catch {
    // Best effort. The draft is superseded by the real profile either way.
  }
}
