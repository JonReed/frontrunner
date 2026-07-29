/** Pure selection rule used when a role page reconnects to durable work. */
export function runningCvJobForRole(jobs, roleNum) {
  if (!Number.isSafeInteger(roleNum) || roleNum < 1) return null;
  return jobs.find((job) => (
    job?.operation === 'cv.build'
    && job?.kind === 'build-cv'
    && job?.status === 'running'
    && job?.roleNum === roleNum
  )) ?? null;
}
