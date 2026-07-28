import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Frontrunner',
  description: 'Find the right jobs and get applications out.',
};

/**
 * Navigation in the user's language, not ours.
 *
 * "Board" is jargon and "Pipeline" is sales-speak. Someone job hunting thinks
 * in three questions: what should I do now, what have I sent, and what else is
 * out there. The labels answer those directly.
 */
const NAV = [
  { href: '/', label: 'Next up' },
  { href: '/applications', label: 'My applications' },
  { href: '/discover', label: 'Find roles' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-[var(--color-paper)]/90 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-[17px] font-bold tracking-tight">
              Frontrunner
            </Link>
            <nav className="flex gap-1 text-sm">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded-lg px-3 py-1.5 font-medium text-[var(--color-ink-soft)] transition hover:bg-[var(--color-card)] hover:text-[var(--color-ink)]"
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
        <footer className="mx-auto max-w-4xl px-6 pb-10 text-xs text-[var(--color-ink-faint)]">
          Your CV, notes and applications stay on this computer.
        </footer>
      </body>
    </html>
  );
}
