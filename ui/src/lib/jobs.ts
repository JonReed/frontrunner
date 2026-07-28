/**
 * jobs.ts — spawn and supervise the CLI so the user never opens a terminal.
 *
 * This is the layer that makes the product's main promise true. Tailoring a CV
 * is an agent task: it reads the CV, the job description and the evaluation,
 * rewrites the content, then renders HTML and PDF. There is no scriptable
 * shortcut — it has to run `claude -p`. So the UI runs it.
 *
 * Design constraints that matter more than elegance here:
 *
 * SPENDING MUST NOT DOUBLE. Every run costs the user's AI allowance, so a
 * second run for a role that is already running is refused, not queued.
 *
 * STATE MUST SURVIVE A RELOAD. Next dev reloads modules on edit, which would
 * wipe an in-memory registry and orphan a running child. Job state lives on
 * disk so a reload reconnects to the truth instead of losing it.
 *
 * FAILURE MUST BE VISIBLE. A crashed or hung worker is the user's problem to
 * see, not something to swallow. Exit code, stderr tail and a timeout are all
 * recorded and surfaced.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './roles';

const JOBS_DIR = join(ROOT, 'ui', '.jobs');

/** Hard stop. A tailoring run that has not finished by now is stuck. */
const TIMEOUT_MS = 5 * 60 * 1000;

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
  error?: string;
}

function ensureDir() {
  mkdirSync(JOBS_DIR, { recursive: true });
}

function jobPath(id: string) {
  return join(JOBS_DIR, `${id}.json`);
}

function write(job: Job) {
  ensureDir();
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
}

export function readJob(id: string): Job | null {
  try {
    return JSON.parse(readFileSync(jobPath(id), 'utf8')) as Job;
  } catch {
    return null;
  }
}

export function listJobs(): Job[] {
  ensureDir();
  return readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(JOBS_DIR, f), 'utf8')) as Job;
      } catch {
        return null;
      }
    })
    .filter((j): j is Job => j !== null)
    .map(reapIfStale)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * A job whose process died without writing a result would otherwise show
 * "running" forever, and block the role from ever being retried.
 */
function reapIfStale(job: Job): Job {
  if (job.status !== 'running') return job;
  if (Date.now() - job.startedAt < TIMEOUT_MS) return job;
  const reaped: Job = {
    ...job,
    status: 'failed',
    finishedAt: Date.now(),
    error: 'Timed out. The run took longer than 5 minutes and was abandoned.',
  };
  write(reaped);
  return reaped;
}

export function runningJobFor(roleNum: number): Job | null {
  return listJobs().find((j) => j.roleNum === roleNum && j.status === 'running') ?? null;
}

/**
 * Start a tailored-CV build.
 *
 * Returns the existing job if one is already running for this role — the user
 * cannot accidentally spend twice by double-clicking or reloading.
 */
export function startCvBuild(roleNum: number, jobUrl: string, reportPath: string | null): Job {
  const existing = runningJobFor(roleNum);
  if (existing) return existing;

  ensureDir();
  const id = `cv-${roleNum}-${Date.now().toString(36)}`;
  const logFile = join(JOBS_DIR, `${id}.log`);

  const job: Job = {
    id,
    roleNum,
    kind: 'build-cv',
    status: 'running',
    startedAt: Date.now(),
  };
  write(job);

  const reportLine = reportPath ? `\nThe evaluation report is at: ${reportPath}` : '';
  const prompt =
    `Tailor the CV for this role and generate the HTML and PDF CVs.\n` +
    `URL: ${jobUrl}\nTracker row: ${roleNum}${reportLine}`;

  const child = spawn(
    'claude',
    ['-p', '--dangerously-skip-permissions', '--append-system-prompt-file', 'modes/pdf.md', prompt],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: false },
  );

  const capture = (chunk: Buffer) => {
    try {
      appendFileSync(logFile, chunk.toString());
    } catch {
      /* logging must never take the run down */
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, TIMEOUT_MS);

  child.on('error', (err) => {
    clearTimeout(timer);
    write({
      ...job,
      status: 'failed',
      finishedAt: Date.now(),
      error:
        err.message.includes('ENOENT')
          ? 'Could not find the Claude CLI. Frontrunner needs it installed and signed in.'
          : err.message,
    });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    const tail = existsSync(logFile)
      ? readFileSync(logFile, 'utf8').trim().split('\n').slice(-6).join('\n')
      : '';
    const notLoggedIn = /not logged in|\/login/i.test(tail);
    write({
      ...job,
      status: code === 0 ? 'done' : 'failed',
      finishedAt: Date.now(),
      exitCode: code ?? undefined,
      tail,
      error:
        code === 0
          ? undefined
          : notLoggedIn
            ? 'The Claude CLI is not signed in. Frontrunner needs it connected to your AI subscription.'
            : `The run failed (exit code ${code}).`,
    });
  });

  return job;
}
