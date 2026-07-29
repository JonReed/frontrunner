/**
 * Connection — whether the thing that does the work is reachable.
 *
 * Every AI action spawns the Claude CLI. Until now a signed-out CLI surfaced
 * as a failure *after* the user clicked Build my CV and waited, which reads as
 * "this product is broken" rather than "sign in first".
 *
 * Two renderings of one fact:
 *
 *   <ConnectionBanner> — only when something is wrong, above the fold, on the
 *     screens that offer AI actions. Silent when connected: a green "all good"
 *     badge on every page is noise that trains people to ignore the banner
 *     that matters.
 *
 *   <ConnectionDetail> — always, on My details, where someone goes to ask
 *     what the tool knows and what it is using.
 *
 * The fix is a terminal command, and this is a product whose promise is that
 * you never need one. That tension is resolved by being specific rather than
 * apologetic: one command, copyable, with what it does. Pretending we can fix
 * it from here would be worse — signing someone in is their decision and their
 * browser, not something a local web page should initiate.
 */

import type { Health } from '@/lib/health';

const FIX = {
  install: 'https://claude.ai/code',
  signIn: 'claude auth login',
} as const;

function Command({ children }: { children: string }) {
  return (
    <code className="rounded bg-[var(--color-paper)] px-1.5 py-0.5 text-[13px] text-[var(--color-ink)]">
      {children}
    </code>
  );
}

export function ConnectionBanner({ health }: { health: Health }) {
  if (health.signedIn) return null;

  return (
    <div className="mb-8 rounded-xl border border-[var(--color-attention)] bg-[var(--color-attention-wash)] p-5">
      <p className="font-semibold text-[var(--color-attention)]">
        {health.installed ? 'Claude Code is not signed in' : 'Claude Code is not installed'}
      </p>
      <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
        {health.installed ? (
          <>
            Everything else works — scores, reports and your tracker are all here. Building a
            tailored CV needs the connection, so run <Command>{FIX.signIn}</Command> in a
            terminal once and it will keep working.
          </>
        ) : (
          <>
            Frontrunner uses Claude Code to read job adverts and write your CV. Install it from{' '}
            <a
              href={FIX.install}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--color-act)] underline underline-offset-2"
            >
              claude.ai/code
            </a>
            , sign in, then reload this page.
          </>
        )}
      </p>
    </div>
  );
}

export function ConnectionDetail({ health }: { health: Health }) {
  const rows: [string, React.ReactNode][] = [
    [
      'Status',
      health.signedIn ? (
        <span className="font-medium text-[var(--color-ready)]">Connected</span>
      ) : (
        <span className="font-medium text-[var(--color-attention)]">
          {health.installed ? 'Installed, not signed in' : 'Not installed'}
        </span>
      ),
    ],
    ['Engine', 'Claude Code'],
    ['Account', health.account ?? <span className="text-[var(--color-ink-faint)]">—</span>],
    ['Plan', health.plan ?? <span className="text-[var(--color-ink-faint)]">—</span>],
  ];

  return (
    <>
      <h2 className="mb-2 text-base font-bold tracking-tight">What runs your AI actions</h2>
      <section className="mb-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-2">
        <dl>
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="flex flex-col gap-x-6 gap-y-1 border-b border-[var(--color-line)] py-3 last:border-0 sm:flex-row"
            >
              <dt className="text-sm text-[var(--color-ink-faint)] sm:w-40 sm:shrink-0">{label}</dt>
              <dd className="min-w-0 flex-1 break-words text-[15px]">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      {!health.signedIn && (
        <p className="-mt-6 mb-8 text-sm text-[var(--color-ink-soft)]">
          {health.installed ? (
            <>
              Run <Command>{FIX.signIn}</Command> once in a terminal to connect it.
            </>
          ) : (
            <>
              Install Claude Code from{' '}
              <a
                href={FIX.install}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[var(--color-act)] underline underline-offset-2"
              >
                claude.ai/code
              </a>{' '}
              and sign in.
            </>
          )}
        </p>
      )}
    </>
  );
}
