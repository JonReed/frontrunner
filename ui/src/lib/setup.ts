/**
 * setup.ts — is this installation usable yet?
 *
 * Mirrors the contract doctor.mjs already exposes (`onboardingNeeded`,
 * `missing`), deliberately using the same four required files so the CLI and
 * the UI can never disagree about whether someone is set up. Read-only: this
 * decides what to ask for, never what to write.
 *
 * The required set comes from AGENTS.md. All four are user-layer files, which
 * is the whole reason onboarding exists as a screen rather than a script —
 * they hold the user's own words about themselves, and nothing else in the
 * product works until they do.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './root';

export interface SetupItem {
  /** Path relative to the repo root, for the seam that eventually writes it. */
  file: string;
  /** What it is, in the user's language. Never the filename. */
  title: string;
  /** Why it is needed — every question earns its place by answering this. */
  why: string;
  required: boolean;
  present: boolean;
}

const ITEMS: Omit<SetupItem, 'present'>[] = [
  {
    file: 'workspace/profile/cv.md',
    title: 'Your CV',
    why: 'Every role is scored against it. Nothing works without this one.',
    required: true,
  },
  {
    file: 'workspace/profile/profile.yml',
    title: 'Your details and targets',
    why: 'Name, location, and the kind of work you are after.',
    required: true,
  },
  {
    file: 'workspace/search/portals.yml',
    title: 'Where to search',
    why: 'The job boards to scan. Ships with sensible defaults.',
    required: false,
  },
  {
    file: 'workspace/applications/tracker.md',
    title: 'Your tracker',
    why: 'Where applications are recorded as they move.',
    required: false,
  },
];

export function readSetup(): { items: SetupItem[]; needed: boolean } {
  const items = ITEMS.map((i) => ({ ...i, present: existsSync(join(ROOT, i.file)) }));
  return {
    items,
    needed: items.some((i) => i.required && !i.present),
  };
}
