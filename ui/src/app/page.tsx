/**
 * "Next up" — the default screen, and the whole product in one page.
 *
 * Sorted by how close each role is to being SENT, because the point of the
 * tool is getting applications out. The first row is always the most useful
 * thing the user can do right now, so no navigation is required to start.
 *
 * Tone matters here: job hunting is discouraging, and a screen that opens with
 * "247 unscored" reads as a backlog you are failing to clear. So the headline
 * counts what is READY, and the pile of unscanned roles is a quiet aside.
 */

import Link from 'next/link';
import { readTracker, summarise, type Role, type Readiness } from '@/lib/roles';
import { Match } from '@/components/match';

export const dynamic = 'force-dynamic';

const BANDS: { key: Readiness; title: string; blurb: string }[] = [
  {
    key: 'ready-to-send',
    title: 'Ready to send',
    blurb: 'Your tailored CV is built. All that is left is to apply.',
  },
  {
    key: 'one-step-away',
    title: 'Strong matches',
    blurb: 'Read why each one fits. If you agree, build a tailored CV from there.',
  },
  {
    key: 'needs-decision',
    title: 'Worth a look',
    blurb: 'Decent matches. The assessment is already written — reading it is free.',
  },
  {
    key: 'in-flight',
    title: 'Already applied',
    blurb: 'Sent and waiting. Nothing to do unless it goes quiet.',
  },
];

function ActionButton({ role }: { role: Role }) {
  const primary = role.readiness === 'ready-to-send' || role.readiness === 'one-step-away';
  return (
    <Link
      href={`/role/${role.num}`}
      className={
        primary
          ? 'rounded-lg bg-[var(--color-act)] px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)]'
          : 'rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]'
      }
    >
      {role.nextAction.label}
    </Link>
  );
}

function RoleRow({ role }: { role: Role }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-[var(--color-line)] px-5 py-4 last:border-0 sm:flex-nowrap">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{role.company}</div>
        <div className="truncate text-sm text-[var(--color-ink-soft)]">{role.role}</div>
        <div className="mt-1.5 flex items-center gap-2">
          <Match score={role.score} />
          {role.hasPdf && (
            <span className="text-xs font-medium text-[var(--color-ready)]">CV ready</span>
          )}
        </div>
      </div>

      {/*
        Only free actions appear here. Spending the user's AI allowance is a
        decision they make on the role page, once they have read the assessment
        and actually want the thing.
      */}
      <div className="flex shrink-0 items-center gap-2.5">
        <ActionButton role={role} />
      </div>
    </li>
  );
}

function Band({ title, blurb, roles }: { title: string; blurb: string; roles: Role[] }) {
  if (roles.length === 0) return null;
  return (
    <section className="mb-10">
      <h2 className="text-base font-bold tracking-tight">
        {title} <span className="tabular font-normal text-[var(--color-ink-faint)]">{roles.length}</span>
      </h2>
      <p className="mb-3 mt-0.5 text-sm text-[var(--color-ink-soft)]">{blurb}</p>
      <ul className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-card)]">
        {roles.map((r) => (
          <RoleRow key={r.num} role={r} />
        ))}
      </ul>
    </section>
  );
}

function Headline({ ready, nearly }: { ready: number; nearly: number }) {
  if (ready > 0) {
    return (
      <>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">
          {ready} {ready === 1 ? 'application is' : 'applications are'} ready to send
        </h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          That is the highest-value thing you can do today.
        </p>
      </>
    );
  }
  if (nearly > 0) {
    return (
      <>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">
          {nearly} strong {nearly === 1 ? 'match' : 'matches'} to look at
        </h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          Each one has already been assessed against your CV. Reading that costs nothing.
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-[28px] font-bold leading-tight tracking-tight">You are all caught up</h1>
      <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
        Nothing is waiting on you right now.
      </p>
    </>
  );
}

export default async function NextUpPage() {
  const [roles, counts] = await Promise.all([readTracker(), summarise()]);
  const actionable = roles.filter((r) => r.readiness !== 'parked');

  return (
    <>
      <div className="mb-9">
        <Headline ready={counts.readyToSend} nearly={counts.oneStepAway} />
        {counts.inbox > 0 && (
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
            {counts.inbox.toLocaleString()} more roles found and not yet scored —{' '}
            <Link href="/discover" className="font-medium text-[var(--color-act)] hover:underline">
              take a look
            </Link>
            .
          </p>
        )}
      </div>

      {actionable.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-12 text-center">
          <p className="font-medium">No roles need your attention.</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            <Link href="/discover" className="text-[var(--color-act)] hover:underline">
              Find some roles
            </Link>{' '}
            to get started.
          </p>
        </div>
      ) : (
        BANDS.map((b) => (
          <Band key={b.key} title={b.title} blurb={b.blurb} roles={actionable.filter((r) => r.readiness === b.key)} />
        ))
      )}
    </>
  );
}
