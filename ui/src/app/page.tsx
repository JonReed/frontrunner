/**
 * The stream — the default screen, and the whole point of the UI.
 *
 * One list, sorted by how close each role is to being SENT. No navigation
 * required: the first row is the most useful thing you can do right now, and
 * every row carries its own next action rather than making you go and find it.
 */

import Link from 'next/link';
import { readTracker, summarise, type Role, type Readiness } from '@/lib/roles';

export const dynamic = 'force-dynamic';

const BANDS: { key: Readiness; title: string; blurb: string }[] = [
  { key: 'ready-to-send', title: 'Ready to send', blurb: 'CV is built. Open the posting and apply.' },
  { key: 'one-step-away', title: 'One step away', blurb: 'Strong match. Needs a tailored CV.' },
  { key: 'needs-decision', title: 'Needs your call', blurb: 'Close, but worth reading before you spend effort.' },
  { key: 'in-flight', title: 'In flight', blurb: 'Already sent. Waiting or interviewing.' },
];

function Score({ score }: { score: number | null }) {
  if (score === null) return <span className="text-[var(--color-muted)]">—</span>;
  const tone =
    score >= 4 ? 'text-[var(--color-ready)]' : score >= 3 ? 'text-[var(--color-soon)]' : 'text-[var(--color-muted)]';
  return <span className={`font-mono text-sm ${tone}`}>{score.toFixed(1)}</span>;
}

function RoleRow({ r }: { r: Role }) {
  return (
    <li className="flex items-center gap-4 border-b border-[var(--color-border)] px-4 py-3 last:border-0 hover:bg-[var(--color-surface)]">
      <Score score={r.score} />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className="font-medium">{r.company}</span>
          <span className="text-[var(--color-muted)]"> · {r.role}</span>
        </div>
        <div className="mt-0.5 text-xs text-[var(--color-muted)]">
          {r.status}
          {r.hasPdf && <span className="text-[var(--color-ready)]"> · CV ready</span>}
          {r.notes && <span className="hidden sm:inline"> · {r.notes.slice(0, 60)}</span>}
        </div>
      </div>

      {r.nextAction.kind !== 'none' && (
        <div className="flex shrink-0 items-center gap-2">
          {r.nextAction.costsTokens && (
            <span
              title="This action asks the model to do work, so it uses your subscription."
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-muted)]"
            >
              uses tokens
            </span>
          )}
          <Link
            href={`/role/${r.num}`}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-black transition hover:opacity-90"
          >
            {r.nextAction.label}
          </Link>
        </div>
      )}
    </li>
  );
}

function Band({ title, blurb, roles }: { title: string; blurb: string; roles: Role[] }) {
  if (roles.length === 0) return null;
  return (
    <section className="mb-8">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
        <span className="text-xs text-[var(--color-muted)]">{roles.length}</span>
      </div>
      <p className="mb-3 text-sm text-[var(--color-muted)]">{blurb}</p>
      <ul className="overflow-hidden rounded-lg border border-[var(--color-border)]">
        {roles.map((r) => (
          <RoleRow key={r.num} r={r} />
        ))}
      </ul>
    </section>
  );
}

export default async function StreamPage() {
  const [roles, counts] = await Promise.all([readTracker(), summarise()]);
  const actionable = roles.filter((r) => r.readiness !== 'parked');

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          {counts.readyToSend > 0
            ? `${counts.readyToSend} ready to send`
            : counts.oneStepAway > 0
              ? `${counts.oneStepAway} nearly ready`
              : 'Nothing waiting on you'}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {counts.inbox > 0 ? (
            <>
              {counts.inbox} unscored in the{' '}
              <Link href="/find" className="text-[var(--color-accent)] underline underline-offset-2">
                inbox
              </Link>
              .{' '}
            </>
          ) : null}
          {counts.parked > 0 && `${counts.parked} parked and out of the way.`}
        </p>
      </div>

      {actionable.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] p-10 text-center">
          <p className="text-[var(--color-muted)]">
            No roles need action.{' '}
            <Link href="/find" className="text-[var(--color-accent)] underline underline-offset-2">
              Find some
            </Link>
            .
          </p>
        </div>
      ) : (
        BANDS.map((b) => (
          <Band
            key={b.key}
            title={b.title}
            blurb={b.blurb}
            roles={actionable.filter((r) => r.readiness === b.key)}
          />
        ))
      )}
    </>
  );
}
