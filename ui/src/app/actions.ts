'use server';

/**
 * Server actions — the only place the UI is allowed to spend AI allowance.
 *
 * Kept deliberately thin: validate, delegate, return. All the process
 * supervision lives in lib/jobs.ts.
 */

import { readTracker } from '@/lib/roles';
import { startCvBuild, type Job } from '@/lib/jobs';
import { saveProfile, type ProfileSave } from '@/lib/profile-save';
import { setRoleStatus, type UiState } from '@/lib/status';
import { revalidatePath } from 'next/cache';

/**
 * Save setup answers, or an edit from My details — the same operation at
 * different moments.
 *
 * Returns a message rather than throwing. This is the last step of a flow
 * someone has just spent five minutes on, and an unhandled error there loses
 * everything they typed. A failure has to come back as something the page can
 * show while keeping the form intact.
 */
export async function saveDetails(save: ProfileSave): Promise<{ written: string[] } | { error: string }> {
  try {
    return { written: await saveProfile(save) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/not a writable profile field|unsupported profile field/iu.test(detail)) {
      return { error: 'Something in that form is not a field Frontrunner can save. Nothing was changed.' };
    }
    if (/could not be parsed/iu.test(detail)) {
      return { error: 'Your config/profile.yml has a syntax error, so it was left untouched. Fix or delete it, then try again.' };
    }
    if (/lock timeout|busy/iu.test(detail)) {
      return { error: 'Your profile is being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That could not be saved. Nothing was changed.' };
  }
}

export async function buildCv(roleNum: number): Promise<Job | { error: string }> {
  const role = (await readTracker()).find((r) => r.num === roleNum);
  if (!role) return { error: 'That role is no longer in your tracker.' };

  if (!role.url) return { error: 'The original job URL is missing, so Frontrunner cannot locate its safely cached description.' };
  try {
    return await startCvBuild(roleNum, role.url, role.reportPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/jobUrl|HTTPS URL|job link/iu.test(detail)) {
      return { error: 'The original job link is not a safe HTTPS address, so the CV builder did not open it.' };
    }
    if (/lock timeout|busy/iu.test(detail)) {
      return { error: 'The secure CV builder is busy. Wait a moment, then try again.' };
    }
    return { error: 'The secure CV builder could not start. Wait a moment, then try again.' };
  }
}

/**
 * Record what happened to a role.
 *
 * Two decisions the interface can honestly know: the user sent this one, or
 * they do not want it. Everything else in templates/states.yml — Responded,
 * Interview, Offer, Hired — depends on what an employer did, which no button
 * here can observe.
 *
 * Without this the workflow had no ending: Frontrunner built a CV, sent the
 * user to the company's site, and never learned the outcome, so a sent
 * application sat in "Ready to send" forever.
 */
export async function recordOutcome(
  roleNum: number,
  state: UiState,
  note?: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    await setRoleStatus(roleNum, state, note);
    // Every screen reads the tracker, so all of them are now stale.
    for (const path of ['/', '/applications', '/found', `/role/${roleNum}`]) {
      revalidatePath(path);
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/ambiguous|candidate/iu.test(detail)) {
      return { error: 'More than one tracker row matches this role, so nothing was changed. Open data/applications.md to resolve the duplicate.' };
    }
    if (/lock|busy/iu.test(detail)) {
      return { error: 'The tracker is being written by something else. Wait a moment, then try again.' };
    }
    if (/not found|no row/iu.test(detail)) {
      return { error: 'That role is no longer in your tracker.' };
    }
    return { error: detail || 'That could not be saved. Nothing was changed.' };
  }
}
