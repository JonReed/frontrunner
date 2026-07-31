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
  readRunningCompanyDiscovery,
  readRunningCompanySuggestion,
  startCompanyDiscovery,
  startCompanySuggestion,
  startCoverBuild,
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
  saveSearchLists,
  seedSearchConfig,
  setCompanyEnabled as setSearchCompanyEnabled,
  type SetupAnswers,
} from '@/lib/search-config';
import {
  restoreRoleStatus,
  setRoleStatus,
  type UiState,
  type WorkflowHandle,
} from '@/lib/status';
import {
  startConnect,
  invalidateHealth,
  readHealth,
  readBrowserHealth,
  startBrowserInstall,
} from '@/lib/health';
import { addInboxUrl, removeInboxUrl, restoreInboxUrl } from '@/lib/inbox';
import {
  logFollowup as logFollowupEntry,
  snoozeFollowup as snoozeFollowupEntry,
  type FollowupChannel,
} from '@/lib/followup-write';
import { allowPrefilteredRole } from '@/lib/prefilter-overrides';
import {
  clearSetupDraft as clearDraft,
  readSetupDraft as readDraft,
  saveSetupDraft as saveDraft,
} from '@/lib/setup-draft';
import { revalidatePath } from 'next/cache';

/**
 * Save setup answers, or an edit from My details — the same operation at
 * different moments.
 *
 * Returns a message rather than throwing. This is the last step of a flow
 * someone has just spent five minutes on, and an unhandled error there loses
 * everything they typed. A failure has to come back as something the page can
 * show while keeping the form intact.
 *
 * When `search` is supplied — only from onboarding — the same call also creates
 * workspace/search/portals.yml from the shipped template, seeded with the job
 * titles and location just entered. Without it, setup finished and the first
 * button the user pressed died with "portals.yml not found. Run onboarding
 * first", which is both a dead end and untrue.
 *
 * Seeding failure is a WARNING, never an error. The profile is already written
 * by then; failing the whole call would tell someone their CV had not saved
 * when it had, and send them round the five-minute flow a second time.
 */
