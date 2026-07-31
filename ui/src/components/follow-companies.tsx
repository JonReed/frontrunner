'use client';

/**
 * FollowCompanies — add employers by name, at any time.
 *
 * The same act as the setup step, in the place someone returns to when a
 * company occurs to them later. Names in; Frontrunner probes the public
 * Greenhouse, Lever, Ashby and Workday APIs and keeps whichever board actually
 * exists and is currently advertising.
 *
 * Costs nothing and needs no connection, so it is an ordinary button rather
 * than an AI-marked one. That distinction matters on this screen, which also
 * offers a suggestion feature that does spend allowance.
 *
 * Not every name resolves — a company on a portal Frontrunner cannot read, or
 * one advertising nothing today, will not appear. The result says so rather
 * than silently dropping it, because a name that vanished with no explanation
 * reads as the product ignoring you.
 */

import { useEffect, useState, useTransition } from 'react';
import { followCompanies } from '@/app/actions';
import { ChipList } from '@/components/chip-list';
import type { Job } from '@/lib/jobs';

export function FollowCompanies({ initialJob = null }: { initialJob?: Job | null }) {
  const [names, setNames] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(initialJob);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
          cache: 'no-store',
        });
        if (response.ok) setJob(await response.json() as Job);
      } catch {
        // A dropped poll is not a failed lookup; the next one recovers.
      }
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [job?.id, job?.status]);

  /*
    Discriminated on `id`, not on `error`.

    A Job carries an optional `error` of its own, so `'error' in result` is true
    for a failed job as well as for a rejected request — the two mean different
    things and only one of them should replace the form.
  */
  const failed = (result: Job | { error: string }): result is { error: string } =>
    !('id' in result);

  const follow = () => {
    setError(null);
    startTransition(async () => {
      const result = await followCompanies(names);
      if (failed(result)) {
        setError(result.error);
        return;
      }
      setNames([]);
      setJob(result);
    });
  };

  if (job?.status === 'running') {
    return (
      <div aria-live="polite" className="flex flex-wrap items-center gap-3">
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-line-strong)] border-t-[var(--color-act)]"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold">{job.stage ?? 'Looking up their job boards'}…</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            You can leave this page. It carries on here.
          </p>
        </div>
      </div>
    );
  }

  if (job?.status === 'done') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-ink-soft)]">
          Finished. Any employer whose job board could be found is now in the list above — one
          without a readable board, or with nothing advertised today, will not be.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex min-h-[42px] cursor-pointer items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
        >
          Show the list
        </button>
      </div>
    );
  }

  return (
    <div>
      <ChipList
        label="Add employers by name"
        hint="Their name as people write it. Frontrunner finds their job board for you — this costs nothing and needs no connection."
        placeholder="e.g. Marks & Spencer"
        items={names}
        onChange={setNames}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={follow}
          disabled={pending || names.length === 0}
          className="inline-flex min-h-[42px] cursor-pointer items-center rounded-lg bg-[var(--color-act)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
        >
          {pending ? 'Starting…' : 'Follow these employers'}
        </button>
        {job?.status === 'failed' && !error && (
          <span className="text-sm text-[var(--color-attention)]">
            {job.error ?? 'That lookup did not finish. Try again.'}
          </span>
        )}
        {error && <span role="alert" className="text-sm text-[var(--color-attention)]">{error}</span>}
      </div>
    </div>
  );
}
