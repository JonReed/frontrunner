'use client';

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  moveRole,
  undoRoleMove,
  type WorkflowDestination,
} from '@/app/actions';
import type { Stage } from '@/lib/roles';

type Move = {
  label: string;
  destination: WorkflowDestination;
  message: string;
};

const PRIMARY: Partial<Record<Stage, Move>> = {
  triage: {
    label: 'I want to pursue this',
    destination: 'prepare',
    message: 'Moved to Preparing.',
  },
  ready: {
    label: 'I applied',
    destination: 'applied',
    message: 'Moved to Applied.',
  },
  applied: {
    label: 'They replied',
    destination: 'active',
    message: 'Moved to In process.',
  },
  closed: {
    label: 'Restore to deciding',
    destination: 'triage',
    message: 'Restored to Deciding.',
  },
};

const BACK: Partial<Record<Stage, Move>> = {
  prepare: {
    label: 'Move back to Deciding',
    destination: 'triage',
    message: 'Moved to Deciding.',
  },
  ready: {
    label: 'Move back to Preparing',
    destination: 'prepare',
    message: 'Moved to Preparing.',
  },
  applied: {
    label: 'Move back to Ready',
    destination: 'ready',
    message: 'Moved to Ready.',
  },
  active: {
    label: 'Move back to Applied',
    destination: 'applied',
    message: 'Moved to Applied.',
  },
};

const BUTTON =
  'inline-flex min-h-[40px] cursor-pointer items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-2';
const PRIMARY_BUTTON =
  'inline-flex min-h-[40px] cursor-pointer items-center rounded-lg bg-[var(--color-act)] px-3.5 text-sm font-semibold text-white shadow-[0_1px_1px_rgb(26_25_23/0.08)] transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-2';

export function RoleActions({
  roleNum,
  stage,
  compact = false,
  onSaved,
}: {
  roleNum: number;
  stage: Stage;
  compact?: boolean;
  onSaved?: (message: string) => void;
}) {
  const router = useRouter();
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const primary = PRIMARY[stage];
  const back = BACK[stage];

  useEffect(() => {
    if (!notice || onSaved) return;
    const timer = window.setTimeout(() => router.refresh(), 7_000);
    return () => window.clearTimeout(timer);
  }, [notice, onSaved, router]);

  const runMove = (move: Move) => {
    setError(null);
    startTransition(async () => {
      const result = await moveRole(roleNum, move.destination);
      if ('error' in result) {
        setError(result.error);
        setConfirmingClose(false);
        return;
      }
      if (onSaved) onSaved(move.message);
      else setNotice(move.message);
    });
  };

  const undo = () => {
    setError(null);
    startTransition(async () => {
      const result = await undoRoleMove(roleNum);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setNotice(null);
      router.refresh();
    });
  };

  if (notice) {
    return (
      <div aria-live="polite" className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-[var(--color-ink-soft)]">{notice}</span>
        <button
          type="button"
          disabled={pending}
          onClick={undo}
          className="min-h-[40px] cursor-pointer font-semibold text-[var(--color-act)] hover:underline disabled:opacity-50 sm:min-h-0"
        >
          {pending ? 'Restoring…' : 'Undo'}
        </button>
        {error && <span className="w-full text-[var(--color-attention)]">{error}</span>}
      </div>
    );
  }

  const remove: Move = {
    label: 'Remove',
    destination: 'closed',
    message: 'Moved to Closed.',
  };

  return (
    <div className={compact ? 'flex flex-wrap items-center justify-start gap-2 sm:justify-end' : ''}>
      <div className="flex flex-wrap items-center gap-2">
        {stage === 'prepare' ? (
          <Link href={`/role/${roleNum}`} className={PRIMARY_BUTTON}>
            Prepare application
          </Link>
        ) : primary ? (
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={pending}
            onClick={() => runMove(primary)}
          >
            {pending ? 'Saving…' : primary.label}
          </button>
        ) : null}

        {stage !== 'closed' && (
          <details className="relative">
            <summary className="flex min-h-[40px] cursor-pointer list-none items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-[var(--color-ink-faint)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)] sm:min-h-0 sm:py-2">
              More
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="absolute right-0 z-10 mt-1 w-56 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] p-1.5 shadow-[0_12px_32px_rgb(26_25_23/0.14)]">
              {back && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => runMove(back)}
                  className="block min-h-[40px] w-full cursor-pointer rounded-md px-3 text-left text-sm text-[var(--color-ink-soft)] hover:bg-[var(--color-paper)] disabled:opacity-50"
                >
                  {back.label}
                </button>
              )}
              {confirmingClose ? (
                <div className="p-2">
                  <p className="text-sm text-[var(--color-ink-soft)]">Remove from the live lists?</p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => runMove(remove)}
                      className="min-h-[40px] cursor-pointer rounded-md border border-[var(--color-line-strong)] px-3 text-sm font-medium hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
                    >
                      {pending ? 'Removing…' : 'Remove'}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => setConfirmingClose(false)}
                      className="min-h-[40px] cursor-pointer px-2 text-sm text-[var(--color-ink-faint)]"
                    >
                      Keep
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmingClose(true)}
                  className="block min-h-[40px] w-full cursor-pointer rounded-md px-3 text-left text-sm text-[var(--color-ink-soft)] hover:bg-[var(--color-paper)] disabled:opacity-50"
                >
                  Not for me
                </button>
              )}
            </div>
          </details>
        )}
      </div>

      {error && (
        <p className={`${compact ? 'w-full text-right' : 'mt-3'} text-sm text-[var(--color-attention)]`}>
          {error}
        </p>
      )}
    </div>
  );
}
