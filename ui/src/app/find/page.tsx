/**
 * Find — the phase before triage: roles discovered by the scanner but not yet
 * scored. Scanning and filtering are free; scoring is the only step that
 * spends anything, so that boundary is stated on screen rather than implied.
 */

import { readInbox } from '@/lib/roles';

export const dynamic = 'force-dynamic';

export default async function FindPage() {
  const inbox = await readInbox();
  const byCompany = new Map<string, number>();
  for (const r of inbox) byCompany.set(r.company, (byCompany.get(r.company) ?? 0) + 1);
  const top = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{inbox.length} found, not yet scored</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Scanning and filtering cost nothing. Scoring is the only step that uses your subscription.
        </p>
      </div>

      {top.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {top.map(([company, n]) => (
            <span
              key={company}
              className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)]"
            >
              {company} <span className="text-[var(--color-text)]">{n}</span>
            </span>
          ))}
        </div>
      )}

      <ul className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        {inbox.slice(0, 100).map((r) => (
          <li
            key={r.url}
            className="flex items-center gap-4 border-b border-[var(--color-border)] px-4 py-3 last:border-0 hover:bg-[var(--color-surface)]"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <span className="font-medium">{r.company}</span>
                <span className="text-[var(--color-muted)]"> · {r.role}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                {r.location}
                {r.posted && ` · posted ${r.posted}`}
              </div>
            </div>
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-sm text-[var(--color-muted)] underline underline-offset-2 hover:text-[var(--color-text)]"
            >
              posting
            </a>
          </li>
        ))}
      </ul>
      {inbox.length > 100 && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">Showing the first 100 of {inbox.length}.</p>
      )}
    </>
  );
}
