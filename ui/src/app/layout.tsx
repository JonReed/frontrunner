import type { Metadata } from 'next';
import Link from 'next/link';
import { HeaderNav, BottomNav } from '@/components/nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Frontrunner',
  description: 'Find the right jobs and get applications out.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Bottom padding on mobile clears the fixed nav bar. */}
      <body className="min-h-screen pb-[64px] sm:pb-0">
        <a href="#main" className="skip-link">Skip to content</a>
        <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[var(--color-paper)]">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-[17px] font-bold tracking-tight">
              Frontrunner
            </Link>
            <HeaderNav />
          </div>
        </header>
        <main id="main" className="mx-auto max-w-4xl px-6 py-10">{children}</main>
        {/*
          Footer priorities, in order:
          1. Reassurance. This audience is handing over their entire employment
             history; where it is stored and when it is sent to their selected
             model provider matters more than who built it.
          2. Attribution — quiet, and BOTH parties. Crediting the sponsor in the
             UI while the upstream project appears only in a README would
             undercut the honesty of calling this a fork. Both or neither.
        */}
        <footer className="mx-auto max-w-4xl px-6 pb-10">
          <div className="border-t border-[var(--color-line)] pt-5 text-xs leading-relaxed text-[var(--color-ink-faint)]">
            <p className="font-medium text-[var(--color-ink-soft)]">
              Your files stay on this computer. AI actions send only relevant,
              bounded context to your selected model provider.
            </p>
            <p className="mt-1.5">
              Built by{' '}
              <a
                href="https://furls.co.uk"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[var(--color-ink-soft)] underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-[var(--color-act)]"
              >
                Furls Digital
              </a>
              , on top of{' '}
              <a
                href="https://github.com/santifer/career-ops"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[var(--color-ink-soft)] underline decoration-[var(--color-line-strong)] underline-offset-2 hover:text-[var(--color-act)]"
              >
                career-ops
              </a>
              . Open source, MIT licensed.
            </p>
            {/*
              Support link, deliberately understated. Some people using this are
              out of work and short of money — a donation ask must never be a
              button, a prompt, or anything that interrupts.
            */}
            <p className="mt-1.5">
              <a
                href="https://github.com/Furls-Digital/frontrunner"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-[var(--color-line-strong)] underline-offset-2 transition hover:text-[var(--color-act)]"
              >
                Source code
              </a>
              <span className="px-1.5 text-[var(--color-line-strong)]">·</span>
              <a
                href="https://buymeacoffee.com/jonmreed"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-[var(--color-line-strong)] underline-offset-2 transition hover:text-[var(--color-act)]"
              >
                Support the project
              </a>
            </p>
          </div>
        </footer>
        <BottomNav />
      </body>
    </html>
  );
}
