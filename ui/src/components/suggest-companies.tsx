'use client';

/**
 * SuggestCompanies — "I do not know who to name."
 *
 * The employers step in setup assumes someone can list a few. Plenty of people
 * cannot: they know the job they want and the area they want it in, but not
 * thirty organisations that employ for it. That is the gap this fills, and it
 * is the one part of building a company list that genuinely needs a model.
 *
 * Three properties make it safe to offer:
 *
 *   IT PROPOSES, IT DOES NOT ACT. The model returns names and reasons. Nothing
 *   is followed until the user ticks it and presses the button, at which point
 *   the zero-token resolver finds the real board. No model-supplied address is
 *   ever contacted.
 *
 *   IT IS MARKED. An AiButton, because it spends allowance — unlike everything
 *   else on this screen.
 *
 *   IT IS NOT IN SETUP. It needs a signed-in CLI, which most people do not
 *   have at first run, so it lives here where the connection state is known
 *   and the failure is recoverable.
 *
 * Reasons are shown next to each name so the user can judge them. A model can
 * name an employer that does not operate in their region, or has closed; the
 * reason is what makes that visible before they follow it.
 */

import { useEffect, useState, useTransition } from 'react';
import { followCompanies, suggestCompanies } from '@/app/actions';
import { AiButton } from '@/components/ai-button';
import type { CompanySuggestion } from '@/lib/company-suggestions';
import { ReconnectNotice, isSignInFailure } from '@/components/reconnect-notice';
import type { Job } from '@/lib/jobs';

/** A Job always has an id; a rejected request never does. */
function failed(result: Job | { error: string }): result is { error: string } {
  return !('id' in result);
}

export function SuggestCompanies({
  suggestions,
  connected,
  initialJob = null,
}: {
  suggestions: CompanySuggestion[];
  connected: boolean;
  initialJob?: Job | null;
}) {
  const [job, setJob] = useState<Job | null>(initialJob);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [followed, setFollowed] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const next = await response.json() as Job;
        setJob(next);
        // The shortlist is a file the run writes at the end, so the page has
        // to be reloaded to read it. Doing that automatically means the user
        // gets the result rather than a finished spinner.
        if (next.status === 'done') window.location.reload();
      } catch {
        // A dropped poll is not a failed run; the next one recovers.
      }
    }, 2_000);
    return () => window.clearInterval(poll);
  }, [job?.id, job?.status]);

  const start = () => {
    setError(null);
    startTransition(async () => {
      const result = await suggestCompanies();
      if (failed(result)) {
        setError(result.error);
        return;
      }
      setJob(result);
    });
  };

  const toggle = (name: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const follow = () => {
    setError(null);
    startTransition(async () => {
      const result = await followCompanies([...picked]);
      if (failed(result)) {
        setError(result.error);
        return;
      }
      setFollowed(true);
    });
  };

  const failure = error ?? (job?.status === 'failed' ? job.error : null);
  if (failure && isSignInFailure(failure)) return <ReconnectNotice message={failure} />;

  if (job?.status === 'running') {
    return (
      <div aria-live="polite" className="flex flex-wrap items-center gap-3">
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-ai-line)] border-t-[var(--color-ai)]"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-[var(--color-ai)]">
            {job.stage ?? 'Reading your CV'}…
          </p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Under a minute. You can leave this page.
          </p>
        </div>
      </div>
    );
  }

  if (followed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-ready)]">
          Finding their job boards now. That carries on in the background.
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
      {suggestions.length > 0 && (
        <>
          <p className="mb-1 text-sm font-semibold">Suggested from your CV</p>
          <p className="mb-3 text-sm text-[var(--color-ink-soft)]">
            Tick the ones worth following. Check anything you do not recognise — these are
            suggestions, not verified employers.
          </p>
          <ul className="mb-4 flex flex-col gap-1.5">
            {suggestions.map((suggestion) => (
              <li key={suggestion.name}>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-card)] px-3.5 py-2.5 transition hover:border-[var(--color-line-strong)]">
                  <input
                    type="checkbox"
                    checked={picked.has(suggestion.name)}
                    onChange={() => toggle(suggestion.name)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-act)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{suggestion.name}</span>
                    {suggestion.why && (
                      <span className="block text-sm text-[var(--color-ink-soft)]">
                        {suggestion.why}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {picked.size > 0 && (
          <button
            type="button"
            onClick={follow}
            disabled={pending}
            className="inline-flex min-h-[42px] cursor-pointer items-center rounded-lg bg-[var(--color-act)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
          >
            {pending ? 'Starting…' : `Follow ${picked.size} selected`}
          </button>
        )}

        {connected ? (
          <AiButton
            what="read your CV and suggest employers who hire for your kind of role"
            onClick={start}
            disabled={pending}
            tone="quiet"
          >
            {suggestions.length > 0 ? 'Suggest more' : 'Suggest employers from my CV'}
          </AiButton>
        ) : (
          <p className="text-sm text-[var(--color-ink-soft)]">
            Connect your AI subscription on My details to have employers suggested from your CV.
          </p>
        )}
      </div>

      {job?.status === 'failed' && !error && (
        <p className="mt-3 text-sm text-[var(--color-attention)]">
          {job.error ?? 'That did not finish. Try again.'}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-attention)]">
          {error}
        </p>
      )}
    </div>
  );
}
