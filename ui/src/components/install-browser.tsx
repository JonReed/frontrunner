'use client';

/**
 * InstallBrowser — fetch the missing piece, without a terminal.
 *
 * Building a CV renders a PDF, and the renderer is a separate download that
 * installing Frontrunner does not perform. The documented fix was
 * `npm run browser:install`, which assumes a command line this product's user
 * does not have open — so in practice the failure was permanent, and it was
 * discovered only after a model call had already been paid for.
 *
 * Deliberately honest about the size. A silent 150 MB download on someone's
 * home connection is a surprise they should get before it starts, not while
 * they wonder why the page is doing nothing.
 */

import { useEffect, useRef, useState } from 'react';
import { checkPdfBrowser, installPdfBrowser } from '@/app/actions';

export function InstallBrowser() {
  const [state, setState] = useState<'idle' | 'installing' | 'failed'>('idle');
  const polling = useRef<number | null>(null);

  useEffect(() => () => {
    if (polling.current !== null) window.clearInterval(polling.current);
  }, []);

  const install = async () => {
    setState('installing');
    const { started } = await installPdfBrowser();
    if (!started) {
      setState('failed');
      return;
    }
    // Poll rather than wait: the download runs detached so that closing the
    // tab cannot leave it half finished.
    polling.current = window.setInterval(async () => {
      const { installed } = await checkPdfBrowser();
      if (!installed) return;
      if (polling.current !== null) window.clearInterval(polling.current);
      window.location.reload();
    }, 5_000);
  };

  if (state === 'installing') {
    return (
      <div className="flex flex-wrap items-center gap-4">
        <span
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--color-ai-line)] border-t-[var(--color-ai)]"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="font-semibold">Downloading the PDF maker…</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
            A few minutes on a normal connection. This page will update itself — you can leave it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="font-semibold">One thing is missing</p>
      <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">
        Frontrunner needs a one-off download of about 150 MB to turn your CV into a PDF. It only
        has to happen once, and it does not use your AI subscription.
      </p>
      {state === 'failed' && (
        <p role="alert" className="mt-2 text-sm text-[var(--color-attention)]">
          That could not be started. Check this computer is online, then try again.
        </p>
      )}
      <button
        type="button"
        onClick={install}
        className="mt-3 cursor-pointer rounded-lg bg-[var(--color-act)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)]"
      >
        {state === 'failed' ? 'Try again' : 'Download it now'}
      </button>
    </div>
  );
}
