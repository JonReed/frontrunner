/**
 * Provision the non-personal files that make a completed onboarding usable.
 *
 * The template is system-owned; the destination is private user state. Copy
 * only when the destination is absent, under the same lock used by other
 * local writers, so an existing customised portals file is never replaced.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ROOT } from '#paths';
import { withFileLock } from '../lib/file-lock.mjs';
import { copyFileAtomic } from '../lib/locked-file.mjs';

export function onboardingBase() {
  return process.env.FRONTRUNNER_PROFILE_BASE || ROOT;
}

export const portalsPath = (base = onboardingBase()) =>
  join(base, 'workspace', 'search', 'portals.yml');
export const portalsTemplatePath = (base = onboardingBase()) =>
  join(base, 'templates', 'portals.example.yml');

export async function ensurePortalsFile({ base = onboardingBase() } = {}) {
  const target = portalsPath(base);
  const template = portalsTemplatePath(base);
  if (!existsSync(template)) {
    throw new Error('The bundled portals template is missing; onboarding was left incomplete.');
  }

  mkdirSync(dirname(target), { recursive: true });
  return withFileLock(target, () => {
    if (existsSync(target)) return { created: false, path: target };
    copyFileAtomic(template, target, { mode: 0o600 });
    return { created: true, path: target };
  });
}
