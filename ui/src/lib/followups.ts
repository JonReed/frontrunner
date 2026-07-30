/**
 * Read-only, bounded UI adapter for the canonical follow-up cadence.
 *
 * The browser never selects a script, path or flag. This server-only module
 * launches one fixed analysis command and returns only the small scheduling
 * fields the interface needs; contacts and tracker notes are deliberately not
 * forwarded to client components.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './root';

const FOLLOWUP_CADENCE = join(ROOT, 'src', 'tracker', 'followup-cadence.mjs');
const OUTPUT_LIMIT = 512 * 1024;
const TIMEOUT_MS = 12_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type FollowupUrgency = 'urgent' | 'overdue' | 'waiting' | 'cold';

export interface Followup {
  num: number;
  status: 'applied' | 'responded' | 'interview';
  urgency: FollowupUrgency;
  nextFollowupDate: string | null;
  daysUntilNext: number | null;
  followupCount: number;
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function parseFollowup(value: unknown): Followup | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<Followup>;
  if (
    !boundedInteger(entry.num, 1, 999_999)
    || !['applied', 'responded', 'interview'].includes(String(entry.status))
    || !['urgent', 'overdue', 'waiting', 'cold'].includes(String(entry.urgency))
    || !boundedInteger(entry.followupCount, 0, 10_000)
    || (
      entry.nextFollowupDate !== null
      && (typeof entry.nextFollowupDate !== 'string' || !DATE_RE.test(entry.nextFollowupDate))
    )
    || (
      entry.daysUntilNext !== null
      && !boundedInteger(entry.daysUntilNext, -100_000, 100_000)
    )
  ) return null;
  return {
    num: entry.num,
    status: entry.status as Followup['status'],
    urgency: entry.urgency as FollowupUrgency,
    nextFollowupDate: entry.nextFollowupDate,
    daysUntilNext: entry.daysUntilNext,
    followupCount: entry.followupCount,
  };
}

export function readFollowups(): Promise<Followup[]> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (entries: Followup[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(entries);
    };
    let child;
    try {
      child = spawn(process.execPath, [FOLLOWUP_CADENCE], {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      done([]);
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > OUTPUT_LIMIT) {
        child.kill('SIGTERM');
        done([]);
      }
    });
    child.once('error', () => done([]));
    child.once('close', (code) => {
      if (code !== 0) {
        done([]);
        return;
      }
      try {
        const value = JSON.parse(stdout) as { entries?: unknown };
        if (!Array.isArray(value.entries) || value.entries.length > 500) {
          done([]);
          return;
        }
        done(value.entries.map(parseFollowup).filter((entry): entry is Followup => entry !== null));
      } catch {
        done([]);
      }
    });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      done([]);
    }, TIMEOUT_MS);
  });
}
