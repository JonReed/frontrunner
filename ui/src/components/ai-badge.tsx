/**
 * AiBadge — marks an action that spends the user's AI subscription.
 *
 * This replaces a "uses tokens" chip. "Tokens" is our vocabulary, not theirs:
 * someone paying for Claude thinks in terms of a subscription with limits they
 * can use up, not a unit of billing they have never heard of.
 *
 * The badge is quiet by default and explains itself on hover or focus. It is
 * NOT a warning — using AI is the point of the product. It exists so nothing
 * ever spends their allowance without them knowing first.
 */

export function AiBadge({ what = 'write this for you' }: { what?: string }) {
  return (
    <span className="group relative inline-flex items-center">
      <span
        tabIndex={0}
        aria-describedby="ai-badge-tip"
        className="inline-flex cursor-help items-center gap-1 rounded-full border border-[var(--color-line-strong)] bg-[var(--color-card)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">
          <path d="M6 0l1.3 3.6L11 5l-3.7 1.4L6 10 4.7 6.4 1 5l3.7-1.4z" />
        </svg>
        AI
      </span>

      <span
        id="ai-badge-tip"
        role="tooltip"
        className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 w-60 rounded-lg bg-[var(--color-ink)] px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100"
      >
        Asks the AI to {what}, using a little of your AI subscription.
      </span>
    </span>
  );
}
