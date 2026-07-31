'use client';

/**
 * FollowupActions — close the loop on a chase that is due.
 *
 * The home screen's highest-priority headline is the number of follow-ups
 * needing attention, and until now there was nothing anywhere in the product
 * that could clear one. Every application a user sent stayed overdue forever,
 * so within a fortnight the most prominent sentence on the first screen was a
 * count nobody could reduce.
 *
 * Three answers, because a due follow-up has three honest outcomes:
 *
 *   I have sent it   the real one. Records what was sent and how, which is
 *                    what the schedule then counts from.
 *   Not yet          moves the reminder without pretending anything was sent.
 *   (leave it)       still valid — this whole block is optional.
 *
 * "I have sent it" deliberately does not draft the message. Writing to an
 * employer on someone's behalf is a bigger act than this component should
 * carry, and the project's rule is that a person sends their own words.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { postponeFollowup, recordFollowup } from '@/app/actions';
import { FOLLOWUP_CHANNELS } from '@/lib/followup-channels.mjs';
import type { FollowupChannel } from '@/lib/followup-write';

const BUTTON =
  'inline-flex min-h-[40px] cursor-pointer items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-2';
const PRIMARY =
  'inline-flex min-h-[40px] cursor-pointer items-center rounded-lg bg-[var(--color-act)] px-3.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-2';
const FIELD =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-act)]';

/** Options offered for "not yet", in the units people actually think in. */
const SNOOZE = [
  ['In 3 days', 3],
  ['In a week', 7],
  ['In two weeks', 14],
] as const;

function isoInDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function FollowupActions({ roleNum }: { roleNum: number }) {
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'sent'>('idle');
  const [channel, setChannel] = useState<FollowupChannel>('Email');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const record = () => {
    setError(null);
    startTransition(async () => {
      const result = await recordFollowup(roleNum, channel, note.trim());
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setDone('Recorded. The next reminder is scheduled from today.');
      setMode('idle');
      setNote('');
      router.refresh();
    });
  };

  const postpone = (days: number) => {
    setError(null);
    startTransition(async () => {
      const result = await postponeFollowup(roleNum, isoInDays(days));
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setDone('Put off. Nothing was recorded as sent.');
      router.refresh();
    });
  };

  if (done) {
    return (
      <p aria-live="polite" className="text-sm text-[var(--color-ready)]">
        {done}
      </p>
    );
  }

  return (
    <div>
      {mode === 'sent' ? (
        <div className="mb-3 grid gap-3 sm:max-w-md">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold">How did you contact them?</span>
            <select
              className={FIELD}
              value={channel}
              onChange={(event) => setChannel(event.target.value as FollowupChannel)}
            >
              {FOLLOWUP_CHANNELS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold">
              Note <span className="font-normal text-[var(--color-ink-faint)]">optional</span>
            </span>
            <input
              className={FIELD}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Who you wrote to, or what you asked"
            />
          </label>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {mode === 'sent' ? (
          <>
            <button type="button" onClick={record} disabled={pending} className={PRIMARY}>
              {pending ? 'Saving…' : 'Save this follow-up'}
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              disabled={pending}
              className="min-h-[40px] cursor-pointer px-2 text-sm font-medium text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] sm:min-h-0"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setMode('sent')}
              disabled={pending}
              className={PRIMARY}
            >
              I have followed up
            </button>
            {SNOOZE.map(([label, days]) => (
              <button
                key={label}
                type="button"
                onClick={() => postpone(days)}
                disabled={pending}
                className={BUTTON}
              >
                {label}
              </button>
            ))}
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-attention)]">
          {error}
        </p>
      )}
    </div>
  );
}
