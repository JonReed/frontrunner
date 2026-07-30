/**
 * AiButton — the single component for any action that spends AI allowance.
 *
 * Two signals, both carried by the button itself so nothing has to be read:
 *   colour   violet, used nowhere else in the product
 *   mark     the sparkle, inline before the label
 *
 * Making it one component rather than a style guideline means an AI action
 * cannot accidentally be styled like an ordinary one. If it spends, it looks
 * like this.
 *
 * The hover text says what the AI will actually do, in the user's terms.
 */

'use client';

import { useId, useRef, useState } from 'react';

export function Sparkle({ className = '' }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor" className={className}>
      <path d="M6 0l1.3 3.6L11 5l-3.7 1.4L6 10 4.7 6.4 1 5l3.7-1.4z" />
      <path d="M10.4 7.8l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4L8.5 9.7l1.4-.5z" opacity=".65" />
    </svg>
  );
}

export function AiButton({
  children,
  what,
  size = 'md',
  onPointerEnter,
  onFocus,
  ...rest
}: {
  children: React.ReactNode;
  /** Plain-language description of the work, e.g. "rewrite your CV for this job". */
  what: string;
  size?: 'sm' | 'md';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const pad = size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2.5 text-sm';
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const tooltipId = useId();

  const placeTooltip = () => {
    const button = buttonRef.current;
    const tooltip = tooltipRef.current;
    if (!button || !tooltip) return;

    const buttonBox = button.getBoundingClientRect();
    const tooltipHeight = tooltip.offsetHeight;
    // A sticky header obscures a conventional "above" tooltip near the top
    // of the viewport. Prefer below there, unless the fixed mobile navigation
    // would obscure it instead.
    const clearAbove = buttonBox.top - tooltipHeight - 8 >= 96;
    const clearBelow = window.innerHeight - buttonBox.bottom - tooltipHeight - 8 >= 72;
    setPlacement(clearAbove || !clearBelow ? 'above' : 'below');
  };

  const tooltipPosition = placement === 'above'
    ? 'bottom-full right-0 mb-2'
    : 'top-full right-0 mt-2';

  return (
    <span className="group relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-describedby={tooltipId}
        onPointerEnter={(event) => {
          placeTooltip();
          onPointerEnter?.(event);
        }}
        onFocus={(event) => {
          placeTooltip();
          onFocus?.(event);
        }}
        {...rest}
        className={`inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-ai)] font-semibold text-white transition hover:bg-[var(--color-ai-hover)] disabled:cursor-not-allowed disabled:opacity-60 ${pad}`}
      >
        <Sparkle />
        {children}
      </button>

      <span
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute z-30 w-64 rounded-lg bg-[var(--color-ink)] px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100 ${tooltipPosition}`}
      >
        Asks the AI to {what}, using a little of your AI subscription.
      </span>
    </span>
  );
}
