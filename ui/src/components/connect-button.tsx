'use client';

/**
 * ConnectButton — sign the Claude CLI in without opening a terminal.
 *
 * This exists because Claude Code and the Claude desktop app keep separate
 * credentials (anthropics/claude-code#62206). Someone can install the app,
 * sign into it, use it to set Frontrunner up, open the UI — and still have an
 * unauthenticated CLI. Left alone, they discover that when their first CV
 * build fails, and the fix is a terminal command, which is the exact failure
 * this project says it will not ship.
 *
 * The flow is three states and no lies about any of them:
 *
 *   idle      one button
 *   waiting   the browser has opened; polling until the CLI reports signed in
 *   stuck     it has been a while — say so, and give the command as a fallback
 *
 * It never claims success it has not observed. "Signed in" appears only after
 * `claude auth status` says so, because the alternative is telling someone
 * they are connected and letting them find out otherwise on a paid action.
 */

import { useEffect, useRef, useState } from 'react';
import { connectEngine, checkConnected } from '@/app/actions';

const POLL_MS = 2_000;
/** After this, stop implying it is still working and offer the manual route. */
const PATIENCE_MS = 90_000;

type State = 'idle' | 'waiting' | 'stuck' | 'failed';

export function ConnectButton() {
  const [state, setState] = useState<State>('idle');
  const startedAt = useRef(0);

  useEffect(() => {
    if (state !== 'waiting') return;
    const poll = setInterval(async () => {
      const { signedIn } = await checkConnected();
      if (signedIn) {
        clearInterval(poll);
        // Full reload: every screen's connection state and every gated AI
        // action was rendered while this was false.
        window.location.reload();
        return;
      }
      if (Date.now() - startedAt.current > PATIENCE_MS) {
        clearInterval(poll);
        setState('stuck');
      }
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [state]);

  const connect = async () => {
    startedAt.current = Date.now();
    setState('waiting');
    const { started } = await connectEngine();
    if (!started) setState('failed');
  };

  if (state === 'waiting') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-line-strong)] border-t-[var(--color-act)]"
          aria-hidden="true"
        />
        <p className="text-sm text-[var(--color-ink-soft)]">
          Finish signing in in the browser window that just opened. This page will update on its
          own.
        </p>
      </div>
    );
  }

  if (state === 'stuck' || state === 'failed') {
    return (
      <div>
        <p className="text-sm font-semibold">
          {state === 'failed' ? 'That did not start' : 'Still not connected'}
        </p>
        <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
          {state === 'failed'
            ? 'Claude Code could not be started here.'
            : 'The sign-in has not completed yet.'}{' '}
          You can also run{' '}
          <code className="rounded bg-[var(--color-paper)] px-1.5 py-0.5 text-[13px] text-[var(--color-ink)]">
            claude auth login
          </code>{' '}
          yourself, then reload.
        </p>
        <button
          type="button"
          onClick={connect}
          className="mt-3 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={connect}
      className="cursor-pointer rounded-lg bg-[var(--color-act)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)]"
    >
      Connect Claude Code
    </button>
  );
}
