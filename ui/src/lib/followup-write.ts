/**
 * followup-write.ts — bounded UI adapter for recording follow-ups.
 *
 * Read-only follow-up data comes from followups.ts, which runs the analysis
 * command. This is the write side, and it goes through the application
 * controller like every other mutation: the browser names an application
 * number and what happened, never a file.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './root';

const FOLLOWUP_CONTROL = join(ROOT, 'src', 'application', 'followup-control.mjs');
const RESPONSE_LIMIT = 16 * 1024;
const RESPONSE_TIMEOUT_MS = 15_000;

export type FollowupChannel = 'Email' | 'LinkedIn' | 'Phone' | 'Portal' | 'Other';

function controllerError(stderr: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stderr.trim()) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error.slice(0, 1_000);
  } catch {
    // Fall through to the bounded generic transport failure.
  }
  return fallback;
}

function invokeFollowupControl(payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FOLLOWUP_CONTROL], {
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
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_096);
    });
    child.once('error', (error) => fail(error.message));
    child.once('close', (code) => {
      consume();
      if (!settled) {
        fail(controllerError(
          stderr,
          `The secure backend stopped before responding (exit ${String(code)}).`,
        ));
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail('The secure backend did not respond in time.');
    }, RESPONSE_TIMEOUT_MS);
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function logFollowup(
  appNum: number,
  channel: FollowupChannel,
  note: string,
): Promise<{ date: string }> {
  const value = await invokeFollowupControl({
    version: '1',
    action: 'log',
    appNum,
    channel,
    note,
  });
  const date = (value as { date?: unknown })?.date;
  return { date: typeof date === 'string' ? date : '' };
}

export async function snoozeFollowup(appNum: number, date: string): Promise<{ date: string }> {
  const value = await invokeFollowupControl({
    version: '1',
    action: 'snooze',
    appNum,
    date,
  });
  const written = (value as { date?: unknown })?.date;
  return { date: typeof written === 'string' ? written : date };
}
