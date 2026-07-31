/**
 * setup.ts — is this installation usable yet?
 *
 * Reads the same versioned prerequisite contract as doctor.mjs so the CLI and
 * the UI cannot disagree about whether someone is set up. Read-only: this
 * decides what to ask for, never what to write.
 *
 * The required set comes from AGENTS.md. All five are user-layer files, which
 * is the whole reason onboarding exists as a screen rather than a script —
 * they hold the user's own words about themselves, and nothing else in the
 * product works until they do.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, WORKSPACE } from './root';
import { list, scalar } from './profile-yaml.mjs';
import { profileCompleteness } from './profile-completeness.mjs';

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

const ITEMS: Omit<SetupItem, 'present'>[] = (
  JSON.parse(readFileSync(join(ROOT, 'config', 'onboarding-prerequisites.json'), 'utf8')) as Array<{
    path: string;
    title: string;
    why: string;
  }>
).map(item => ({ file: item.path, title: item.title, why: item.why, required: true }));

export function readSetup(): { items: SetupItem[]; needed: boolean; profileMissing: string[] } {
  const items = ITEMS.map((i) => ({ ...i, present: existsSync(join(ROOT, i.file)) }));
  const profileText = existsSync(WORKSPACE.profileFile)
    ? readFileSync(WORKSPACE.profileFile, 'utf8')
    : '';
  const profile = profileCompleteness({
    hasCv: existsSync(WORKSPACE.cv) && readFileSync(WORKSPACE.cv, 'utf8').trim().length > 0,
    fields: {
      'candidate.full_name': scalar(profileText, ['candidate', 'full_name']) ?? '',
      'candidate.email': scalar(profileText, ['candidate', 'email']) ?? '',
      'candidate.location': scalar(profileText, ['candidate', 'location']) ?? '',
      'target_roles.primary': list(profileText, 'primary'),
    },
  });
  const profileMissing = profile.requiredMissing.map((field) => field.label);
  return {
    items,
    // A profile file copied from an example is present but not usable. The
    // field-level check prevents that old “finished” state from hiding gaps.
    needed: items.some((i) => i.required && !i.present) || profileMissing.length > 0,
    profileMissing,
  };
}
