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
import { readHealth } from '@/lib/health';
import { ConnectionBanner } from '@/components/connection';
import { Match } from '@/components/match';
import { CvLinks } from '@/components/cv-links';
import { PipelineOverview } from '@/components/journey-rail';
import { pipelineCounts } from '@/lib/journey';
import { readFollowups, type Followup } from '@/lib/followups';
import { FollowupStatus } from '@/components/followup-status';

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
      // min-h-[40px] on a phone: this is the primary action on every row and it
      // was 36px, under the standard the text links beside it already meet.
      className={
        primary
          ? 'inline-flex min-h-[40px] items-center rounded-lg bg-[var(--color-act)] px-3.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] sm:min-h-0 sm:py-2'
          : 'inline-flex min-h-[40px] items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] sm:min-h-0 sm:py-2'
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
function RoleRow({ role, followup }: { role: Role; followup?: Followup }) {
  return (
    <li className="product-row flex flex-col items-stretch gap-3 border-b border-[var(--color-line)] px-5 py-4 transition last:border-0 hover:bg-[var(--color-paper)] sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <div className="w-full min-w-0 flex-1 sm:w-auto">
        <div className="truncate text-[15px] font-semibold">{role.company}</div>
        {/* Wraps on a phone, truncates on a laptop where the row is a row. */}
        <div className="text-sm text-[var(--color-ink-soft)] sm:truncate">{role.role}</div>
        <div className="mt-1.5 flex items-center gap-2">
          <Match score={role.score} />
          {role.hasPdf && (
            <span className="text-xs font-medium text-[var(--color-ready)]">CV ready</span>
          )}
          {followup && <FollowupStatus followup={followup} />}
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
        {role.pdf && <CvLinks roleNum={role.num} size="sm" />}
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

function Band({
  title,
  blurb,
  roles,
  followups,
}: {
  title: string;
  blurb: string;
  roles: Role[];
  followups: Map<number, Followup>;
}) {
  if (roles.length === 0) return null;
  return (
    <section className="mb-11">
      <h2 className="flex items-baseline gap-2 text-[17px] font-bold tracking-tight">
        {title} <span className="tabular rounded-full bg-[var(--color-paper-deep)] px-2 py-0.5 text-xs font-semibold text-[var(--color-ink-soft)]">{roles.length}</span>
      </h2>
      <p className="mb-3 mt-0.5 text-sm text-[var(--color-ink-soft)]">{blurb}</p>
      <ul className="product-list rounded-2xl border">
        {roles.map((r) => (
          <RoleRow key={r.num} role={r} followup={followups.get(r.num)} />
        ))}
      </ul>
    </section>
  );
}

function Headline({ due, ready, nearly }: { due: number; ready: number; nearly: number }) {
  if (due > 0) {
    return (
      <>
        <h1 className="editorial-title">
          {due} {due === 1 ? 'follow-up needs' : 'follow-ups need'} your attention
        </h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          Keep live applications moving before starting something new.
        </p>
      </>
    );
  }
  if (ready > 0) {
    return (
      <>
        <h1 className="editorial-title">
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
        <h1 className="editorial-title">
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
      <h1 className="editorial-title">You are all caught up</h1>
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

  const [roles, counts, health, followupEntries] = await Promise.all([
    readTracker(),
    summarise(),
    readHealth(),
    readFollowups(),
  ]);
  const followups = new Map(followupEntries.map((entry) => [entry.num, entry]));
  const dueRoleNums = new Set(
    followupEntries
      .filter((entry) => entry.urgency === 'urgent' || entry.urgency === 'overdue')
      .map((entry) => entry.num),
  );
  const dueRoles = roles.filter((role) => dueRoleNums.has(role.num));
  const actionable = roles.filter((r) => r.readiness !== 'parked' && !dueRoleNums.has(r.num));

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
      <PipelineOverview counts={stageCounts} />

      {/*
        No "247 more roles found" line here any more. The rail above opens with
        that same count, labelled and linked, so saying it twice was the
        interface repeating itself — and the sentence version led with a
        backlog, which is the wrong first thing to tell someone whose next
        action is sitting further down the page.
      */}
      <div className="mb-9">
        <p className="page-eyebrow">Next up</p>
        <Headline due={dueRoles.length} ready={counts.readyToSend} nearly={counts.oneStepAway} />
      </div>

      <ConnectionBanner health={health} />

      {actionable.length === 0 && dueRoles.length === 0 ? (
        /*
          Two genuinely different empty states.

          "Nothing needs your attention" while several hundred roles sit
          unassessed is not calm, it is wrong — and it points someone at a
          scan they do not need to run. What is true depends on whether the
          scanner has found anything yet.
        */
        <div className="paper-surface rounded-2xl border border-dashed p-12 text-center">
          <p className="font-medium">Nothing needs your attention.</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            {counts.inbox > 0 ? (
              <>
                {counts.inbox.toLocaleString()} roles are waiting to be assessed —{' '}
                <Link href="/found" className="text-[var(--color-act)] hover:underline">
                  see what was found
                </Link>
                .
              </>
            ) : (
              <>
                Search your configured sources for openings that match your profile.{' '}
                <Link href="/found" className="text-[var(--color-act)] hover:underline">
                  Find roles
                </Link>
                .
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          <Band
            title="Follow-ups due"
            blurb="These applications need a reply, check-in or interview thank-you."
            roles={dueRoles}
            followups={followups}
          />
          {BANDS.map((b) => (
            <Band
              key={b.key}
              title={b.title}
              blurb={b.blurb}
              roles={actionable.filter((r) => r.readiness === b.key)}
              followups={followups}
            />
          ))}
        </>
      )}
    </>
  );
}
