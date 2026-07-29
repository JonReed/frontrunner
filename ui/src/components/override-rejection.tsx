'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { overridePrefilterRejection } from '@/app/actions';

export function OverrideRejection({
  url,
  rule,
  runActive = false,
}: {
  url: string;
  rule: string;
  runActive?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const restore = () => {
    setError(null);
    startTransition(async () => {
      const result = await overridePrefilterRejection(url, rule);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setRestored(true);
      setConfirming(false);
      window.setTimeout(() => router.refresh(), 900);
    });
  };

  if (restored) {
    return (
      <span aria-live="polite" className="text-sm font-medium text-[var(--color-ready)]">
        Back in Not assessed
      </span>
    );
  }

  if (runActive) {
    return (
      <span className="text-xs text-[var(--color-ink-faint)]">
        Available when this run finishes
      </span>
    );
  }

  if (confirming) {
    return (
      <div className="max-w-sm text-sm">
        <p className="text-[var(--color-ink-soft)]">
          Put this role back for assessment despite this rule? A later assessment run may use
          your AI allowance.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={restore}
            className="min-h-10 cursor-pointer rounded-lg bg-[var(--color-act)] px-3.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
          >
            {pending ? 'Restoring…' : 'Override this rule'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
            className="min-h-10 cursor-pointer px-2 text-sm text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
          >
            Keep ruled out
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-[var(--color-attention)]">{error}</p>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="min-h-10 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-xs font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-1.5"
    >
      Assess anyway
    </button>
  );
}
