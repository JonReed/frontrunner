/**
 * journey.ts — the one place the stages of the process are named.
 *
 * A role moves along a single spine: found → decided on → prepared → sent →
 * answered. Every screen shows a slice of that spine, and before this file
 * existed each screen named the stages itself, so the board said "Deciding"
 * while the stream said "Worth a look" and nothing said where either sat in
 * the whole.
 *
 * One list, imported everywhere. If a stage is renamed it is renamed once.
 *
 * `closed` is deliberately NOT on the spine. It is an exit, reachable from any
 * step, and drawing it as a seventh box would imply rejection is the
 * destination — which, for someone job hunting, is exactly the wrong thing for
 * an interface to imply.
 */

import type { Stage } from './roles';

export type SpineStage = Exclude<Stage, 'closed'>;

export interface JourneyStep {
  key: SpineStage;
  /** Column heading and rail label. Short enough to sit under a 60px segment. */
  short: string;
  /** The sub-line: what the user does here, not what the state is called. */
  hint: string;
}

export const JOURNEY: JourneyStep[] = [
  { key: 'inbox', short: 'Found', hint: 'Not assessed' },
  { key: 'triage', short: 'Deciding', hint: 'Worth a look' },
  { key: 'prepare', short: 'Preparing', hint: 'Needs a CV' },
  { key: 'ready', short: 'Ready', hint: 'Go apply' },
  { key: 'applied', short: 'Applied', hint: 'Waiting for reply' },
  { key: 'active', short: 'In process', hint: 'Reply received' },
];

export function stepIndex(stage: Stage): number {
  return JOURNEY.findIndex((s) => s.key === stage);
}

/**
 * Roles per step, for the overview rail.
 *
 * Shared rather than computed per page: the rail appears on several screens
 * and showing "0 Deciding" on one while another shows 9 would make the whole
 * device untrustworthy. Closed roles are excluded — they are off the spine.
 */
export function pipelineCounts(
  roles: { stage: Stage }[],
  inboxCount: number,
): Partial<Record<SpineStage, number>> {
  const counts: Partial<Record<SpineStage, number>> = { inbox: inboxCount };
  for (const r of roles) {
    if (r.stage === 'closed' || r.stage === 'inbox') continue;
    counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  }
  return counts;
}
