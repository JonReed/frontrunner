/**
 * Truthful post-application moves.
 *
 * These labels describe events the user can directly observe. They never infer
 * an interview, offer or rejection from a generic "in process" stage.
 *
 * @param {string} status
 */
export function primaryOutcomeAction(status) {
  switch (String(status).toLowerCase()) {
    case 'responded':
      return {
        label: 'Interview arranged',
        destination: 'interview',
        message: 'Interview recorded.',
      };
    case 'interview':
      return {
        label: 'I received an offer',
        destination: 'offer',
        message: 'Offer recorded.',
      };
    case 'offer':
      return {
        label: 'I accepted the offer',
        destination: 'hired',
        message: 'Marked as Hired.',
      };
    default:
      return null;
  }
}

/**
 * @param {string} status
 */
export function previousOutcomeAction(status) {
  switch (String(status).toLowerCase()) {
    case 'responded':
      return {
        label: 'Move back to Applied',
        destination: 'applied',
        message: 'Moved to Applied.',
      };
    case 'interview':
      return {
        label: 'Move back to Responded',
        destination: 'active',
        message: 'Moved to Responded.',
      };
    case 'offer':
      return {
        label: 'Move back to Interview',
        destination: 'interview',
        message: 'Moved to Interview.',
      };
    case 'hired':
      return {
        label: 'Move back to Offer',
        destination: 'offer',
        message: 'Moved to Offer.',
      };
    default:
      return null;
  }
}

/**
 * Employer rejection is meaningful only after an application was sent.
 *
 * @param {string} stage
 * @param {string} status
 */
export function canRecordEmployerRejection(stage, status) {
  return (stage === 'applied' || stage === 'active')
    && String(status).toLowerCase() !== 'hired';
}
