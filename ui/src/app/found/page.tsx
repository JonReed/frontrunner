/**
 * "Everything found" — step one of the process, both halves of it.
 *
 * This screen was called "Find roles", which was wrong: nothing is found here.
 * The scanner already did that. What sits here is the result — every role it
 * turned up, in the two states it can leave them in.
 *
 *   Not assessed yet   nothing has judged these. They are simply queued.
 *   Ruled out          a deterministic rule in config/prefilter.yml matched,
 *                      and the role was dropped before any model call.
 *
 * The second half was previously invisible. batch/prefilter-rejects.tsv was
 * written and never read, so roles vanished with no way to see them or
 * disagree — a bad default when the judgement came from a config file rather
 * than an assessment. Each one now shows the rule that fired and the evidence
 * that triggered it, so the user can see exactly what was decided on their
 * behalf.
 *
 * Neither half offers an AI action yet: assessing a role costs the user's
 * allowance and that path is not built. Showing the pile honestly comes first;
 * an interface that hides its own filtering has not earned the right to spend
 * anything.
 */

import { readInbox, readTracker } from '@/lib/roles';
import { readRejects, groupByRule } from '@/lib/rejects';
import { PipelineOverview } from '@/components/journey-rail';
import { pipelineCounts } from '@/lib/journey';
import { InboxAction } from '@/components/inbox-action';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Everything found' };

const LIST = 'overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] shadow-[0_1px_2px_rgb(26_25_23/0.035)]';
const ROW =
  'flex flex-col items-start gap-2 border-b border-[var(--color-line)] px-5 py-4 transition last:border-0 hover:bg-[var(--color-paper)] sm:flex-row sm:items-center sm:gap-4 sm:px-6';
const POSTING_LINK =
  'inline-flex min-h-[40px] shrink-0 items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-xs font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-1.5';