export async function saveDetails(
  save: ProfileSave & { search?: SetupAnswers },
): Promise<{ written: string[]; warning?: string } | { error: string }> {
  try {
    const written = await saveProfile(save);
    if (!save.search) return { written };
    try {
      await seedSearchConfig(save.search);
      return { written };
    } catch {
      return {
        written,
        warning: 'Your details are saved, but the search settings could not be created. Open Where to search to set them up.',
      };
    }
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
 * Save the search filters.
 *
 * The lists are named by the caller from a fixed set the backend also
 * enforces; a browser can change what is searched for, never where the
 * scanner connects to.
 */
export async function saveSearchSettings(
  lists: Record<string, string[]>,
): Promise<{ written: string[] } | { error: string }> {
  try {
    const written = await saveSearchLists(lists);
    revalidatePath('/search');
    revalidatePath('/found');
    return { written };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/at least 1 entry/iu.test(detail)) {
      return { error: 'Keep at least one job title, otherwise every role found would match.' };
    }
    if (/not a writable search list|unsupported search list/iu.test(detail)) {
      return { error: 'Something in that form is not a setting Frontrunner can save. Nothing was changed.' };
    }
    if (/could not be read/iu.test(detail)) {
      return { error: 'Your search settings file has a syntax error, so it was left untouched.' };
    }
    if (/no search settings to update/iu.test(detail)) {
      return { error: 'There are no search settings yet. Reload this page to create them.' };
    }
    if (/lock timeout|busy/iu.test(detail)) {
      return { error: 'Your search settings are being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That could not be saved. Nothing was changed.' };
  }
}

export async function toggleSearchCompany(
  company: string,
  enabled: boolean,
): Promise<{ enabled: boolean } | { error: string }> {
  try {
    const result = await setSearchCompanyEnabled(company, enabled);
    revalidatePath('/search');
    return { enabled: result.enabled };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/no longer in your search settings/iu.test(detail)) {
      return { error: 'That company is no longer listed. Reload this page.' };
    }
    if (/lock timeout|busy/iu.test(detail)) {
      return { error: 'Your search settings are being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That could not be changed.' };
  }
}

/** Create the search configuration for an installation that predates it. */
export async function createSearchSettings(
  answers?: SetupAnswers,
): Promise<{ created: boolean } | { error: string }> {
  try {
    const result = await seedSearchConfig(answers);
    revalidatePath('/search');
    revalidatePath('/found');
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return { error: detail || 'The search settings could not be created.' };
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
    if (/session expired|could not be refreshed|failed to authenticate/iu.test(detail)) {
      // Distinct from "never connected": the fix is reconnecting an account
      // that is already set up, and saying "connect your subscription" to
      // someone who did that last week reads as the product forgetting them.
      invalidateHealth();
      return { error: 'Your Claude sign-in has expired. Reconnect it on My details, then try again.' };
    }
    if (/not signed in|not logged in|auth|login/iu.test(detail)) {
      invalidateHealth();
      return { error: 'Connect your Claude subscription before using AI suggestions.' };
    }
    if (/timeout|did not respond|cancel/iu.test(detail)) {
      return { error: 'Claude took too long to return suggestions. Your CV and profile were not changed.' };
    }
    return { error: detail || 'Claude could not suggest profile details. Your CV and profile were not changed.' };
  }
}

/**
 * Follow a set of employers by name.
 *
 * Names in, real job boards out. Costs no allowance, so this is the path that
 * works during setup — the point at which the Claude CLI is usually still
 * signed out and anything model-backed would fail.
 */
export async function followCompanies(names: string[]): Promise<Job | { error: string }> {
  try {
    /*
      Checked before starting, because the job layer deduplicates by operation
      and RETURNS the run already in flight rather than refusing. That is right
      for a CV build — the same role, the same work — but wrong here: these are
      different company names, and silently handing back someone else's job
      would drop them with a spinner as the only feedback.

      A check-then-start has a race, but it converts the ordinary case into a
      clear message and leaves the rare one no worse than before.
    */
    const inFlight = await readRunningCompanyDiscovery();
    if (inFlight) {
      return { error: 'Frontrunner is still looking up the last set of employers. Try again once it finishes.' };
    }
    return await startCompanyDiscovery(names);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    // Rejoin an in-flight lookup rather than reporting a healthy state as a
    // failure, the same way the pipeline actions do.
    const running = await readRunningCompanyDiscovery();
    if (running) return running;
    if (/not a usable company name/iu.test(detail)) {
      return { error: 'One of those does not look like a company name. Use the name as people write it.' };
    }
    if (/at most|non-empty/iu.test(detail)) {
      return { error: 'Add between one and twenty companies at a time.' };
    }
    if (/lock timeout|busy|cannot start while/iu.test(detail)) {
      return { error: 'Frontrunner is already looking companies up. Wait a moment, then try again.' };
    }
    return { error: 'Those companies could not be looked up. Wait a moment, then try again.' };
  }
}

/**
 * Ask the model which employers suit this CV.
 *
 * Produces a shortlist only. Nothing is followed, and no company reaches the
 * search settings, until the user picks from it — the model proposes, the
 * person chooses, and the zero-token resolver does the writing.
 */
export async function suggestCompanies(): Promise<Job | { error: string }> {
  try {
    return await startCompanySuggestion();
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    const running = await readRunningCompanySuggestion();
    if (running) return running;
    if (/not signed in|not logged in|\/login/iu.test(detail)) {
      return { error: 'Connect your AI subscription before asking for suggestions.' };
    }
    if (/lock timeout|busy|cannot start while/iu.test(detail)) {
      return { error: 'Frontrunner is already working on that. Wait a moment, then try again.' };
    }
    return { error: 'That could not be started. Wait a moment, then try again.' };
  }
}

/**
 * The unfinished setup draft.
 *
 * Held on disk rather than in the browser: it contains a CV, contact details
 * and salary expectations, and browser storage keeps that in clear text where
 * anything on the origin can read it until the tab closes. These are
 * best-effort by design — the draft is a safety net, and a failed autosave
 * must never interrupt someone filling in a form.
 */
export async function loadSetupDraft(): Promise<Record<string, unknown> | null> {
  return readDraft();
}

export async function storeSetupDraft(draft: Record<string, unknown>): Promise<{ saved: boolean }> {
  return { saved: await saveDraft(draft) };
}

export async function discardSetupDraft(): Promise<void> {
  await clearDraft();
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

/**
 * Draft the covering letter for a role.
 *
 * Deliberately a separate operation from buildCv rather than a flag on it: the
 * two dedupe independently, so someone who already has a tailored CV can add a
 * letter without the request being folded into the finished build.
 */
export async function buildCover(roleNum: number): Promise<Job | { error: string }> {
  const role = (await readTracker()).find((r) => r.num === roleNum);
  if (!role) return { error: 'That role is no longer in your tracker.' };
  if (!role.url) return { error: 'The original job URL is missing, so Frontrunner cannot locate its safely cached description.' };

  try {
    return await startCoverBuild(roleNum, role.url, role.reportPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/jobUrl|HTTPS URL|job link/iu.test(detail)) {
      return { error: 'The original job link is not a safe HTTPS address, so the letter writer did not open it.' };
    }
    if (/lock timeout|busy/iu.test(detail)) {
      return { error: 'The secure letter writer is busy. Wait a moment, then try again.' };
    }
    return { error: 'The secure letter writer could not start. Wait a moment, then try again.' };
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
    if (/session expired|could not be refreshed|failed to authenticate/iu.test(detail)) {
      invalidateHealth();
      return { error: 'Your Claude sign-in has expired. Reconnect it on My details, then try again.' };
    }
    if (/not signed in|not logged in|\/login/iu.test(detail)) {
      invalidateHealth();
      return { error: 'Connect your AI subscription before assessing roles.' };
    }
    if (/lock timeout|busy|cannot start while/iu.test(detail)) {
      return { error: 'A search or assessment is already running. Wait a moment, then try again.' };
    }
    return { error: 'Frontrunner could not start that run. Wait a moment, then try again.' };
  }
}

/** Search the public job boards and the followed companies, without a model. */
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

/**
 * Add a job the user found for themselves.
 *
 * Until now every role in the product came from its own scanner, so the most
 * ordinary event in a job search — seeing a posting somewhere else — had
 * nowhere to go. The link joins the same queue a scanned role joins, and is
 * assessed by the same run.
 */
export async function addPendingRole(
  url: string,
  company: string,
  role: string,
): Promise<{ added: boolean; duplicate: boolean } | { error: string }> {
  try {
    const result = await addInboxUrl(url, { company, role });
    revalidatePath('/');
    revalidatePath('/found');
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/valid web URL|uncredentialed|bounded web URL/iu.test(detail)) {
      return { error: 'That does not look like a job link. Copy the whole web address, starting with https://' };
    }
    if (/too long/iu.test(detail)) {
      return { error: 'That company or job title is too long to save.' };
    }
    if (/lock|busy/iu.test(detail)) {
      return { error: 'The list is being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That link could not be added.' };
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
 * Record that a follow-up was actually sent, or move the next one.
 *
 * These are the missing half of the follow-up loop. The product could schedule
 * a chase and put it at the top of the home screen, but nothing could ever
 * mark one done — so every application a user had ever sent stayed permanently
 * overdue, and the headline counting them became noise.
 *
 * Logging and snoozing are deliberately distinct. Recording a follow-up that
 * did not happen corrupts the only account of what was actually sent to an
 * employer, which is exactly what someone needs when a reply arrives weeks
 * later.
 */
export async function recordFollowup(
  roleNum: number,
  channel: FollowupChannel,
  note: string,
): Promise<{ ok: true; date: string } | { error: string }> {
  try {
    if (!Number.isSafeInteger(roleNum) || roleNum <= 0) {
      return { error: 'That is not a valid role.' };
    }
    const result = await logFollowupEntry(roleNum, channel, note);
    for (const path of ['/', '/applications', `/role/${roleNum}`]) revalidatePath(path);
    return { ok: true, date: result.date };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/lock|busy/iu.test(detail)) {
      return { error: 'Your follow-ups are being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That follow-up could not be recorded.' };
  }
}

export async function postponeFollowup(
  roleNum: number,
  date: string,
): Promise<{ ok: true; date: string } | { error: string }> {
  try {
    if (!Number.isSafeInteger(roleNum) || roleNum <= 0) {
      return { error: 'That is not a valid role.' };
    }
    const result = await snoozeFollowupEntry(roleNum, date);
    for (const path of ['/', '/applications', `/role/${roleNum}`]) revalidatePath(path);
    return { ok: true, date: result.date };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    if (/lock|busy/iu.test(detail)) {
      return { error: 'Your follow-ups are being written by something else. Wait a moment, then try again.' };
    }
    return { error: detail || 'That could not be put off.' };
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

/**
 * Download the browser that renders CV PDFs, and report when it has arrived.
 *
 * Same two-action shape as connecting, for the same reason: the download is
 * large and slow, so it is started and polled rather than awaited. Offering it
 * as a button rather than a `npm run browser:install` instruction is the point
 * — this product's user does not have a terminal open, and the missing piece
 * was previously discovered only by paying for a model call that then failed
 * at the final step.
 */
export async function installPdfBrowser(): Promise<{ started: boolean }> {
  return startBrowserInstall();
}

export async function checkPdfBrowser(): Promise<{ installed: boolean }> {
  return readBrowserHealth();
}
