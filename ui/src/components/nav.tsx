'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Navigation in the user's language, not ours.
 *
 * "Board" is jargon and "Pipeline" is sales-speak. Someone job hunting thinks
 * in four questions: what should I do now, what have I sent, what else is out
 * there, and what does it know about me. The labels answer those directly.
 */
export const NAV = [
  { href: '/', label: 'Next up' },
  { href: '/applications', label: 'My applications' },
  // Not "Find roles": nothing is found here, the scanner already did that.
  // This is where its results sit, assessed and ruled out alike.
  { href: '/found', label: 'Everything found' },
  { href: '/profile', label: 'My details' },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/**
 * Two renderings of one destination list.
 *
 * Four labels plus the wordmark do not fit across a phone — at 375px the last
 * one runs off the edge, so a quarter of the product is invisible on the
 * device people check between meetings. Hiding them behind a hamburger would
 * cost a tap on every move through what is, by design, a four-step workflow.
 *
 * So on a phone the destinations move to a fixed bottom bar: all four visible,
 * all four in thumb reach, nothing hidden. On a laptop, where they fit, they
 * stay inline in the header where navigation is expected to be.
 */
/**
 * Setup has no navigation.
 *
 * Every destination is empty until the CV exists, so offering four of them
 * during onboarding is four ways to leave a five-minute task and find nothing.
 */
function isSetup(pathname: string) {
  return pathname.startsWith('/welcome');
}

export function HeaderNav() {
  const pathname = usePathname();
  if (isSetup(pathname)) return null;
  return (
    <nav aria-label="Main" className="hidden gap-1 text-sm sm:flex">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={isActive(pathname, n.href) ? 'page' : undefined}
          className={
            isActive(pathname, n.href)
              ? 'rounded-lg bg-[var(--color-card)] px-3 py-1.5 font-semibold text-[var(--color-ink)]'
              : 'rounded-lg px-3 py-1.5 font-medium text-[var(--color-ink-soft)] transition hover:bg-[var(--color-card)] hover:text-[var(--color-ink)]'
          }
        >
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  if (isSetup(pathname)) return null;
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-line)] bg-[var(--color-paper)] sm:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="flex">
        {NAV.map((n) => {
          const active = isActive(pathname, n.href);
          return (
            <li key={n.href} className="flex-1">
              <Link
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[52px] items-center justify-center px-1 text-center text-[13px] leading-tight ${
                  active
                    ? 'font-semibold text-[var(--color-ink)] shadow-[inset_0_2px_0_0_var(--color-act)]'
                    : 'font-medium text-[var(--color-ink-soft)]'
                }`}
              >
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
