'use client';

/**
 * ReconnectNotice — an expired sign-in, with the fix attached.
 *
 * A session that expires mid-use is the most common way an AI action fails,
 * and the failure used to end in a sentence pointing at another screen: "go to
 * My details and reconnect". For someone who is not a developer that is a
 * navigation puzzle at the exact moment they wanted a result — and the button
 * that solves it already exists.
 *
 * So the failure carries the remedy. The same ConnectButton the banner uses,
 * rendered where the thing actually broke.
 *
 * Detection is deliberately message-based rather than a fresh health check.
 * `claude auth status` keeps reporting a live session until something forces a
 * refresh, so the failed run is the first honest signal there is — asking
 * again at this point would be told everything is fine.
 */

import { ConnectButton } from './connect-button';

/**
 * Whether a failure message describes a sign-in problem.
 *
 * Matched on the CLI's own wording plus the plain-language text the backend
 * maps it to, so this keeps working whether the message reached us raw or
 * already translated.
 */
export function isSignInFailure(message: string | null | undefined): boolean {
  return /sign-in has expired|session expired|could not be refreshed|failed to authenticate|not signed in|not logged in|connect your (claude|ai) subscription/iu
    .test(String(message ?? ''));
}

export function ReconnectNotice({ message }: { message: string }) {
  return (
    <div>
      <p className="font-semibold text-[var(--color-attention)]">
        Your Claude sign-in has expired
      </p>
      <p className="mt-0.5 max-w-lg text-sm text-[var(--color-ink-soft)]">
        {message} Reconnecting opens your browser once and takes a few seconds — nothing was
        charged for the attempt that failed.
      </p>
      <div className="mt-3">
        <ConnectButton />
      </div>
    </div>
  );
}
