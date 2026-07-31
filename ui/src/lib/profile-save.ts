/**
 * profile-save.ts — bounded UI adapter for the profile writer.
 *
 * Same shape as jobs.ts and for the same reason: Turbopack stays rooted inside
 * ui/, so no backend module is bundled into Next.js. The UI starts one fixed
 * controller script and sends bounded JSON over stdin. The controller and the
 * writer beneath it own validation, the writable-field allowlist, file
 * locations and locked atomic writes.
 *
 * Nothing here decides where anything is written. A request names fields; it
 * can never name a path.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './root';

const PROFILE_CONTROL = join(ROOT, 'src', 'application', 'profile-control.mjs');
const RESPONSE_LIMIT = 256 * 1024;
const RESPONSE_TIMEOUT_MS = 15_000;

export interface ProfileSave {
  fields?: Record<string, string | string[]>;
  cv?: string;
  versions?: { label?: string; text: string }[];
}

export interface CvVersionSummary {
  name: string;
  bytes: number;
  words: number | null;
}

export interface ProfileSnapshot {
  fields: Record<string, string | string[]>;
  versions: CvVersionSummary[];
}

function controllerError(stderr: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stderr.trim()) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error.slice(0, 1_000);
  } catch {
    // Fall through to the bounded generic transport failure.
  }
  return fallback;
}

function invokeProfileControl(payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROFILE_CONTROL], {
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

/** Fields currently on disk, for populating an edit form. */
export async function readProfile(): Promise<Record<string, string | string[]>> {
  return (await readProfileSnapshot()).fields;
}

export async function readProfileSnapshot(): Promise<ProfileSnapshot> {
  const value = await invokeProfileControl({ version: '1', action: 'read' });
  const fields = (value as { fields?: unknown })?.fields;
  const versions = (value as { versions?: unknown })?.versions;
  return {
    fields: fields && typeof fields === 'object' && !Array.isArray(fields)
      ? (fields as Record<string, string | string[]>)
      : {},
    versions: Array.isArray(versions)
      ? versions.filter((item): item is CvVersionSummary => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const record = item as Record<string, unknown>;
        return typeof record.name === 'string'
          && typeof record.bytes === 'number'
          && (record.words === null || typeof record.words === 'number');
      })
      : [],
  };
}

export async function addCvVersion(label: string, text: string): Promise<string> {
  const value = await invokeProfileControl({
    version: '1', action: 'add-version', label, text,
  });
  const name = (value as { added?: { name?: unknown } })?.added?.name;
  if (typeof name !== 'string') throw new Error('The secure backend did not confirm the CV version.');
  return name;
}

/** Returns the field paths and files actually written. */
export async function saveProfile(save: ProfileSave): Promise<string[]> {
  const payload: Record<string, unknown> = { version: '1', action: 'save' };
  if (save.fields && Object.keys(save.fields).length > 0) payload.fields = save.fields;
  if (typeof save.cv === 'string') payload.cv = save.cv;
  if (save.versions && save.versions.length > 0) payload.versions = save.versions;

  const value = await invokeProfileControl(payload);
  const written = (value as { written?: unknown })?.written;
  return Array.isArray(written) ? written.filter((w): w is string => typeof w === 'string') : [];
}
