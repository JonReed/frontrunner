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
import { redirect } from 'next/navigation';
import { readTracker, summarise, type Role, type Readiness } from '@/lib/roles';
import { readSetup } from '@/lib/setup';
import { Match } from '@/components/match';
import { CvLinks } from '@/components/cv-links';
import { PipelineOverview } from '@/components/journey-rail';
import { pipelineCounts } from '@/lib/journey';

export const dynamic = 'force-dynamic';

const BANDS: { key: Readiness; title: string; blurb: string }[] = [
  {
    key: 'ready-to-send',
    title: 'Ready to send',
    blurb: 'CV built. Apply on the company site.',
  },
  {
    key: 'one-step-away',
    title: 'Strong matches',
    blurb: 'Read why each fits, then build a CV if you agree.',
  },
  {
    key: 'needs-decision',
    title: 'Worth a look',
    blurb: 'Worth a few minutes of your judgement.',
  },
  {
    key: 'in-flight',
    title: 'Already applied',
    blurb: 'Sent. Nothing to do unless it goes quiet.',
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

/**
 * Stacked on a phone, single row on a laptop.
 *
 * Not a cosmetic breakpoint: as one row, the title block and the action block
 * both compete for 375px, and because the title is min-w-0 it loses — the role
 * collapses to "Engine…" while a button sits beside it. The row has to become
 * two rows, not a narrower version of itself.
 */
function RoleRow({ role }: { role: Role }) {
  return (
    <li className="flex flex-col items-stretch gap-3 border-b border-[var(--color-line)] px-5 py-4 last:border-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="w-full min-w-0 flex-1 sm:w-auto">
        <div className="truncate text-[15px] font-semibold">{role.company}</div>
        {/* Wraps on a phone, truncates on a laptop where the row is a row. */}
        <div className="text-sm text-[var(--color-ink-soft)] sm:truncate">{role.role}</div>
        <div className="mt-1.5 flex items-center gap-2">
          <Match score={role.score} />
          {role.hasPdf && (
            <span className="text-xs font-medium text-[var(--color-ready)]">CV ready</span>
          )}
        </div>
      </div>

      {/*
        Only free actions appear here. Spending the user's AI allowance is a
        decision made on the role page, after reading the assessment.

        The posting link sits alongside deliberately: people do not fully trust
        an AI's opinion of a job, and should not have to. The real advert is
        always one click away, from every screen that shows a verdict.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        {role.pdf && <CvLinks pdf={role.pdf} size="sm" />}
        {role.url && (
          <a
            href={role.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[40px] items-center text-sm text-[var(--color-ink-faint)] underline decoration-[var(--color-line-strong)] underline-offset-2 transition hover:text-[var(--color-act)] sm:min-h-0"
          >
            View posting
          </a>
        )}
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
          Already assessed against your CV.
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
  // First run goes to setup rather than to an empty screen. Without this, a
  // new installation opens on "You are all caught up" — technically true, and
  // completely baffling.
  if (readSetup().needed) redirect('/welcome');

  const [roles, counts] = await Promise.all([readTracker(), summarise()]);
  const actionable = roles.filter((r) => r.readiness !== 'parked');

  /*
    The whole process in one row of numbers, above everything else.

    This screen shows what to do next, which is the right default but a narrow
    view: someone looking at six strong matches could not tell that hundreds of
    roles sat behind them, or that anything existed after "Applied". The counts
    make the shape of the pipeline visible without leaving the page.
  */
  const stageCounts = pipelineCounts(roles, counts.inbox);

  return (
    <>
      <div className="mb-7">
        <Headline ready={counts.readyToSend} nearly={counts.oneStepAway} />
        {counts.inbox > 0 && (
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
            {counts.inbox.toLocaleString()} more roles found and not yet scored —{' '}
            <Link href="/found" className="font-medium text-[var(--color-act)] hover:underline">
              take a look
            </Link>
            .
          </p>
        )}
      </div>

      <PipelineOverview counts={stageCounts} />

      {actionable.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-12 text-center">
          <p className="font-medium">No roles need your attention.</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            <Link href="/found" className="text-[var(--color-act)] hover:underline">
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
