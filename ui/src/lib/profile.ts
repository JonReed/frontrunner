/**
 * profile.ts — read who the user is.
 *
 * Deliberately READ-ONLY for now. config/profile.yml and cv.md are the user
 * layer: hand-edited, commented, and the source of truth for every judgement the tool
 * makes. Writing them from a web form without round-tripping comments would
 * quietly destroy work, so this first pass shows what is set and points at the
 * file rather than pretending to be an editor.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './roles';

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

/** Minimal YAML reading — enough for scalars and simple lists, no dependency. */
function scalar(src: string, path: string[]): string | null {
  const lines = src.split('\n');
  let depth = 0;
  let i = 0;
  for (const key of path) {
    let found = false;
    for (; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)([\w-]+):\s*(.*)$/);
      if (!m) continue;
      if (m[1].length < depth) return null;
      if (m[1].length === depth && m[2] === key) {
        if (key === path[path.length - 1]) {
          const v = m[3].trim().replace(/^["']|["']$/g, '');
          return v || null;
        }
        depth = m[1].length + 2;
        i++;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return null;
}

/**
 * Read a simple YAML list under `header:`.
 *
 * Stops when indentation returns to the header's level or shallower. Without
 * that it runs straight on into the next key — `primary:` bled into the
 * `archetypes:` block below it and rendered "name: ..." entries as job titles.
 */
function list(src: string, header: string): string[] {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*${header}:\\s*$`).test(l));
  if (start === -1) return [];

  const headerIndent = (lines[start].match(/^\s*/) ?? [''])[0].length;
  const out: string[] = [];

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    if (indent <= headerIndent) break;          // back out to a sibling key

    const item = line.match(/^\s*-\s+(.+)$/);
    if (!item) break;                            // nested mapping, not a scalar list
    out.push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

export async function readProfile(): Promise<Profile> {
  const yml = join(ROOT, 'config', 'profile.yml');
  const cv = join(ROOT, 'cv.md');

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
