'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  assessWaitingRoles,
  findAndAssessRoles,
  scanForRoles,
  stopPipelineJob,
} from '@/app/actions';
import { AiButton } from '@/components/ai-button';
import { pipelineActions } from '@/lib/pipeline-actions.mjs';
import type { Job } from '@/lib/jobs';

type ActionResult = Job | { error: string };
type PipelineAction = 'assess' | 'find-and-assess' | 'scan';

const SECONDARY =
  'inline-flex min-h-[42px] cursor-pointer items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] disabled:cursor-not-allowed disabled:opacity-60';

function isError(result: ActionResult): result is { error: string } {
  return 'error' in result;
}

function operationName(job: Job): string {
  if (job.operation === 'scan.run') return 'Searching for roles';
  if (job.operation === 'pipeline.prepare') return 'Preparing roles';
  return 'Assessing roles';
}

export function PipelineControl({
  inboxCount,
  connected,
  initialJob,
}: {
  inboxCount: number;
  connected: boolean;
  initialJob: Job | null;
}) {
  const actions = pipelineActions(inboxCount, connected);
  const [job, setJob] = useState<Job | null>(initialJob);
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        setJob(await response.json() as Job);
      } catch {
        // A transient poll failure is not a failed backend run. The next poll
        // will recover, and the durable job survives a page reload.
      }
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [job?.id, job?.status]);

  const run = (action: PipelineAction) => {
    setError('');
    startTransition(async () => {
      const result = action === 'scan'
        ? await scanForRoles()
        : action === 'assess'
          ? await assessWaitingRoles()
          : await findAndAssessRoles();
      if (isError(result)) setError(result.error);
      else setJob(result);
    });
  };

  const stop = () => {
    if (!job) return;
    setError('');
    startTransition(async () => {
      const result = await stopPipelineJob(job.id);
      if (isError(result)) setError(result.error);
      else setJob(result);
    });
  };

  if (job?.status === 'running') {
    return (
      <section
        aria-live="polite"
        className="mb-9 overflow-hidden rounded-2xl border border-[var(--color-line-strong)] bg-[var(--color-card)] shadow-[0_10px_30px_rgb(26_25_23/0.06)]"
      >
        <div className="h-1 w-full overflow-hidden bg-[var(--color-paper-deep)]">
          <div className="h-full w-2/5 animate-pulse rounded-full bg-[var(--color-ai)]" />
        </div>
        <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-ai)]">
              {operationName(job)}
            </p>
            <p className="mt-1 text-[17px] font-bold tracking-tight">
              {job.stage ?? 'Starting securely'}
            </p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              You can leave this page. The run will carry on here.
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={stop}
            className={SECONDARY}
          >
            {pending ? 'Stopping…' : 'Stop run'}
          </button>
        </div>
        {error && <p className="px-6 pb-5 text-sm text-[var(--color-danger)]">{error}</p>}
      </section>
    );
  }

  if (job?.status === 'done') {
    return (
      <section
        aria-live="polite"
        className="mb-9 flex flex-col gap-4 rounded-2xl border border-[color-mix(in_srgb,var(--color-ready)_35%,var(--color-line))] bg-[var(--color-card)] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-ready)]">Run complete</p>
          <p className="mt-1 text-[17px] font-bold tracking-tight">
            {job.operation === 'scan.run' ? 'New roles are ready to review.' : 'Your latest matches are ready.'}
          </p>
        </div>
        <button type="button" onClick={() => window.location.reload()} className={SECONDARY}>
          Show results
        </button>
      </section>
    );
  }

  if (job?.status === 'failed') {
    return (
      <section aria-live="polite" className="mb-9 rounded-2xl border border-[var(--color-danger)]/25 bg-[var(--color-card)] px-5 py-5 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-danger)]">Run stopped</p>
        <p className="mt-1 text-[17px] font-bold tracking-tight">
          {job.error ?? 'Frontrunner could not finish that run.'}
        </p>
        {job.tail && (
          <details className="mt-3 text-xs text-[var(--color-ink-faint)]">
            <summary className="cursor-pointer">Technical detail</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--color-paper-deep)] p-3">{job.tail}</pre>
          </details>
        )}
        <button
          type="button"
          onClick={() => setJob(null)}
          className={`${SECONDARY} mt-4`}
        >
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className="mb-9 rounded-2xl border border-[var(--color-line)] bg-[var(--color-paper-deep)] px-5 py-5 sm:px-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[17px] font-bold tracking-tight">
            {inboxCount > 0
              ? `${inboxCount.toLocaleString()} roles are waiting for assessment`
              : 'Look for your next set of roles'}
          </p>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-ink-soft)]">
            {inboxCount > 0
              ? 'Assess what is already here, or search your configured sources for anything new.'
              : 'Search is free. Assessment compares promising roles with your CV using your connected AI subscription.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions.primary && (
            <AiButton
              disabled={pending}
              onClick={() => run(actions.primary!.action as PipelineAction)}
              what={actions.primary.description}
            >
              {pending ? 'Starting…' : actions.primary.label}
            </AiButton>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => run(actions.scan.action as PipelineAction)}
            className={SECONDARY}
          >
            {actions.scan.label}
          </button>
        </div>
      </div>
      {!connected && (
        <p className="mt-4 border-t border-[var(--color-line)] pt-4 text-sm text-[var(--color-ink-soft)]">
          Connect your AI subscription to assess roles. You can still scan without it.
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}
    </section>
  );
}
