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

export const dynamic = 'force-dynamic';

const LIST = 'overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-card)]';
const ROW =
  'flex flex-col items-start gap-2 border-b border-[var(--color-line)] px-5 py-3.5 last:border-0 sm:flex-row sm:items-center sm:gap-4';
const POSTING_LINK =
  'inline-flex min-h-[40px] shrink-0 items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 text-xs font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-1.5';

export default async function FoundPage() {
  const [inbox, rejects, roles] = await Promise.all([readInbox(), readRejects(), readTracker()]);
  const grouped = groupByRule(rejects);
  const total = inbox.length + rejects.length;

  const byCompany = new Map<string, number>();
  for (const r of inbox) byCompany.set(r.company, (byCompany.get(r.company) ?? 0) + 1);
  const top = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  return (
    <>
      <div className="mb-8">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">
          {total.toLocaleString()} roles found
        </h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          Everything the scanner turned up. Nothing here has been assessed against your CV.
        </p>
      </div>

      <PipelineOverview counts={pipelineCounts(roles, inbox.length)} active="inbox" />

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

      <section className="mb-10">
        <h2 className="text-base font-bold tracking-tight">
          Not assessed yet{' '}
          <span className="tabular font-normal text-[var(--color-ink-faint)]">{inbox.length}</span>
        </h2>
        <p className="mb-3 mt-0.5 text-sm text-[var(--color-ink-soft)]">
          Queued. Nothing has judged these either way.
        </p>

        {inbox.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-10 text-center">
            <p className="font-medium">Nothing waiting.</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Run a search to look for openings that match your profile.
            </p>
          </div>
        ) : (
          <ul className={LIST}>
            {inbox.slice(0, 60).map((r) => (
              <li key={r.url} className={ROW}>
                <div className="w-full min-w-0 flex-1 sm:w-auto">
                  <div className="truncate text-sm font-semibold">{r.company}</div>
                  <div className="text-sm text-[var(--color-ink-soft)] sm:truncate">{r.role}</div>
                  <div className="mt-0.5 truncate text-xs text-[var(--color-ink-faint)]">
                    {r.location}
                    {r.posted && ` · posted ${r.posted}`}
                  </div>
                </div>
                <a href={r.url} target="_blank" rel="noreferrer" className={POSTING_LINK}>
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
      </section>

      {rejects.length > 0 && (
        <section className="mb-10">
          <h2 className="text-base font-bold tracking-tight">
            Ruled out{' '}
            <span className="tabular font-normal text-[var(--color-ink-faint)]">
              {rejects.length}
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
                className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-card)]"
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
