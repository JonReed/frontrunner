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
  { href: '/', label: 'Next up', mobileLabel: 'Today', icon: 'home' },
  { href: '/applications', label: 'My applications', mobileLabel: 'Applications', icon: 'roles' },
  // Not "Find roles": nothing is found here, the scanner already did that.
  // This is where its results sit, assessed and ruled out alike.
  { href: '/found', label: 'Everything found', mobileLabel: 'Found', icon: 'search' },
  { href: '/profile', label: 'My details', mobileLabel: 'Profile', icon: 'profile' },
] as const;

function NavIcon({ name }: { name: (typeof NAV)[number]['icon'] }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (name === 'home') {
    return <svg {...common}><path d="m4 11 8-7 8 7v9H4Z" /><path d="M9 20v-6h6v6" /></svg>;
  }
  if (name === 'roles') {
    return <svg {...common}><rect x="4" y="6" width="16" height="14" rx="2" /><path d="M9 6V4h6v2M4 11h16M10 11v2h4v-2" /></svg>;
  }
  if (name === 'search') {
    return <svg {...common}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>;
  }
  return <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6" /></svg>;
}

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
    <nav aria-label="Main" className="hidden items-center gap-6 text-[13px] sm:flex">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={isActive(pathname, n.href) ? 'page' : undefined}
          className={
            isActive(pathname, n.href)
              ? 'relative py-2 font-semibold text-[var(--color-ink)] after:absolute after:inset-x-0 after:-bottom-[16px] after:h-0.5 after:rounded-full after:bg-[var(--color-act)]'
              : 'py-2 font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)]'
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
      className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-line)] bg-[color:var(--color-paper-translucent)] backdrop-blur-md sm:hidden"
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
                className={`flex min-h-[58px] flex-col items-center justify-center gap-0.5 px-1 text-center text-[11px] leading-tight ${
                  active
                    ? 'font-semibold text-[var(--color-act)]'
                    : 'font-medium text-[var(--color-ink-soft)]'
                }`}
              >
                <NavIcon name={n.icon} />
                {n.mobileLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
