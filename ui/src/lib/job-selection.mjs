/**
 * Pure selection rule used when a role page reconnects to durable work.
 *
 * Parameterised by operation because a role can have a CV and a covering
 * letter building at the same time, and each control on the page must reattach
 * to its own job rather than to whichever started first.
 */
export function runningDocumentJobForRole(jobs, roleNum, operation = 'cv.build') {
  if (!Number.isSafeInteger(roleNum) || roleNum < 1) return null;
  const kind = operation === 'cover.build' ? 'build-cover' : 'build-cv';
  return jobs.find((job) => (
    job?.operation === operation
    && job?.kind === kind
    && job?.status === 'running'
    && job?.roleNum === roleNum
  )) ?? null;
}

/** Retained name for the CV case, which is the overwhelmingly common one. */
export function runningCvJobForRole(jobs, roleNum) {
  return runningDocumentJobForRole(jobs, roleNum, 'cv.build');
}
