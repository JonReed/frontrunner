/**
 * Bounded UI adapter for an exact deterministic-prefilter exception.
 *
 * The application controller re-reads the canonical rejection audit and owns
 * both user-layer writes. The browser cannot choose a file, title, company or
 * evidence string.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './roles';

const OVERRIDE_CONTROL = join(ROOT, 'src', 'application', 'prefilter-override-control.mjs');
const RESPONSE_LIMIT = 8 * 1024;
const RESPONSE_TIMEOUT_MS = 20_000;

export type PrefilterOverrideResult = {
  changed: boolean;
  role: {
    url: string;
    company: string;
    title: string;
    rule: string;
    evidence: string;
  };
};

export function allowPrefilteredRole(url: string, rule: string): Promise<PrefilterOverrideResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OVERRIDE_CONTROL], {
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
        fail('The filter override returned too much data.');
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
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stderr.trim()) as { error?: string };
          reject(new Error(parsed.error || 'That role could not be restored.'));
        } catch {
          reject(new Error('That role could not be restored.'));
        }
        return;
      }
      try {
        const value = JSON.parse(stdout.trim()) as Partial<PrefilterOverrideResult>;
        const role = value.role as Partial<PrefilterOverrideResult['role']> | undefined;
        if (
          typeof value.changed !== 'boolean'
          || !role
          || typeof role.url !== 'string'
          || typeof role.company !== 'string'
          || typeof role.title !== 'string'
          || typeof role.rule !== 'string'
          || typeof role.evidence !== 'string'
        ) {
          reject(new Error('The filter override returned an incomplete result.'));
          return;
        }
        resolve(value as PrefilterOverrideResult);
      } catch {
        reject(new Error('The filter override returned an invalid result.'));
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail('The filter override did not respond in time.');
    }, RESPONSE_TIMEOUT_MS);
    child.stdin.end(JSON.stringify({ version: '1', action: 'allow', url, rule }));
  });
}
