/**
 * jobs.ts — bounded UI adapter for the backend application job controller.
 *
 * Turbopack deliberately stays rooted inside ui/, so backend modules are not
 * bundled into Next.js. The UI launches one fixed controller script and sends
 * bounded JSON over stdin. The controller owns validation, atomic spend
 * deduplication, persistent state, logs, process supervision and lifecycle
 * results.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './roles';

const JOB_CONTROL = join(ROOT, 'src', 'application', 'job-control.mjs');
const RESPONSE_LIMIT = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 12_000;

export type JobStatus = 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  roleNum: number;
  kind: 'build-cv';
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  /** Last few lines of output — enough to explain a failure without a log viewer. */
  tail?: string;
  stage?: string;
  error?: string;
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<Job>;
  return (
    typeof job.id === 'string'
    && /^cv-\d+-[a-z0-9]+$/.test(job.id)
    && Number.isSafeInteger(job.roleNum)
    && Number(job.roleNum) > 0
    && Number(job.roleNum) <= 999_999
    && job.id.startsWith(`cv-${String(job.roleNum)}-`)
    && job.kind === 'build-cv'
    && ['running', 'done', 'failed'].includes(String(job.status))
    && Number.isSafeInteger(job.startedAt)
    && Number(job.startedAt) >= 0
    && (job.tail === undefined || (typeof job.tail === 'string' && job.tail.length <= 16 * 1024))
    && (job.stage === undefined || (typeof job.stage === 'string' && job.stage.length <= 120))
    && (job.error === undefined || (typeof job.error === 'string' && job.error.length <= 1_000))
  );
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

function invokeJobControl(payload: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [JOB_CONTROL], {
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

export async function readJob(id: string): Promise<Job | null> {
  const value = await invokeJobControl({ version: '1', action: 'read', id });
  if (value === null) return null;
  return isJob(value) ? value : null;
}

export async function listRunningCvRoleNums(): Promise<Set<number>> {
  let value;
  try {
    value = await invokeJobControl({
      version: '1',
      action: 'list',
      operation: 'cv.build',
      status: 'running',
      limit: 50,
    });
  } catch {
    return new Set();
  }
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray((value as { jobs?: unknown }).jobs)
  ) {
    return new Set();
  }
  const roles = new Set<number>();
  for (const item of (value as { jobs: unknown[] }).jobs) {
    if (
      item
      && typeof item === 'object'
      && Number.isSafeInteger((item as { roleNum?: unknown }).roleNum)
    ) {
      roles.add(Number((item as { roleNum: number }).roleNum));
    }
  }
  return roles;
}

/**
 * Start a tailored-CV build.
 *
 * The backend returns the existing job when this role is already running, so
 * double-clicks and concurrent UI processes cannot duplicate model spend.
 */
export async function startCvBuild(
  roleNum: number,
  jobUrl: string,
  reportPath: string | null,
): Promise<Job> {
  const value = await invokeJobControl({
    version: '1',
    action: 'start',
    request: {
      version: '1',
      operation: 'cv.build',
      input: { roleNum, jobUrl, reportPath },
      idempotencyKey: `cv:${String(roleNum)}`,
    },
  });
  if (!isJob(value)) throw new Error('The secure backend returned an invalid job.');
  return value;
}
