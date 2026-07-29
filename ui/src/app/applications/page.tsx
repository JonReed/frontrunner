/**
 * "My applications" — the same roles as the stream, arranged by stage.
 *
 * The stream answers "what do I do next", which is an hourly question. This
 * answers "where does everything stand", which is a weekly one. Same source of
 * truth, no second state to drift.
 *
 * Job hunting is mostly waiting and rejection, so seeing progress laid out
 * matters more than it would in a work tool. The columns move left to right in
 * the direction things should travel.
 */

import Link from 'next/link';
import { readTracker, type Role, type Stage } from '@/lib/roles';
import { matchOf } from '@/components/match';

export const dynamic = 'force-dynamic';

const COLUMNS: { key: Stage; title: string; hint: string }[] = [
  { key: 'triage', title: 'Deciding', hint: 'Worth a look' },
  { key: 'prepare', title: 'Preparing', hint: 'Needs a CV' },
  { key: 'ready', title: 'Ready', hint: 'Go apply' },
  { key: 'applied', title: 'Applied', hint: 'Waiting' },
  { key: 'active', title: 'In process', hint: 'They replied' },
];

function Card({ role }: { role: Role }) {
  const { tone } = matchOf(role.score);
  const accent =
    tone === 'excellent' || tone === 'strong'
      ? 'border-l-[var(--color-ready)]'
      : tone === 'possible'
        ? 'border-l-[var(--color-attention)]'
        : 'border-l-[var(--color-line-strong)]';
  return (
    <Link
      href={`/role/${role.num}`}
      className={`block rounded-lg border border-[var(--color-line)] border-l-[3px] bg-[var(--color-card)] p-3 transition hover:border-[var(--color-act)] hover:shadow-sm ${accent}`}
    >
      <div className="truncate text-sm font-semibold">{role.company}</div>
      <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-[var(--color-ink-soft)]">{role.role}</div>
      {role.hasPdf && <div className="mt-2 text-xs font-medium text-[var(--color-ready)]">CV ready</div>}
    </Link>
  );
}

export default async function ApplicationsPage() {
  const roles = await readTracker();
  const live = roles.filter((r) => r.stage !== 'closed');

  return (
    <>
      <div className="mb-8">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">My applications</h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          {live.length} roles in progress, in the order things move.
        </p>
      </div>

      {/*
        One column per stage on a phone, five across on a laptop.

        Deliberately not a wrapped board: at two columns the stages run
        1 2 / 3 4 / 5, which puts the last stage under the third and destroys
        the progression the whole layout exists to show. Stacked, the order is
        still the order — it just reads downwards.
      */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {COLUMNS.map((c) => {
          const items = roles.filter((r) => r.stage === c.key);
          return (
            <div key={c.key} className="rounded-xl bg-[var(--color-line)]/40 p-2.5">
              <div className="mb-2.5 px-1">
                <h2 className="text-sm font-bold">
                  {c.title} <span className="tabular font-normal text-[var(--color-ink-faint)]">{items.length}</span>
                </h2>
                <p className="text-[11px] text-[var(--color-ink-faint)]">{c.hint}</p>
              </div>
              <div className="flex flex-col gap-2">
                {items.length === 0 ? (
                  <p className="px-1 py-3 text-xs text-[var(--color-ink-faint)]">Nothing here yet</p>
                ) : (
                  items.map((r) => <Card key={r.num} role={r} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
