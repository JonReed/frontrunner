'use client';

/**
 * BuildCv — the button that does the work, and the states that follow it.
 *
 * This component is the product's main promise made real: the user never opens
 * a terminal, so everything that would normally be shell output has to become
 * something readable here.
 *
 * Four states, and the last two matter most:
 *   idle     an AI-marked button, cost stated before the click
 *   working  honest progress — no fake percentage bar
 *   done     the outcome, and what to do next
 *   failed   what went wrong IN PLAIN LANGUAGE, and how to fix it
 *
 * The failure state is the one that decides whether a non-technical user can
 * actually use this. "exit code 1" is a dead end. "The Claude CLI isn't signed
 * in" is something a person can act on.
 */

import { useEffect, useState, useTransition } from 'react';
import { buildCv } from '@/app/actions';
import { AiButton } from './ai-button';
import type { Job } from '@/lib/jobs';

/** Tailoring takes tens of seconds, so say what is happening rather than spin. */
const STEPS = [
  'Reading the job description',
  'Comparing it with your CV',
  'Rewriting your experience for this role',
  'Building the PDF',
];

export function BuildCv({ roleNum, hasPdf }: { roleNum: number; hasPdf: boolean }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState(0);

  // Poll while running. Cheap, and survives a reload or a closed laptop in a
  // way an open SSE connection would not.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${job.id}`, { cache: 'no-store' });
        if (res.ok) setJob(await res.json());
      } catch {
        /* a dropped poll is not a failure; the next one will catch up */
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [job]);

  // Advance the described step on a timer. Honest: it reflects elapsed time,
  // not real progress, and it never claims a percentage.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 12000);
    return () => clearInterval(t);
  }, [job]);

  const start = () => {
    setError(null);
    setStep(0);
    startTransition(async () => {
      const result = await buildCv(roleNum);
      if ('error' in result) setError(result.error ?? 'Something went wrong.');
      else setJob(result);
    });
  };

  if (hasPdf && !job) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-semibold">Your tailored CV is ready</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Rewritten for this role. Nothing left but to send it.
          </p>
        </div>
        <button
          type="button"
          className="rounded-lg bg-[var(--color-act)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)]"
        >
          Open the job posting
        </button>
      </div>
    );
  }

  if (job?.status === 'running' || pending) {
    return (
      <div className="flex flex-wrap items-center gap-4">
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-ai-line)] border-t-[var(--color-ai)]"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="font-semibold text-[var(--color-ai)]">{STEPS[step]}…</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            This usually takes under a minute. You can leave this page — it keeps going.
          </p>
        </div>
      </div>
    );
  }

  if (job?.status === 'done') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-semibold text-[var(--color-ready)]">Your tailored CV is ready</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Saved to your output folder. Reload to see it attached to this role.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-[var(--color-act)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)]"
        >
          Show me
        </button>
      </div>
    );
  }

  const failure = error ?? job?.error;
  if (failure) {
    return (
      <div>
        <p className="font-semibold text-[var(--color-attention)]">That did not work</p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{failure}</p>
        {job?.tail && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-[var(--color-ink-faint)]">
              Technical detail
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--color-paper)] p-3 text-xs leading-relaxed text-[var(--color-ink-soft)]">
              {job.tail}
            </pre>
          </details>
        )}
        <button
          type="button"
          onClick={start}
          className="mt-3 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2 text-sm font-medium transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="font-semibold">Want to apply?</p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          Builds a CV tailored to this role, using the gaps above. Takes about a minute.
        </p>
      </div>
      <AiButton what="rewrite your CV for this specific job" onClick={start}>
        Build my CV for this job
      </AiButton>
    </div>
  );
}
