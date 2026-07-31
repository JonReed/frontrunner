'use client';

/**
 * BuildCover — the other half of an application.
 *
 * `cover` has been a documented mode since the beginning and the template
 * ships with the product, but the interface only ever offered to build a CV.
 * Most applications in the UK expect a letter as well, so someone who reached
 * "Ready to send" had half of what they needed and no way to ask for the rest.
 *
 * Deliberately quieter than BuildCv and placed after it. The CV is what every
 * application needs and what the score is about; the letter is a common
 * addition, not a second headline act. Offering both as equal primary buttons
 * would ask someone to make a choice they have no basis for.
 *
 * It does not appear until a CV exists. Writing a letter that argues for an
 * application whose CV has not been tailored is work in the wrong order, and
 * the pair should be built from the same reading of the advert.
 */

import { useEffect, useState, useTransition } from 'react';
import { buildCover } from '@/app/actions';
import { AiButton } from './ai-button';
import { ReconnectNotice, isSignInFailure } from './reconnect-notice';
import type { Job } from '@/lib/jobs';

export function BuildCover({
  roleNum,
  hasCover,
  connected = true,
  browserReady = true,
  initialJob = null,
}: {
  roleNum: number;
  hasCover: boolean;
  connected?: boolean;
  browserReady?: boolean;
  initialJob?: Job | null;
}) {
  const [job, setJob] = useState<Job | null>(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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

  const start = () => {
    setError(null);
    startTransition(async () => {
      const result = await buildCover(roleNum);
      if ('error' in result) setError(result.error ?? 'Something went wrong.');
      else setJob(result);
    });
  };

  if (hasCover && job?.status !== 'running') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-ink-soft)]">
          Your covering letter is ready.
        </p>
        <a
          href={`/api/file?role=${encodeURIComponent(roleNum)}&format=cover`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-[40px] cursor-pointer items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-2"
        >
          Read my letter
        </a>
      </div>
    );
  }

  if (job?.status === 'running' || pending) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-ai-line)] border-t-[var(--color-ai)]"
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-[var(--color-ai)]">
          {job?.stage ?? 'Writing your covering letter'}…
        </p>
      </div>
    );
  }

  if (job?.status === 'done') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-[var(--color-ready)]">
          Your covering letter is ready.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex min-h-[40px] cursor-pointer items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 text-sm font-medium transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-2"
        >
          Show me
        </button>
      </div>
    );
  }

  const failure = error ?? job?.error;
  if (failure && isSignInFailure(failure)) return <ReconnectNotice message={failure} />;
  if (failure) {
    return (
      <div>
        <p className="text-sm font-semibold text-[var(--color-attention)]">
          The letter could not be written
        </p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{failure}</p>
        <button
          type="button"
          onClick={start}
          className="mt-2 cursor-pointer text-sm font-medium text-[var(--color-act)] underline underline-offset-2"
        >
          Try again
        </button>
      </div>
    );
  }

  // Both dependencies are reported by the CV control directly above this one.
  // Repeating either here would show the same warning twice on one screen.
  if (!connected || !browserReady) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-[var(--color-ink-soft)]">
        Many employers ask for a covering letter as well.
      </p>
      <AiButton what="write a covering letter for this job" onClick={start} tone="quiet">
        Add a covering letter
      </AiButton>
    </div>
  );
}
