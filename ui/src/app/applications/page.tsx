/**
 * "My applications" — one list-shaped view of every live stage.
 *
 * The process rail is navigation above the page title. Selecting a stage
 * narrows this page to that list; the unfiltered page keeps the same row
 * treatment and shows each list in process order.
 */

import Link from 'next/link';
import { readInbox, readTracker, type Role } from '@/lib/roles';
import { JOURNEY, pipelineCounts, type SpineStage } from '@/lib/journey';
import { PipelineOverview } from '@/components/journey-rail';
import { ApplicationRoleRow } from '@/components/application-role-row';
import { listRunningCvRoleNums } from '@/lib/jobs';
import { readFollowups, type Followup } from '@/lib/followups';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My applications' };

type TrackedStage = Exclude<SpineStage, 'inbox'>;
type PageStage = TrackedStage | 'closed';

const TRACKED_STAGES = JOURNEY.filter((step) => step.key !== 'inbox');
const VALID_STAGE: Set<string> = new Set([...TRACKED_STAGES.map((step) => step.key), 'closed']);

const STAGE_COPY: Record<TrackedStage, string> = {
  triage: 'Assessed roles waiting for your decision.',
  prepare: 'Roles you want to pursue. Build or finish the application materials.',
  ready: 'Application materials are ready. Apply on the company’s site.',
  applied: 'Sent. Waiting for the employer to reply.',
  active: 'The employer has replied. Interviews, decisions and offers live here.',
};

const CLOSED_COPY = 'Roles outside the live process. Employer rejections and roles you chose not to pursue remain distinct; nothing was deleted.';

function StageList({
  stage,
  title,
  roles,
  filtered,
  runningCvRoles,
  followups,
}: {
  stage: PageStage;
  title: string;
  roles: Role[];
  filtered: boolean;
  runningCvRoles: Set<number>;
  followups: Map<number, Followup>;
}) {
  return (
    <section className="mb-11">
      {!filtered && (
        <h2 className="mb-3 flex items-baseline gap-2 text-[17px] font-bold tracking-tight">
          <Link href={`/applications?stage=${stage}`} className="hover:text-[var(--color-act)]">
            {title}
          </Link>
          <span className="tabular rounded-full bg-[var(--color-paper-deep)] px-2 py-0.5 text-xs font-semibold text-[var(--color-ink-soft)]">{roles.length}</span>
        </h2>
      )}
      {roles.length === 0 ? (
        <div className="paper-surface rounded-2xl border border-dashed p-10 text-center">
          <p className="font-semibold">Nothing here.</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Roles appear here as they move through the process.
          </p>
        </div>
      ) : (
        <ul className="product-list rounded-2xl border">
          {roles.map((role) => (
            <ApplicationRoleRow
              key={role.num}
              role={role}
              building={runningCvRoles.has(role.num)}
              followup={followups.get(role.num)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ stage?: string }>;
}) {
  const [{ stage: requestedStage }, roles, inbox, runningCvRoles, followupEntries] = await Promise.all([
    searchParams,
    readTracker(),
    readInbox(),
    listRunningCvRoleNums(),
    readFollowups(),
  ]);
  const followups = new Map(followupEntries.map((entry) => [entry.num, entry]));
  const selected = requestedStage && VALID_STAGE.has(requestedStage)
    ? requestedStage as PageStage
    : null;
  const visibleStages = selected
    ? selected === 'closed'
      ? [{ key: 'closed' as const, short: 'Closed' }]
      : TRACKED_STAGES.filter((step) => step.key === selected)
    : TRACKED_STAGES;
  const live = roles.filter((role) => role.stage !== 'closed');
  const closed = roles.filter((role) => role.stage === 'closed');
  const heading = selected
    ? selected === 'closed'
      ? 'Closed'
      : TRACKED_STAGES.find((step) => step.key === selected)?.short ?? 'My applications'
    : 'My applications';

  return (
    <>
      <PipelineOverview
        counts={pipelineCounts(roles, inbox.length)}
        active={selected === 'closed' ? undefined : selected ?? undefined}
      />

      <div className="mb-9">
        <p className="page-eyebrow">Applications</p>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="editorial-title">{heading}</h1>
          {selected ? (
            <Link href="/applications" className="text-sm text-[var(--color-act)] hover:underline">
              Show every stage
            </Link>
          ) : (
            <Link
              href="/applications?stage=closed"
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-[var(--color-ink-faint)] hover:bg-[var(--color-card)] hover:text-[var(--color-act)]"
            >
              Closed {closed.length}
            </Link>
          )}
        </div>
        <p className="page-lead mt-3 text-[var(--color-ink-soft)]">
          {selected
            ? selected === 'closed' ? CLOSED_COPY : STAGE_COPY[selected]
            : `${live.length} roles still in play.`}
        </p>
      </div>

      {visibleStages.map((step) => (
        <StageList
          key={step.key}
          stage={step.key as PageStage}
          title={step.short}
          roles={roles.filter((role) => role.stage === step.key)}
          filtered={selected !== null}
          runningCvRoles={runningCvRoles}
          followups={followups}
        />
      ))}
    </>
  );
}
