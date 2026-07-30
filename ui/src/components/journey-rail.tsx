/**
 * JourneyRail — where this sits in the process.
 *
 * The product is a pipeline, but every screen used to show one slice of it
 * with no indication that the other slices existed. Someone reading an
 * assessment could not tell whether they were near the start or nearly done,
 * and the 247 unassessed roles looked like a separate product rather than the
 * first step of this one.
 *
 * Two modes, one visual language:
 *
 *   current={stage}   one role's position — used on a role page
 *   counts={{...}}    how many roles sit at each step — used on list pages
 *
 * This is not decoration, which the design rules would forbid. It answers two
 * questions the interface could not previously answer: where am I, and what
 * happens next.
 *
 * Deliberately NOT a progress bar. A percentage would imply the end is
 * reachable by effort alone, and most roles end at "Applied" and stop. The
 * rail shows position, never completion.
 */

import Link from 'next/link';
import { JOURNEY, stepIndex, type SpineStage } from '@/lib/journey';
import type { Stage } from '@/lib/roles';

/** Where each step's roles can be seen. */
const HREF: Record<SpineStage, string> = {
  inbox: '/found',
  triage: '/applications?stage=triage',
  prepare: '/applications?stage=prepare',
  ready: '/applications?stage=ready',
  applied: '/applications?stage=applied',
  active: '/applications?stage=active',
};

function Station({
  state,
}: {
  state: 'past' | 'current' | 'populated' | 'empty';
}) {
  if (state === 'current') {
    return (
      <span
        className="relative z-[1] block size-4 rounded-full border-[4px] border-[var(--color-card)] bg-[var(--color-act)] ring-2 ring-[var(--color-act)]"
        aria-hidden="true"
      />
    );
  }
  const tone = state === 'past'
    ? 'border-[var(--color-act)] bg-[var(--color-act)]'
    : state === 'populated'
      ? 'border-[var(--color-ink-soft)] bg-[var(--color-card)]'
      : 'border-[var(--color-line-strong)] bg-[var(--color-card)]';
  return (
    <span
      className={`relative z-[1] block size-3 rounded-full border-2 ${tone}`}
      aria-hidden="true"
    />
  );
}

/**
 * One role's position.
 *
 * A closed role gets a plain statement instead of a rail: it left the spine,
 * and colouring five of six segments would misdescribe what happened.
 */
export function RoleJourney({ stage, status }: { stage: Stage; status?: string }) {
  if (stage === 'closed') {
    return (
      <p className="text-sm text-[var(--color-ink-faint)]">
        Closed{status ? ` — ${status.toLowerCase()}` : ''}. Not in the process any more.
      </p>
    );
  }

  const here = stepIndex(stage);
  const next = JOURNEY[here + 1];

  return (
    <nav aria-label="Where this role is" className="w-full">
      <ol className="relative flex before:absolute before:left-[8.333%] before:right-[8.333%] before:top-[7px] before:h-px before:bg-[var(--color-line-strong)]">
        {JOURNEY.map((s, i) => (
          <li key={s.key} className="min-w-0 flex-1">
            <Link
              href={HREF[s.key]}
              aria-label={`Show ${s.short} roles`}
              aria-current={i === here ? 'step' : undefined}
              className="group flex flex-col items-center"
            >
              <Station state={i === here ? 'current' : i < here ? 'past' : 'empty'} />
              {/*
                Labels are laptop-only. Six of them across 375px would each get
                about 55px and truncate to noise, so on a phone the sentence
                below the rail carries the same information in words.
              */}
              <span
                className={`mt-2 hidden w-full truncate text-center text-[11px] transition group-hover:text-[var(--color-act)] sm:block ${
                  i === here
                    ? 'font-semibold text-[var(--color-ink)]'
                    : 'text-[var(--color-ink-faint)]'
                }`}
              >
                {s.short}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
        <span className="font-semibold text-[var(--color-ink)]">
          Step {here + 1} of {JOURNEY.length}: {JOURNEY[here].short}
        </span>
        {/* "then Ready", not "next is ready" — lowercased, a stage name reads
            as an adjective and the sentence stops making sense. */}
        {next ? <> — then {next.short}.</> : <> — the last step.</>}
      </p>
    </nav>
  );
}

/**
 * The whole population, in the same rail as a single role.
 *
 * Previously a row of bordered cards that scrolled sideways on a phone — a
 * second visual language for the one concept the interface is built around,
 * which made two screens showing the same six steps look like two different
 * ideas. It is now the rail above, with a count where a role page has a
 * position.
 *
 * Six columns rather than a horizontal scroll, so nothing is hidden off the
 * edge. The number carries the information and is always visible; the label
 * names it at every width.
 */
export function PipelineOverview({
  counts,
  active,
}: {
  counts: Partial<Record<SpineStage, number>>;
  active?: SpineStage;
}) {
  return (
    <nav aria-label="The whole process" className="pipeline-surface mb-11 rounded-[22px] border px-3 py-4 sm:px-6 sm:py-5">
      <div className="mb-4 flex items-center justify-between gap-4 px-1">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-ink-soft)]">
          Your search
        </span>
        <span className="hidden text-xs text-[var(--color-ink-faint)] sm:block">
          From everything found to conversations in progress
        </span>
      </div>
      <ol className="relative flex before:absolute before:left-[8.333%] before:right-[8.333%] before:top-[7px] before:h-px before:bg-[var(--color-line-strong)]">
        {JOURNEY.map((s) => {
          const n = counts[s.key] ?? 0;
          const isHere = active === s.key;
          return (
            <li key={s.key} className="min-w-0 flex-1">
              <Link
                href={HREF[s.key]}
                aria-current={isHere ? 'step' : undefined}
                className={`group flex flex-col items-center rounded-lg px-0.5 pb-1 pt-0 transition ${
                  isHere ? 'bg-[var(--color-act-wash)]' : 'hover:bg-[var(--color-paper)]'
                }`}
              >
                <Station state={isHere ? 'current' : n > 0 ? 'populated' : 'empty'} />
                <span
                  className={`tabular mt-2 block text-[17px] font-bold leading-none tracking-tight transition group-hover:text-[var(--color-act)] ${
                    n === 0 ? 'text-[var(--color-ink-faint)]' : 'text-[var(--color-ink)]'
                  }`}
                >
                  {n}
                </span>
                {/*
                  Labels stay on at phone width, unlike the role rail.
                  There, the sentence underneath names the current step, so the
                  labels are redundant. Here nothing else says what the numbers
                  count, and "247 9 5 1 0 0" on its own is a puzzle. They wrap
                  rather than truncate — two short lines beat "In proces…".
                */}
                <span className={`mt-1 block text-center text-[10px] leading-tight sm:text-[11px] ${
                  isHere ? 'font-semibold text-[var(--color-act)]' : 'text-[var(--color-ink-faint)]'
                }`}>
                  {s.short}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
