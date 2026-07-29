'use client';

/**
 * Outcome — the two things only the user knows.
 *
 * Everything else on a role page is Frontrunner reporting what it worked out.
 * This is the one place the user tells *it* something, and it closes the loop
 * the product was missing: a CV gets built, the user applies on the company's
 * own site, and nothing ever came back to say so.
 *
 * Design decisions worth keeping:
 *
 * NEITHER BUTTON IS PRIMARY. "Applied" and "not for me" are both ordinary
 * outcomes, and a blue call-to-action on either would be the interface having
 * an opinion about someone's career. The primary action on this page remains
 * reading the assessment.
 *
 * DISMISSING ASKS FIRST. Marking applied is additive — a wrong click leaves a
 * role in the wrong column and is obvious. Dismissing removes a role from
 * every screen, which is exactly the mistake someone makes at speed and does
 * not notice until they wonder where it went. One confirm step, no dialog.
 *
 * BOTH ARE REVERSIBLE, AND IT SAYS SO. Nothing here deletes anything; the
 * tracker row keeps its report, its CV and its history. Saying that out loud
 * is what makes the buttons safe to press.
 */

import { useState, useTransition } from 'react';
import { recordOutcome } from '@/app/actions';
import type { UiState } from '@/lib/status';

const NEUTRAL =
  'cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 py-2.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] disabled:cursor-not-allowed disabled:opacity-50';

export function Outcome({ roleNum, stage }: { roleNum: number; stage: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<UiState | null>(null);
  const [, startTransition] = useTransition();

  const applied = stage === 'applied' || stage === 'active';
  const closed = stage === 'closed';

  const record = (state: UiState, note?: string) => {
    setBusy(state);
    setError(null);
    startTransition(async () => {
      const result = await recordOutcome(roleNum, state, note);
      if ('error' in result) {
        setError(result.error);
        setBusy(null);
        setConfirming(false);
        return;
      }
      // Full reload rather than a router refresh: the stage change moves this
      // role between bands, columns and rail counts on every screen, and a
      // half-updated page is more confusing than a blink.
      window.location.reload();
    });
  };

  if (closed) {
    return (
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] p-5">
        <p className="font-semibold">Not going ahead with this one</p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          It stays in your tracker with its assessment. Change the status in{' '}
          <code className="rounded bg-[var(--color-paper)] px-1 py-0.5 text-[13px]">
            data/applications.md
          </code>{' '}
          if you change your mind.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] p-5">
      <p className="font-semibold">{applied ? 'You applied for this' : 'What happened?'}</p>
      <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
        {applied
          ? 'Recorded. It moves on when the company replies.'
          : 'Frontrunner cannot see the company’s site, so tell it what you did.'}
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--color-attention)] bg-[var(--color-attention-wash)] p-4">
          <p className="font-semibold text-[var(--color-attention)]">That did not save</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{error}</p>
        </div>
      )}

      {!applied && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => record('Applied', 'Applied — recorded in Frontrunner')}
            disabled={busy !== null}
            className={NEUTRAL}
          >
            {busy === 'Applied' ? 'Saving…' : 'I applied for this'}
          </button>

          {confirming ? (
            <>
              <span className="text-sm text-[var(--color-ink-soft)]">
                Remove it from your list?
              </span>
              <button
                type="button"
                onClick={() => record('Discarded', 'Not pursuing')}
                disabled={busy !== null}
                className={NEUTRAL}
              >
                {busy === 'Discarded' ? 'Saving…' : 'Yes, remove it'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy !== null}
                className="cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)]"
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy !== null}
              className="cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--color-ink-faint)] transition hover:text-[var(--color-ink-soft)]"
            >
              Not for me
            </button>
          )}
        </div>
      )}

      <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
        Nothing is deleted either way — the assessment and any CV stay in your tracker.
      </p>
    </div>
  );
}
