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
 * appears from `sm` up, where there is room for a word under a 60px column.
 * On a phone the caption underneath names the whole thing instead.
 */
export function PipelineOverview({
  counts,
  active,
}: {
  counts: Partial<Record<SpineStage, number>>;
  active?: SpineStage;
}) {
  const total = JOURNEY.reduce((sum, s) => sum + (counts[s.key] ?? 0), 0);
  return (
    <nav aria-label="The whole process" className="mb-8">
      <ol className="flex gap-1.5">
        {JOURNEY.map((s) => {
          const n = counts[s.key] ?? 0;
          const isHere = active === s.key;
          return (
            <li key={s.key} className="min-w-0 flex-1">
              <Link
                href={HREF[s.key]}
                aria-current={isHere ? 'step' : undefined}
                className="group block"
              >
                <Segment filled={n > 0 && !isHere} current={isHere} />
                <span
                  className={`tabular mt-1.5 block text-[15px] font-semibold leading-none transition group-hover:text-[var(--color-act)] ${
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
                <span className="mt-1 block text-[10px] leading-tight text-[var(--color-ink-faint)] sm:text-[11px]">
                  {s.short}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-sm text-[var(--color-ink-soft)] sm:mt-2.5">
        <span className="font-semibold text-[var(--color-ink)]">
          {total.toLocaleString()} {total === 1 ? 'role' : 'roles'}
        </span>{' '}
        across the process, from found to answered.
      </p>
    </nav>
  );
}
