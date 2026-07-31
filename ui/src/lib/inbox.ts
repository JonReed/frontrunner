import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './root';

const INBOX_CONTROL = join(ROOT, 'src', 'application', 'inbox-control.mjs');
const RESPONSE_LIMIT = 8 * 1024;
const RESPONSE_TIMEOUT_MS = 20_000;

export type InboxChange = {
  changed: boolean;
  found: boolean;
  state: 'dismissed' | 'pending';
};

export type InboxAddition = {
  added: boolean;
  duplicate: boolean;
};

export function removeInboxUrl(url: string): Promise<InboxChange> {
  return changeInboxUrl('remove', url) as Promise<InboxChange>;
}

export function restoreInboxUrl(url: string): Promise<InboxChange> {
  return changeInboxUrl('restore', url) as Promise<InboxChange>;
}

/**
 * Add a job the user found themselves.
 *
 * The company and role are optional labels only — the pipeline reads the real
 * description from the URL. They exist so a pasted row is recognisable in the
 * list before anything has assessed it.
 */
export function addInboxUrl(
  url: string,
  labels: { company?: string; role?: string } = {},
): Promise<InboxAddition> {
  return changeInboxUrl('add', url, labels) as Promise<InboxAddition>;
}

function changeInboxUrl(
  action: 'remove' | 'restore' | 'add',
  url: string,
  labels: { company?: string; role?: string } = {},
): Promise<InboxChange | InboxAddition> {
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
      if (code === 0) {
        try {
          const value = JSON.parse(stdout.trim()) as Partial<InboxChange & InboxAddition>;
          // Two different result shapes over one transport, checked separately
          // so neither can be accepted with the other's fields missing.
          if (action === 'add') {
            if (typeof value.added !== 'boolean' || typeof value.duplicate !== 'boolean') {
              reject(new Error('The pending-role list returned an incomplete result.'));
              return;
            }
            resolve({ added: value.added, duplicate: value.duplicate });
            return;
          }
          if (
            typeof value.changed !== 'boolean'
            || typeof value.found !== 'boolean'
            || !['dismissed', 'pending'].includes(String(value.state))
          ) {
            reject(new Error('The pending-role list returned an incomplete result.'));
            return;
          }
          resolve(value as InboxChange);
        } catch {
          reject(new Error('The pending-role list returned an invalid result.'));
        }
      }
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
    child.stdin.end(JSON.stringify({
      version: '1',
      action,
      url,
      ...(action === 'add'
        ? { company: labels.company ?? '', role: labels.role ?? '' }
        : {}),
    }));
  });
}
