'use server';

/**
 * Server actions — the only place the UI is allowed to spend AI allowance.
 *
 * Kept deliberately thin: validate, delegate, return. All the process
 * supervision lives in lib/jobs.ts.
 */

import { randomUUID } from 'node:crypto';
import { readTracker } from '@/lib/roles';
import {
  cancelPipelineJob as cancelPipelineJobRequest,
  readRunningPipelineJob,
  startCvBuild,
  startPipelineRun,
  startScanRun,
  type Job,
} from '@/lib/jobs';
import {
  addCvVersion as addCvVersionRequest,
  completeOnboarding as completeOnboardingRequest,
  ensurePortals as ensurePortalsRequest,
  extractProfile,
  saveProfile,
  type ProfileExtraction,
  type OnboardingSave,
  type ProfileSave,
} from '@/lib/profile-save';
import {
  restoreRoleStatus,
  setRoleStatus,
  type UiState,
  type WorkflowHandle,
} from '@/lib/status';
import { startConnect, invalidateHealth, readHealth } from '@/lib/health';
import { removeInboxUrl, restoreInboxUrl } from '@/lib/inbox';
import { allowPrefilteredRole } from '@/lib/prefilter-overrides';
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
      return { error: 'Your workspace/profile/profile.yml has a syntax error, so it was left untouched. Fix or delete it, then try again.' };
    }
    if (/lock timeout|busy/iu.test(detail)) {
      return { error: 'Your profile is being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That could not be saved. Nothing was changed.' };
  }
}

