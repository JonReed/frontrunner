'use server';

/**
 * Server actions — the only place the UI is allowed to spend AI allowance.
 *
 * Kept deliberately thin: validate, delegate, return. All the process
 * supervision lives in lib/jobs.ts.
 */

import { readTracker } from '@/lib/roles';
import { startCvBuild, type Job } from '@/lib/jobs';

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
