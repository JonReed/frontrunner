/**
 * "Find roles" — roles the scanner has surfaced but nobody has assessed yet.
 *
 * Roles the scanner found, newest work first. Scoring one is an AI action and
 * is marked as such where it is offered; the page does not editorialise about
 * cost beyond that.
 */

import { readInbox } from '@/lib/roles';

export const dynamic = 'force-dynamic';

export default async function DiscoverPage() {
  const inbox = await readInbox();

  const byCompany = new Map<string, number>();
  for (const r of inbox) byCompany.set(r.company, (byCompany.get(r.company) ?? 0) + 1);
  const top = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  return (
    <>
      <div className="mb-8">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">
          {inbox.length.toLocaleString()} roles found
        </h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          Found by scanning the job boards you follow.
        </p>
      </div>

      {top.length > 0 && (
        <div className="mb-7">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            Where they came from
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {top.map(([company, n]) => (
              <span
                key={company}
                className="rounded-full border border-[var(--color-line)] bg-[var(--color-card)] px-2.5 py-1 text-xs text-[var(--color-ink-soft)]"
              >
                {company} <span className="tabular font-semibold text-[var(--color-ink)]">{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {inbox.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-12 text-center">
          <p className="font-medium">No new roles found yet.</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Run a search to look for openings that match your profile.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-card)]">
          {inbox.slice(0, 60).map((r) => (
            <li
              key={r.url}
              // Stacked on a phone: side by side, the title loses the space
              // fight with the button and truncates to nothing useful.
              className="flex flex-col items-start gap-2 border-b border-[var(--color-line)] px-5 py-3.5 last:border-0 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="w-full min-w-0 flex-1 sm:w-auto">
                <div className="truncate text-sm font-semibold">{r.company}</div>
                {/* Wraps on a phone, truncates on a laptop where the row is a row. */}
                <div className="text-sm text-[var(--color-ink-soft)] sm:truncate">{r.role}</div>
                <div className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">
                  {r.location}
                  {r.posted && ` · posted ${r.posted}`}
                </div>
              </div>
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                // 40px tall on a phone. This is the only control on the page,
                // and at its desktop height it was a 30px target for a thumb.
                className="inline-flex min-h-[40px] shrink-0 items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-xs font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-1.5"
              >
                View posting
              </a>
            </li>
          ))}
        </ul>
      )}
      {inbox.length > 60 && (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
          Showing 60 of {inbox.length.toLocaleString()}.
        </p>
      )}
    </>
  );
}
