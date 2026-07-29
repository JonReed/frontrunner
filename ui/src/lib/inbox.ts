import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './roles';

const INBOX_CONTROL = join(ROOT, 'src', 'application', 'inbox-control.mjs');
const RESPONSE_LIMIT = 8 * 1024;
const RESPONSE_TIMEOUT_MS = 20_000;

export function removeInboxUrl(url: string): Promise<void> {
  return changeInboxUrl('remove', url);
}

export function restoreInboxUrl(url: string): Promise<void> {
  return changeInboxUrl('restore', url);
}

function changeInboxUrl(action: 'remove' | 'restore', url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INBOX_CONTROL], {
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
      if (Buffer.byteLength(stdout) > RESPONSE_LIMIT) {
        child.kill('SIGTERM');
        fail('The pending-role list returned too much data.');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_048);
    });
    child.once('error', (error) => fail(error.message));
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        try {
          const parsed = JSON.parse(stderr.trim()) as { error?: string };
          reject(new Error(parsed.error || 'The pending role could not be removed.'));
        } catch {
          reject(new Error('The pending role could not be removed.'));
        }
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail('The pending-role list did not respond in time.');
    }, RESPONSE_TIMEOUT_MS);
    child.stdin.end(JSON.stringify({ version: '1', action, url }));
  });
}
