'use client';

/**
 * The recovery path for an installation with no search settings.
 *
 * Setup writes this file now, so a new install never lands here. What does
 * land here is everything that predates that — and anyone whose file was
 * deleted or moved. Both used to discover the problem by clicking Search and
 * reading "portals.yml not found. Run onboarding first", which is a dead end:
 * they had run onboarding, and there is no way to run it again.
 */

import { useState, useTransition } from 'react';
import { createSearchSettings } from '@/app/actions';

export function CreateSearchSettings() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const create = () => {
    setError(null);
    startTransition(async () => {
      const result = await createSearchSettings();
      if ('error' in result) {
        setError(result.error);
        return;
      }
      // A full reload rather than a router refresh: every screen decided what
      // to render when this file did not exist.
      window.location.reload();
    });
  };

  return (
    <section className="paper-surface mb-9 rounded-2xl border border-dashed p-8 text-center">
      <p className="font-semibold">Your search settings have not been created yet.</p>
      <p className="mx-auto mt-1 max-w-lg text-sm text-[var(--color-ink-soft)]">
        Searching needs a list of job titles to look for and job boards to read. Frontrunner can
        set both up from its starter list, and you can change everything afterwards.
      </p>
      <button
        type="button"
        onClick={create}
        disabled={pending}
        className="mt-5 inline-flex min-h-[42px] cursor-pointer items-center rounded-lg bg-[var(--color-act)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
      >
        {pending ? 'Setting up…' : 'Set up my search'}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-attention)]">
          {error}
        </p>
      )}
    </section>
  );
}
