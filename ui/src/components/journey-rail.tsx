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
  triage: '/applications',
  prepare: '/applications',
  ready: '/applications',
  applied: '/applications',
  active: '/applications',
};

function Segment({
  filled,
  current,
}: {
  filled: boolean;
  current: boolean;
}) {
  const tone = current
    ? 'bg-[var(--color-act)]'
    : filled
      ? 'bg-[var(--color-act)]/35'
      : 'bg-[var(--color-line)]';
  return <span className={`block h-1 rounded-full ${tone}`} aria-hidden="true" />;
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
      <ol className="flex gap-1.5">
        {JOURNEY.map((s, i) => (
          <li key={s.key} className="min-w-0 flex-1">
            <Segment filled={i < here} current={i === here} />
            {/*
              Labels are laptop-only. Six of them across 375px would each get
              about 55px and truncate to noise, so on a phone the sentence
              below the rail carries the same information in words.
            */}
            <span
              className={`mt-1.5 hidden truncate text-[11px] sm:block ${
                i === here
                  ? 'font-semibold text-[var(--color-ink)]'
                  : 'text-[var(--color-ink-faint)]'
              }`}
            >
              {s.short}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-sm text-[var(--color-ink-soft)] sm:mt-2.5">
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
 * The whole population, one number per step.
 *
 * Scrollable on a phone rather than stacked: six labelled counts as a vertical
 * list would push the actual content of every page below the fold, and this is
 * orientation, not the content itself.
 */
export function PipelineOverview({
  counts,
  active,
}: {
  counts: Partial<Record<SpineStage, number>>;
  active?: SpineStage;
}) {
  return (
    <nav aria-label="The whole process" className="-mx-6 mb-8 overflow-x-auto px-6 sm:mx-0 sm:px-0">
      <ol className="flex min-w-max gap-1.5 sm:min-w-0">
        {JOURNEY.map((s) => {
          const n = counts[s.key] ?? 0;
          const isHere = active === s.key;
          return (
            <li key={s.key} className="w-[92px] flex-none sm:w-auto sm:flex-1">
              <Link
                href={HREF[s.key]}
                aria-current={isHere ? 'step' : undefined}
                className={`block rounded-lg border px-2.5 py-2 transition ${
                  isHere
                    ? 'border-[var(--color-act)] bg-[var(--color-act-wash)]'
                    : 'border-[var(--color-line)] bg-[var(--color-card)] hover:border-[var(--color-line-strong)]'
                }`}
              >
                <span
                  className={`tabular block text-[17px] font-bold leading-none ${
                    n === 0 ? 'text-[var(--color-ink-faint)]' : 'text-[var(--color-ink)]'
                  }`}
                >
                  {n}
                </span>
                <span className="mt-1 block truncate text-[11px] text-[var(--color-ink-soft)]">
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
