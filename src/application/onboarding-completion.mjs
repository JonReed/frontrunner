/**
 * Canonical first-run publication.
 *
 * Each stage is independently locked, atomic and create-once where appropriate.
 * The operation is deliberately idempotent: if the process stops after any
 * stage, the UI still sees missing prerequisites and retrying completes the
 * same request without replacing user customisations or duplicating CVs.
 */

import { join } from 'node:path';

import { withFileLock } from '../lib/file-lock.mjs';
import {
  ensurePortalsFile,
  ensurePreferencesFile,
  ensureTargetingFile,
  ensureTrackerFile,
  onboardingBase,
} from './onboarding-files.mjs';
import { publishProfileSave } from './profile-transaction.mjs';
import { validateProfilePatch } from './profile-write.mjs';

export async function completeOnboarding(save, options = {}) {
  const base = options.base ?? onboardingBase();
  const fields = validateProfilePatch(save?.fields ?? {});
  const roles = fields['target_roles.primary'] ?? [];
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('At least one target role is required to complete onboarding.');
  }
  const targeting = { ...(save?.targeting ?? {}), roles };
  const profile = {
    roles,
    city: fields['location.city'] ?? '',
    country: fields['location.country'] ?? '',
    workingPattern: fields['compensation.location_flexibility'] ?? '',
  };
  const lock = join(base, 'workspace', '.state', 'onboarding-completion.lock');

  return withFileLock(lock, async () => {
    await publishProfileSave({
      fields,
      cv: save.cv,
      versions: save.versions ?? [],
    }, { base });
    await options.afterStage?.('profile');

    await ensureTargetingFile({ base, targeting });
    await options.afterStage?.('targeting');

    await ensurePreferencesFile({ base });
    await options.afterStage?.('preferences');

    await ensurePortalsFile({ base, profile });
    await options.afterStage?.('portals');

    await ensureTrackerFile({ base });
    await options.afterStage?.('tracker');

    return {
      completed: true,
      written: [
        'workspace/profile/cv.md',
        'workspace/profile/profile.yml',
        'workspace/profile/targeting.md',
        'workspace/profile/preferences.md',
        'workspace/search/portals.yml',
        'workspace/applications/tracker.md',
      ],
    };
  });
}