export async function completeSetup(save: OnboardingSave): Promise<{ written: string[] } | { error: string }> {
  try {
    return { written: await completeOnboardingRequest(save) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/lock timeout|busy/iu.test(detail)) {
      return { error: 'Setup is being saved by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'Setup could not be completed. Your saved progress is safe; try again.' };
  }
}

export async function addCvVersion(
  label: string,
  text: string,
): Promise<{ name: string } | { error: string }> {
  try {
    return { name: await addCvVersionRequest(label, text) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return { error: detail || 'That additional CV could not be saved. Nothing was changed.' };
  }
}

export async function ensureSearchSources(): Promise<{ ok: true } | { error: string }> {
  try {
    await ensurePortalsRequest();
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return { error: detail || 'The job sources could not be set up. Nothing else was changed.' };
  }
}

/**
 * Ask the user's connected Claude subscription for review-only suggestions.
 *
 * The CV crosses the provider boundary only after the user presses the
 * AI-styled button. Claude has zero tools and cannot write the profile.
 */
export async function extractCvProfile(
  cv: string,
): Promise<ProfileExtraction | { error: string }> {
  const health = await readHealth();
  if (!health.installed) {
    return { error: 'Install Claude Code, then connect your Claude subscription before using AI suggestions.' };
  }
  if (!health.signedIn) {
    return { error: 'Connect your Claude subscription before using AI suggestions.' };
  }
  try {
    return await extractProfile(cv);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/not signed in|not logged in|auth|login/iu.test(detail)) {
      return { error: 'Connect your Claude subscription before using AI suggestions.' };
    }
    if (/timeout|did not respond|cancel/iu.test(detail)) {
      return { error: 'Claude took too long to return suggestions. Your CV and profile were not changed.' };
    }
    return { error: detail || 'Claude could not suggest profile details. Your CV and profile were not changed.' };
  }
}

export async function overridePrefilterRejection(
  url: string,
  rule: string,
): Promise<{ changed: boolean } | { error: string }> {
  try {
    const result = await allowPrefilteredRole(url, rule);
    revalidatePath('/found');
    return { changed: result.changed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/lock timeout|already active|busy/iu.test(detail)) {
      return { error: 'A search or assessment is running. Wait for it to finish, then try again.' };
    }
    if (/no longer present|no longer in|missing/iu.test(detail)) {
      return { error: 'That role has changed since this page loaded. Reload Everything found.' };
    }
    return { error: detail || 'That role could not be restored. Nothing was changed.' };
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

type PipelineActionResult = Promise<Job | { error: string }>;

async function startPipelineAction(
  start: () => Promise<Job>,
): PipelineActionResult {
  try {
    return await start();
  } catch (error) {
    // The backend serialises every pipeline operation against the same
    // resource. If another tab won the race, rejoin its durable job instead
    // of presenting that healthy state as a failure.
    const running = await readRunningPipelineJob();
    if (running) return running;

    const detail = error instanceof Error ? error.message : '';
    if (/not signed in|not logged in|\/login/iu.test(detail)) {
      return { error: 'Connect your AI subscription before assessing roles.' };
    }
    if (/lock timeout|busy|cannot start while/iu.test(detail)) {
      return { error: 'A search or assessment is already running. Wait a moment, then try again.' };
    }
    return { error: 'Frontrunner could not start that run. Wait a moment, then try again.' };
  }
}

/** Search configured sources without invoking a model. */
export async function scanForRoles(): PipelineActionResult {
  return startPipelineAction(startScanRun);
}

/** Assess the roles already waiting in workspace/search/pipeline.md. */
export async function assessWaitingRoles(): PipelineActionResult {
  return startPipelineAction(() => startPipelineRun(false));
}

/** Run the complete canonical search and assessment pipeline. */
export async function findAndAssessRoles(): PipelineActionResult {
  return startPipelineAction(() => startPipelineRun(true));
}

export async function stopPipelineJob(id: string): PipelineActionResult {
  try {
    const job = await cancelPipelineJobRequest(id);
    return job ?? { error: 'That run is no longer active.' };
  } catch {
    return { error: 'Frontrunner could not stop that run. Wait a moment, then try again.' };
  }
}

/**
 * Record what happened to a role.
 *
 * These are bounded user-observed changes: deciding to prepare, sending an
 * application, seeing that the employer replied, or deciding not to continue.
 * Interview, Offer, Hired and Rejected are exposed only through controls that
 * name the exact event the user observed.
 *
 * Without this the workflow had no ending: Frontrunner built a CV, sent the
 * user to the company's site, and never learned the outcome, so a sent
 * application sat in "Ready to send" forever.
 */
export type WorkflowDestination =
  | 'triage'
  | 'prepare'
  | 'ready'
  | 'applied'
  | 'active'
  | 'interview'
  | 'offer'
  | 'hired'
  | 'rejected'
  | 'closed';

function observedToday(label: string): string {
  const now = new Date();
  const date = [
    String(now.getFullYear()).padStart(4, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `${label} ${date} — recorded in Frontrunner`;
}

const DESTINATION: Record<WorkflowDestination, { state: UiState; note?: string | (() => string) }> = {
  triage: { state: 'Evaluated', note: '[frontrunner-stage:triage]' },
  prepare: { state: 'Evaluated', note: '[frontrunner-stage:prepare]' },
  ready: { state: 'Evaluated', note: '[frontrunner-stage:ready]' },
  applied: { state: 'Applied', note: () => observedToday('Applied') },
  active: { state: 'Responded', note: () => observedToday('Responded') },
  interview: { state: 'Interview', note: () => observedToday('Interview') },
  offer: { state: 'Offer', note: () => observedToday('Offer') },
  hired: { state: 'Hired', note: () => observedToday('Hired') },
  rejected: { state: 'Rejected', note: () => observedToday('Rejected') },
  closed: { state: 'Discarded', note: 'Not pursuing' },
};

export async function moveRole(
  roleNum: number,
  destination: WorkflowDestination,
): Promise<{ ok: true; undo: WorkflowHandle; warning?: string } | { error: string }> {
  try {
    if (!Number.isSafeInteger(roleNum) || roleNum <= 0 || !Object.hasOwn(DESTINATION, destination)) {
      return { error: 'That is not a valid role move.' };
    }
    const role = (await readTracker()).find((candidate) => candidate.num === roleNum);
    if (!role) return { error: 'That role is no longer in your tracker.' };
    const move = DESTINATION[destination];
    const moveNote = typeof move.note === 'function' ? move.note() : move.note;
    const undoToken = randomUUID();
    // The marker is the durable recovery record for this exact move. Undo also
    // carries the post-write row revision, so any intervening edit makes the
    // handle stale instead of overwriting newer tracker state.
    const before = `[frontrunner-before:${undoToken}:${role.status}:${role.stage}:${move.state}]`;
    const note = moveNote ? `${before}; ${moveNote}` : before;
    const undo = await setRoleStatus(
      roleNum,
      move.state,
      note,
      role.revision,
      undoToken,
    );
    // Every screen reads the tracker, so all of them are now stale.
    for (const path of ['/', '/applications', '/found', `/role/${roleNum}`]) {
      revalidatePath(path);
    }
    return {
      ok: true,
      undo,
      ...(undo.followupPending
        ? { warning: 'The tracker was updated, but follow-up scheduling is waiting to retry.' }
        : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/ambiguous|candidate/iu.test(detail)) {
      return { error: 'More than one tracker row matches this role, so nothing was changed. Open workspace/applications/tracker.md to resolve the duplicate.' };
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
  handle: WorkflowHandle,
): Promise<{ ok: true; warning?: string } | { error: string }> {
  try {
    if (!Number.isSafeInteger(roleNum) || roleNum <= 0) {
      return { error: 'That is not a valid role.' };
    }
    const result = await restoreRoleStatus(roleNum, handle);
    for (const path of ['/', '/applications', '/found', `/role/${roleNum}`]) {
      revalidatePath(path);
    }
    return {
      ok: true,
      ...(result.followupPending
        ? { warning: 'The role was restored, but follow-up cleanup is waiting to retry.' }
        : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return { error: detail || 'That change could not be undone.' };
  }
}

export async function removePendingRole(
  url: string,
): Promise<{ ok: true } | { error: string }> {
  try {
    const result = await removeInboxUrl(url);
    if (!result.found) return { error: 'That role is no longer in the Found list.' };
    if (!result.changed) return { error: 'That role was already removed.' };
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
    const result = await restoreInboxUrl(url);
    if (!result.found) return { error: 'That role is no longer in the Found list.' };
    if (!result.changed) return { error: 'That role is already back in the Found list.' };
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
