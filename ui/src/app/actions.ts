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
import { restoreRoleStatus, setRoleStatus, type UiState } from '@/lib/status';
import { startConnect, invalidateHealth, readHealth } from '@/lib/health';
import { removeInboxUrl, restoreInboxUrl } from '@/lib/inbox';
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
 * These are bounded user-observed changes: deciding to prepare, sending an
 * application, seeing that the employer replied, or deciding not to continue.
 * Offer and Hired remain unavailable because a generic stage control cannot
 * honestly infer either outcome.
 *
 * Without this the workflow had no ending: Frontrunner built a CV, sent the
 * user to the company's site, and never learned the outcome, so a sent
 * application sat in "Ready to send" forever.
 */
export type WorkflowDestination = 'triage' | 'prepare' | 'ready' | 'applied' | 'active' | 'closed';

const DESTINATION: Record<WorkflowDestination, { state: UiState; note?: string }> = {
  triage: { state: 'Evaluated', note: '[frontrunner-stage:triage]' },
  prepare: { state: 'Evaluated', note: '[frontrunner-stage:prepare]' },
  ready: { state: 'Evaluated', note: '[frontrunner-stage:ready]' },
  applied: { state: 'Applied', note: 'Applied — recorded in Frontrunner' },
  active: { state: 'Responded', note: 'Employer replied — recorded in Frontrunner' },
  closed: { state: 'Discarded', note: 'Not pursuing' },
};

export async function moveRole(
  roleNum: number,
  destination: WorkflowDestination,
): Promise<{ ok: true } | { error: string }> {
  try {
    if (!Number.isSafeInteger(roleNum) || roleNum <= 0 || !Object.hasOwn(DESTINATION, destination)) {
      return { error: 'That is not a valid role move.' };
    }
    const role = (await readTracker()).find((candidate) => candidate.num === roleNum);
    if (!role) return { error: 'That role is no longer in your tracker.' };
    const move = DESTINATION[destination];
    // A unique marker makes a real move repeatable after Undo. set-status is
    // intentionally idempotent for identical notes, so a timeless marker
    // would otherwise leave an older stage marker as the last one.
    const before = `[frontrunner-before:${role.status}:${role.stage}:${Date.now()}]`;
    const note = move.note ? `${before}; ${move.note}` : before;
    await setRoleStatus(roleNum, move.state, note);
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

export async function undoRoleMove(
  roleNum: number,
): Promise<{ ok: true } | { error: string }> {
  try {
    if (!Number.isSafeInteger(roleNum) || roleNum <= 0) {
      return { error: 'That is not a valid role.' };
    }
    await restoreRoleStatus(roleNum);
    for (const path of ['/', '/applications', '/found', `/role/${roleNum}`]) {
      revalidatePath(path);
    }
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return { error: detail || 'That change could not be undone.' };
  }
}

export async function removePendingRole(
  url: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    await removeInboxUrl(url);
    revalidatePath('/');
    revalidatePath('/found');
    revalidatePath('/applications');
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/lock|busy/iu.test(detail)) {
      return { error: 'The Found list is being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That role could not be removed.' };
  }
}

export async function undoPendingRole(
  url: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    await restoreInboxUrl(url);
    revalidatePath('/');
    revalidatePath('/found');
    revalidatePath('/applications');
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return { error: detail || 'That role could not be restored.' };
  }
}

/**
 * Start signing the Claude CLI in, and report whether it is done yet.
 *
 * Two actions rather than one long-running call: the browser flow takes as
 * long as the user takes, so `connect` launches it and `checkConnected` is
 * polled from the client. Neither ever sees a credential — the CLI opens the
 * user's own browser and writes to their own keychain.
 */
export async function connectEngine(): Promise<{ started: boolean }> {
  invalidateHealth();
  return startConnect();
}

export async function checkConnected(): Promise<{ signedIn: boolean }> {
  invalidateHealth();
  const health = await readHealth();
  return { signedIn: health.signedIn };
}
