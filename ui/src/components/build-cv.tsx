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

/**
 * The threshold below which the project's own guidance is "do not apply".
 * Shared with the CLI's rubric so the two never give opposite advice.
 */
const WORTH_APPLYING = 4.0;

export function BuildCv({
  roleNum,
  hasPdf,
  pdf,
  url,
  score,
}: {
  roleNum: number;
  hasPdf: boolean;
  pdf?: string | null;
  url?: string | null;
  score?: number | null;
}) {
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
            Read it through, then apply on their site.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pdf && (
            <a
              href={`/api/file?path=${encodeURIComponent(pdf)}`}
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
            >
              View my CV
            </a>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="cursor-pointer rounded-lg bg-[var(--color-act)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)]"
            >
              Apply on their site
            </a>
          )}
        </div>
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
          <p className="font-semibold text-[var(--color-ai)]">{job?.stage ?? STEPS[step]}…</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Under a minute. You can leave this page.
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
          className="mt-3 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2 text-sm font-medium transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] cursor-pointer"
        >
          Try again
        </button>
      </div>
    );
  }

  /*
    A weak match gets the honest answer, not the same invitation as a good one.

    The assessment above has just explained why this role does not fit. Ending
    that page with "Want to apply?" and a primary button contradicts it, and
    quietly asks the user to spend their AI allowance on an application the
    tool itself scored as not worth sending. Being candid about a bad match is
    most of what makes the good ones trustworthy.

    Recommend against, do not block: the score is a rubric, the user knows
    things it does not, and the button is still right there.
  */
  if (typeof score === 'number' && score < WORTH_APPLYING) {
    return (
      <div>
        <p className="font-semibold">Not worth an application</p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          This one scored {score.toFixed(1)} out of 5 — the gaps above are the reason. Your
          time is better spent on a stronger match.
        </p>
        <details className="mt-3">
          <summary className="inline-block cursor-pointer text-sm font-medium text-[var(--color-ink-soft)] underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-[var(--color-act)]">
            Apply anyway
          </summary>
          <div className="mt-3">
            <AiButton what="rewrite your CV for this specific job" onClick={start}>
              Build my CV for this job
            </AiButton>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="font-semibold">Want to apply?</p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          Rewrites your CV for this role, using the gaps above.
        </p>
      </div>
      <AiButton what="rewrite your CV for this specific job" onClick={start}>
        Build my CV for this job
      </AiButton>
    </div>
  );
}
