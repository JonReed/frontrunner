/**
 * profile.ts — read who the user is.
 *
 * Deliberately READ-ONLY for now. workspace/profile/profile.yml and workspace/profile/cv.md are the user
 * layer: hand-edited, commented, and the source of truth for every judgement the tool
 * makes. Writing them from a web form without round-tripping comments would
 * quietly destroy work, so this first pass shows what is set and points at the
 * file rather than pretending to be an editor.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { WORKSPACE } from './root';
import { list, scalar } from './profile-yaml.mjs';

export interface Profile {
  name: string | null;
  email: string | null;
  location: string | null;
  targetRoles: string[];
  compTarget: string | null;
  compMinimum: string | null;
  hasCv: boolean;
  cvWords: number;
  cvUpdated: string | null;
}


export async function readProfile(): Promise<Profile> {
  const yml = WORKSPACE.profileFile;
  const cv = WORKSPACE.cv;

  const src = existsSync(yml) ? await readFile(yml, 'utf8') : '';
  const cvText = existsSync(cv) ? await readFile(cv, 'utf8') : '';

  return {
    name: scalar(src, ['candidate', 'full_name']),
    email: scalar(src, ['candidate', 'email']),
    location: scalar(src, ['candidate', 'location']),
    targetRoles: list(src, 'primary'),
    compTarget: scalar(src, ['compensation', 'target_range']),
    compMinimum: scalar(src, ['compensation', 'minimum']),
    hasCv: cvText.length > 0,
    cvWords: cvText ? cvText.split(/\s+/).filter(Boolean).length : 0,
    cvUpdated: null,
  };
}
