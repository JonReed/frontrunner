/**
 * jobs.ts — spawn and supervise the CLI so the user never opens a terminal.
 *
 * This is the layer that makes the product's main promise true. Tailoring a CV
 * is a model task, but the model is deliberately tool-less. It returns a
 * bounded JSON payload; deterministic code renders and fact-checks the PDF.
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
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, renameSync } from 'node:fs';
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
  /**
   * What the worker is actually doing, inferred from its output.
   *
   * A timer-driven message is a guess; this is evidence. It matters because
   * the run is genuinely slow, and "Rewriting your experience" after 40
   * seconds of silence is the difference between waiting and giving up.
   */
  stage?: string;
  error?: string;
}

function ensureDir() {
  mkdirSync(JOBS_DIR, { recursive: true });
}

function jobPath(id: string) {
  if (!/^cv-\d+-[a-z0-9]+$/.test(id)) throw new Error('invalid job id');
  return join(JOBS_DIR, `${id}.json`);
}

function write(job: Job) {
  ensureDir();
  const target = jobPath(job.id);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify(job, null, 2), { mode: 0o600 });
  renameSync(temporary, target);
}

/**
 * Map worker output to a human stage. Ordered most-specific first; the last
 * match wins, so later progress overrides earlier.
 */
const STAGE_SIGNALS: [RegExp, string][] = [
  [/reading|fetching|job description|\bJD\b/i, 'Reading the job description'],
  [/cv\.md|profile\.yml|comparing|match/i, 'Comparing it with your CV'],
  [/tailor|rewrit|summary|bullet/i, 'Rewriting your experience for this role'],
  [/build-cv-html|html/i, 'Laying out your CV'],
  [/generate-pdf|playwright|chromium|pdf/i, 'Building the PDF'],
  [/pdf generated|✅|saved/i, 'Finishing up'],
];

function stageFromLog(id: string): string | undefined {
  try {
    const log = readFileSync(join(JOBS_DIR, `${id}.log`), 'utf8');
    let found: string | undefined;
    for (const [re, label] of STAGE_SIGNALS) if (re.test(log)) found = label;
    return found;
  } catch {
    return undefined;
  }
}

export function readJob(id: string): Job | null {
  try {
    const job = JSON.parse(readFileSync(jobPath(id), 'utf8')) as Job;
    if (job.status === 'running') job.stage = stageFromLog(id) ?? job.stage;
    return job;
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
  writeFileSync(logFile, '', { mode: 0o600 });

  const job: Job = {
    id,
    roleNum,
    kind: 'build-cv',
    status: 'running',
    startedAt: Date.now(),
  };
  write(job);

  const child = spawn(
    process.execPath,
    [
      'src/cv/claude-tailor.mjs',
      '--url', jobUrl,
      '--tracker', String(roleNum),
      ...(reportPath ? ['--report', reportPath] : []),
    ],
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
          ? 'Could not start the secure CV builder. Check that Node and the Claude CLI are installed.'
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
