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

  // The job URL lives in the report header; fall back to the company name so a
  // missing URL degrades to a slower run rather than a failure.
  return startCvBuild(roleNum, role.reportPath ?? `${role.company} ${role.role}`, role.reportPath);
}
