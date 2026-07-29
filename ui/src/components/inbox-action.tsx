'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { removePendingRole, undoPendingRole } from '@/app/actions';

export function InboxAction({ url }: { url: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => router.refresh(), 7_000);
    return () => window.clearTimeout(timer);
  }, [removed, router]);

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await removePendingRole(url);
      if ('error' in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      setRemoved(true);
    });
  };

  const undo = () => {
    setError(null);
    startTransition(async () => {
      const result = await undoPendingRole(url);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setRemoved(false);
      setConfirming(false);
      router.refresh();
    });
  };

  if (removed) {
    return (
      <div aria-live="polite" className="flex items-center gap-2 text-sm">
        <span className="text-[var(--color-ink-soft)]">Removed.</span>
        <button
          type="button"
          disabled={pending}
          onClick={undo}
          className="min-h-[40px] cursor-pointer font-semibold text-[var(--color-act)] hover:underline disabled:opacity-50 sm:min-h-0"
        >
          {pending ? 'Restoring…' : 'Undo'}
        </button>
        {error && <span className="text-xs text-[var(--color-attention)]">{error}</span>}
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-[var(--color-ink-soft)]">Remove from Found?</span>
        <button
          type="button"
          disabled={pending}
          onClick={remove}
          className="min-h-[40px] cursor-pointer rounded-lg border border-[var(--color-line-strong)] px-3 text-sm font-medium hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-1.5"
        >
          {pending ? 'Removing…' : 'Remove'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setConfirming(false)}
          className="min-h-[40px] cursor-pointer px-2 text-sm text-[var(--color-ink-faint)] sm:min-h-0"
        >
          Keep
        </button>
        {error && <p className="w-full text-right text-xs text-[var(--color-attention)]">{error}</p>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="min-h-[40px] cursor-pointer px-2 text-sm text-[var(--color-ink-faint)] hover:text-[var(--color-ink-soft)] sm:min-h-0"
    >
      Not for me
    </button>
  );
}