export default async function FoundPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; company?: string; location?: string }>;
}) {
  const filters = await searchParams;
  const [inbox, rejects, roles] = await Promise.all([readInbox(), readRejects(), readTracker()]);
  const q = (filters.q ?? '').trim().toLowerCase();
  const company = (filters.company ?? '').trim();
  const location = (filters.location ?? '').trim().toLowerCase();
  const filteredInbox = inbox.filter((role) => (
    (!q || role.role.toLowerCase().includes(q))
    && (!company || role.company === company)
    && (!location || role.location.toLowerCase().includes(location))
  ));
  const filteredRejects = rejects.filter((role) => (
    (!q || role.role.toLowerCase().includes(q))
    && (!company || role.company === company)
  ));
  const grouped = groupByRule(filteredRejects);
  const filtering = Boolean(q || company || location);
  const companies = [...new Set(inbox.map((role) => role.company).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const byCompany = new Map<string, number>();
  for (const r of inbox) byCompany.set(r.company, (byCompany.get(r.company) ?? 0) + 1);
  const top = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  return (
    <>
      <PipelineOverview counts={pipelineCounts(roles, inbox.length)} active="inbox" />

      <div className="mb-9">
        <h1 className="text-[30px] font-bold leading-tight tracking-[-0.025em] sm:text-[34px]">Everything found</h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          Unassessed roles and the ones your filters ruled out.
        </p>
      </div>

      <form
        method="get"
        className="mb-9 grid gap-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-paper-deep)] p-4 sm:grid-cols-3 sm:p-5"
      >
        <label className="text-xs font-medium text-[var(--color-ink-soft)]">
          Role title
          <input
            type="search"
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="e.g. Product Director"
            className="mt-1.5 block min-h-[42px] w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-ink)] shadow-[0_1px_1px_rgb(26_25_23/0.03)]"
          />
        </label>
        <label className="text-xs font-medium text-[var(--color-ink-soft)]">
          Company
          <select
            name="company"
            defaultValue={company}
            className="mt-1.5 block min-h-[42px] w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-ink)] shadow-[0_1px_1px_rgb(26_25_23/0.03)]"
          >
            <option value="">Every company</option>
            {companies.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-[var(--color-ink-soft)]">
          Location
          <input
            type="search"
            name="location"
            defaultValue={filters.location ?? ''}
            placeholder="e.g. London"
            className="mt-1.5 block min-h-[42px] w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-sm text-[var(--color-ink)] shadow-[0_1px_1px_rgb(26_25_23/0.03)]"
          />
        </label>
        <div className="flex items-center gap-3 sm:col-span-3">
          <button
            type="submit"
            className="min-h-[40px] cursor-pointer rounded-lg bg-[var(--color-act)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-act-hover)]"
          >
            Filter roles
          </button>
          {filtering && (
            <Link href="/found" className="text-sm text-[var(--color-ink-faint)] hover:text-[var(--color-act)]">
              Clear filters
            </Link>
          )}
        </div>
      </form>

      {top.length > 0 && (
        <div className="mb-7">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-faint)]">
            Where they came from
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {top.map(([name, n]) => (
              <Link
                key={name}
                href={`/found?company=${encodeURIComponent(name)}`}
                className="rounded-full border border-[var(--color-line)] bg-[var(--color-card)] px-2.5 py-1 text-xs text-[var(--color-ink-soft)] transition hover:border-[var(--color-line-strong)] hover:text-[var(--color-act)]"
              >
                {name} <span className="tabular font-semibold text-[var(--color-ink)]">{n}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <section className="mb-10">
        <h2 className="text-base font-bold tracking-tight">
          Not assessed yet{' '}
          <span className="tabular font-normal text-[var(--color-ink-faint)]">{inbox.length}</span>
        </h2>
        <p className="mb-3 mt-0.5 text-sm text-[var(--color-ink-soft)]">
          {filtering
            ? `Showing ${filteredInbox.length} of ${inbox.length}.`
            : 'Queued. Nothing has judged these either way.'}
        </p>

        {filteredInbox.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-10 text-center">
            <p className="font-medium">Nothing waiting.</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Run a search to look for openings that match your profile.
            </p>
          </div>
        ) : (
          <ul className={LIST}>
            {filteredInbox.slice(0, 60).map((r) => (
              <li key={r.url} className={ROW}>
                <div className="w-full min-w-0 flex-1 sm:w-auto">
                  <div className="truncate text-sm font-semibold">{r.company}</div>
                  <div className="text-sm text-[var(--color-ink-soft)] sm:truncate">{r.role}</div>
                  <div className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">
                    {r.location}
                    {r.posted && ` · posted ${r.posted}`}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a href={r.url} target="_blank" rel="noreferrer" className={POSTING_LINK}>
                    View posting
                  </a>
                  <InboxAction url={r.url} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {filteredInbox.length > 60 && (
          <p className="mt-3 text-xs text-[var(--color-ink-faint)]">
            Showing 60 of {filteredInbox.length.toLocaleString()} matching roles.
          </p>
        )}
      </section>

      {filteredRejects.length > 0 && (
        <section className="mb-10">
          <h2 className="text-base font-bold tracking-tight">
            Ruled out{' '}
            <span className="tabular font-normal text-[var(--color-ink-faint)]">
              {filteredRejects.length}
            </span>
          </h2>
          <p className="mb-4 mt-0.5 text-sm text-[var(--color-ink-soft)]">
            Dropped by your own filters before costing anything. Grouped by the rule that ruled
            them out — if a rule looks wrong, it is yours to change.
          </p>

          <div className="flex flex-col gap-3">
            {grouped.map((g) => (
              <details
                key={g.rule}
                className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] shadow-[0_1px_2px_rgb(26_25_23/0.03)]"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4 hover:bg-[var(--color-paper)]">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{g.label}</span>
                    {/*
                      The literal key from config/prefilter.yml. Shown because
                      this is a judgement made on the user's behalf and they
                      should be able to find the thing that made it — but not
                      in monospace, which would make their own config look
                      like source code they are not allowed to touch.
                    */}
                    <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">
                      Rule: {g.rule}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-sm text-[var(--color-ink-soft)]">
                    {g.roles.length}
                  </span>
                </summary>
                <ul className="border-t border-[var(--color-line)]">
                  {g.roles.slice(0, 25).map((r) => (
                    <li key={r.url} className={ROW}>
                      <div className="w-full min-w-0 flex-1 sm:w-auto">
                        <div className="truncate text-sm font-semibold">{r.company}</div>
                        <div className="text-sm text-[var(--color-ink-soft)] sm:truncate">
                          {r.role}
                        </div>
                        {r.evidence && (
                          <div className="mt-0.5 text-xs text-[var(--color-ink-faint)]">
                            Matched on “{r.evidence}”
                          </div>
                        )}
                      </div>
                      <a href={r.url} target="_blank" rel="noreferrer" className={POSTING_LINK}>
                        View posting
                      </a>
                    </li>
                  ))}
                </ul>
                {g.roles.length > 25 && (
                  <p className="border-t border-[var(--color-line)] px-5 py-3 text-xs text-[var(--color-ink-faint)]">
                    Showing 25 of {g.roles.length}.
                  </p>
                )}
              </details>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
