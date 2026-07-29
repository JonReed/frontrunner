/**
 * The primary action for a role in Preparing.
 *
 * Preparing means the user wants the role but its application materials are
 * not ready. A completed CV is the observable fact that permits the next
 * transition. Keeping this decision outside the component makes the boundary
 * explicit and independently testable.
 *
 * @param {boolean} hasPdf
 * @returns {
 *   | { kind: 'open'; label: 'Prepare application' }
 *   | {
 *       kind: 'move';
 *       label: 'Application ready';
 *       destination: 'ready';
 *       message: 'Moved to Ready.';
 *     }
 * }
 */
export function preparingPrimaryAction(hasPdf) {
  if (hasPdf) {
    return {
      kind: 'move',
      label: 'Application ready',
      destination: 'ready',
      message: 'Moved to Ready.',
    };
  }
  return {
    kind: 'open',
    label: 'Prepare application',
  };
}
