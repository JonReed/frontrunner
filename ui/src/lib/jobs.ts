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
import { ROOT } from './root';
import { runningDocumentJobForRole } from './job-selection.mjs';

const JOB_CONTROL = join(ROOT, 'src', 'application', 'job-control.mjs');
const RESPONSE_LIMIT = 64 * 1024;
const RESPONSE_TIMEOUT_MS = 12_000;

export type JobStatus = 'running' | 'done' | 'failed';
export type ApplicationOperation =
  | 'cv.build'
  | 'cover.build'
  | 'pipeline.run'
  | 'pipeline.prepare'
  | 'scan.run'
  | 'companies.discover'
  | 'companies.suggest';

export interface Job {
  id: string;
  operation?: ApplicationOperation;
  roleNum?: number;
  kind: 'build-cv' | 'build-cover' | 'pipeline' | 'prepare-pipeline' | 'scan' | 'discover-companies' | 'suggest-companies';
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  costsTokens?: boolean;
  /** Last few lines of output — enough to explain a failure without a log viewer. */
  tail?: string;
  stage?: string;
  error?: string;
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<Job>;
  const operation = job.operation ?? (job.kind === 'build-cv' ? 'cv.build' : undefined);
  const shape = {
    'cv.build': { id: /^cv-\d+-[a-z0-9]+$/, kind: 'build-cv' },
    'cover.build': { id: /^cover-\d+-[a-z0-9]+$/, kind: 'build-cover' },
    'pipeline.run': { id: /^job-pipeline-[a-z0-9]+$/, kind: 'pipeline' },
    'pipeline.prepare': { id: /^job-prepare-[a-z0-9]+$/, kind: 'prepare-pipeline' },
    'scan.run': { id: /^job-scan-[a-z0-9]+$/, kind: 'scan' },
    'companies.discover': { id: /^job-companies-[a-z0-9]+$/, kind: 'discover-companies' },
    'companies.suggest': { id: /^job-suggest-[a-z0-9]+$/, kind: 'suggest-companies' },
  }[String(operation)] as { id: RegExp; kind: Job['kind'] } | undefined;
  return (
    Boolean(shape)
    && typeof job.id === 'string'
    && shape!.id.test(job.id)
    && job.kind === shape!.kind
    && (
      // Role-scoped operations carry a tracker number and a matching id
      // prefix; everything else must carry neither.
      operation === 'cv.build' || operation === 'cover.build'
        ? (
          Number.isSafeInteger(job.roleNum)
          && Number(job.roleNum) > 0
          && Number(job.roleNum) <= 999_999
          && job.id.startsWith(`${operation === 'cv.build' ? 'cv' : 'cover'}-${String(job.roleNum)}-`)
        )
        : job.roleNum === undefined
    )
    && ['running', 'done', 'failed'].includes(String(job.status))
    && Number.isSafeInteger(job.startedAt)
    && Number(job.startedAt) >= 0
    && (job.finishedAt === undefined || (
      Number.isSafeInteger(job.finishedAt)
      && Number(job.finishedAt) >= Number(job.startedAt)
    ))
    && (job.costsTokens === undefined || typeof job.costsTokens === 'boolean')
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

export function isPipelineJob(
  job: Job | null,
): job is Job & { operation: 'pipeline.run' | 'pipeline.prepare' | 'scan.run' } {
  return Boolean(
    job
    && (
      job.operation === 'pipeline.run'
      || job.operation === 'pipeline.prepare'
      || job.operation === 'scan.run'
    ),
  );
}

export async function readRunningPipelineJob(): Promise<Job | null> {
  let value;
  try {
    value = await invokeJobControl({
      version: '1',
      action: 'list',
      status: 'running',
      limit: 20,
    });
  } catch {
    return null;
  }
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray((value as { jobs?: unknown }).jobs)
  ) {
    return null;
  }
  for (const item of (value as { jobs: unknown[] }).jobs) {
    if (isJob(item) && isPipelineJob(item)) return item;
  }
  return null;
}

export async function cancelPipelineJob(id: string): Promise<Job | null> {
  const current = await readJob(id);
  if (!isPipelineJob(current)) return null;
  const value = await invokeJobControl({ version: '1', action: 'cancel', id });
  return isJob(value) && isPipelineJob(value) ? value : null;
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
 * Reattach one role page to the durable job that already owns its spend.
 *
 * Asked per operation: a role can be building a CV and a covering letter at
 * once, and each control has to find its own run rather than adopt the other's.
 */
export async function readRunningDocumentJob(
  roleNum: number,
  operation: 'cv.build' | 'cover.build' = 'cv.build',
): Promise<Job | null> {
  if (!Number.isSafeInteger(roleNum) || roleNum < 1 || roleNum > 999_999) return null;
  let value;
  try {
    value = await invokeJobControl({
      version: '1',
      action: 'list',
      operation,
      status: 'running',
      limit: 50,
    });
  } catch {
    return null;
  }
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray((value as { jobs?: unknown }).jobs)
  ) {
    return null;
  }
  const jobs = (value as { jobs: unknown[] }).jobs.filter(isJob);
  return runningDocumentJobForRole(jobs, roleNum, operation) as Job | null;
}

export function readRunningCvJob(roleNum: number): Promise<Job | null> {
  return readRunningDocumentJob(roleNum, 'cv.build');
}

export function readRunningCoverJob(roleNum: number): Promise<Job | null> {
  return readRunningDocumentJob(roleNum, 'cover.build');
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

/** Start a covering letter. Deduped per role, separately from the CV. */
export async function startCoverBuild(
  roleNum: number,
  jobUrl: string,
  reportPath: string | null,
): Promise<Job> {
  const value = await invokeJobControl({
    version: '1',
    action: 'start',
    request: {
      version: '1',
      operation: 'cover.build',
      input: { roleNum, jobUrl, reportPath },
      idempotencyKey: `cover:${String(roleNum)}`,
    },
  });
  if (!isJob(value)) throw new Error('The secure backend returned an invalid job.');
  return value;
}

/**
 * Resolve company names to real job boards and follow them.
 *
 * The names are the only request-controlled part, and the contract anchors
 * each one on a letter or digit so it can never be read as a flag. Costs no
 * model allowance, which is why it can be offered during setup — when the CLI
 * is usually not signed in yet.
 */
export async function startCompanyDiscovery(names: string[]): Promise<Job> {
  const value = await invokeJobControl({
    version: '1',
    action: 'start',
    request: {
      version: '1',
      operation: 'companies.discover',
      input: { names },
    },
  });
  if (!isJob(value)) throw new Error('The secure backend returned an invalid job.');
  return value;
}

/** Ask the model which employers this CV suits. Spends allowance. */
export async function startCompanySuggestion(): Promise<Job> {
  const value = await invokeJobControl({
    version: '1',
    action: 'start',
    request: { version: '1', operation: 'companies.suggest', input: {} },
  });
  if (!isJob(value)) throw new Error('The secure backend returned an invalid job.');
  return value;
}

export function readRunningCompanySuggestion(): Promise<Job | null> {
  return readRunningCompanyJob('companies.suggest');
}

export function readRunningCompanyDiscovery(): Promise<Job | null> {
  return readRunningCompanyJob('companies.discover');
}

async function readRunningCompanyJob(operation: ApplicationOperation): Promise<Job | null> {
  let value;
  try {
    value = await invokeJobControl({
      version: '1',
      action: 'list',
      operation,
      status: 'running',
      limit: 5,
    });
  } catch {
    return null;
  }
  if (
    !value
    || typeof value !== 'object'
    || !Array.isArray((value as { jobs?: unknown }).jobs)
  ) {
    return null;
  }
  for (const item of (value as { jobs: unknown[] }).jobs) {
    if (isJob(item) && item.operation === operation) return item;
  }
  return null;
}

async function startFixedPipelineOperation(
  operation: 'scan.run' | 'pipeline.run',
  input: Record<string, unknown>,
): Promise<Job> {
  const value = await invokeJobControl({
    version: '1',
    action: 'start',
    request: {
      version: '1',
      operation,
      input,
    },
  });
  if (!isJob(value) || !isPipelineJob(value) || value.operation !== operation) {
    throw new Error('The secure backend returned an invalid pipeline job.');
  }
  return value;
}

/** Scan the public job boards and followed companies, without a model. */
export function startScanRun(): Promise<Job> {
  return startFixedPipelineOperation('scan.run', {});
}

/**
 * Run the canonical scan → cache → liveness → prefilter → evaluation pipeline.
 *
 * The engine and input are fixed here rather than accepted from the browser.
 */
export function startPipelineRun(scan: boolean): Promise<Job> {
  return startFixedPipelineOperation('pipeline.run', {
    engine: 'claude',
    scan,
    input: 'workspace/search/pipeline.md',
  });
}
