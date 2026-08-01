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
 * Which kind of sign-in problem a failure message describes, or null when it is
 * not one.
 *
 * The two cases need different words. Someone who connected last week and was
 * timed out is told their sign-in expired. Someone who has never connected —
 * every first-run user — must not be, because "expired" describes a thing that
 * never happened to them and sends them looking for a session to restore.
 *
 * Matched on the CLI's own wording plus the plain-language text the backend
 * maps it to, so this works whether the message reached us raw or translated.
 */
export function signInFailureKind(
  message: string | null | undefined,
): 'expired' | 'not-connected' | null {
  const text = String(message ?? '');
  // Checked first: the CLI's expiry line is "Failed to authenticate: OAuth
  // session expired and could not be refreshed", so the generic authenticate
  // wording must not be allowed to claim it for the never-connected branch.
  if (/sign-in has expired|session expired|could not be refreshed|failed to authenticate|oauth/iu.test(text)) {
    return 'expired';
  }
  if (/not signed in|not logged in|connect your (claude|ai) subscription|\/login/iu.test(text)) {
    return 'not-connected';
  }
  return null;
}

/** Whether a failure message describes a sign-in problem of either kind. */
export function isSignInFailure(message: string | null | undefined): boolean {
  return signInFailureKind(message) !== null;
}

export function ReconnectNotice({ message }: { message: string }) {
  const kind = signInFailureKind(message);
  const heading = kind === 'not-connected'
    ? 'Connect your Claude subscription'
    : 'Your Claude sign-in has expired';

  return (
    <div>
      <p className="font-semibold text-[var(--color-attention)]">
        {heading}
      </p>
      <p className="mt-0.5 max-w-lg text-sm text-[var(--color-ink-soft)]">
        {message} {kind === 'not-connected' ? 'Connecting' : 'Reconnecting'} opens your browser once
        and takes a few seconds — nothing was charged for the attempt that failed.
      </p>
      <div className="mt-3">
        <ConnectButton />
      </div>
    </div>
  );
}
