/**
 * The board — the same data as the stream, arranged by pipeline stage.
 *
 * The stream answers "what do I do next". This answers "where is everything",
 * which is the question you ask weekly rather than hourly. Same source, no
 * second state to keep in sync.
 */

import Link from 'next/link';
import { readTracker, type Role, type Stage } from '@/lib/roles';

export const dynamic = 'force-dynamic';

const COLUMNS: { key: Stage; title: string }[] = [
  { key: 'triage', title: 'Triage' },
  { key: 'prepare', title: 'Preparing' },
  { key: 'ready', title: 'Ready' },
  { key: 'applied', title: 'Applied' },
  { key: 'active', title: 'In process' },
];

function Card({ r }: { r: Role }) {
  return (
    <Link
      href={`/role/${r.num}`}
      className="block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 transition hover:border-[var(--color-accent)]"
    >
      <div className="truncate text-sm font-medium">{r.company}</div>
      <div className="mt-0.5 truncate text-xs text-[var(--color-muted)]">{r.role}</div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {r.score !== null && <span className="font-mono text-[var(--color-muted)]">{r.score.toFixed(1)}</span>}
        {r.hasPdf && <span className="text-[var(--color-ready)]">CV</span>}
      </div>
    </Link>
  );
}

export default async function BoardPage() {
  const roles = await readTracker();
  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Board</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {COLUMNS.map((c) => {
          const items = roles.filter((r) => r.stage === c.key);
          return (
            <div key={c.key} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide">{c.title}</h2>
                <span className="text-xs text-[var(--color-muted)]">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {items.length === 0 ? (
                  <p className="py-2 text-xs text-[var(--color-muted)]">Empty</p>
                ) : (
                  items.map((r) => <Card key={r.num} r={r} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
