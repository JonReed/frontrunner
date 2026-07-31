/**
 * Decide which fixed pipeline actions belong in the Found-page control.
 *
 * Assessment consumes AI allowance and is therefore only offered when the
 * configured engine is connected. Scanning never invokes a model and remains
 * available independently.
 *
 * @param {number} inboxCount
 * @param {boolean} connected
 */
export function pipelineActions(inboxCount, connected) {
  const waiting = Number.isSafeInteger(inboxCount) && inboxCount > 0;
  return {
    primary: connected
      ? waiting
        ? {
            action: 'assess',
            label: 'Assess waiting roles',
            description: 'assess the roles already waiting against your CV',
          }
        : {
            action: 'find-and-assess',
            label: 'Find and assess roles',
            description: 'search the job boards and assess the roles that match',
          }
      : null,
    scan: {
      action: 'scan',
      label: waiting ? 'Scan for new roles' : 'Scan only',
    },
  };
}
