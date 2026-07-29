import assert from 'node:assert/strict';
import test from 'node:test';

import { preparingPrimaryAction } from '../../ui/src/lib/workflow-actions.mjs';

test('Preparing opens the role while its application materials are incomplete', () => {
  assert.deepEqual(preparingPrimaryAction(false), {
    kind: 'open',
    label: 'Prepare application',
  });
});

test('Preparing can advance to Ready once a completed CV exists', () => {
  assert.deepEqual(preparingPrimaryAction(true), {
    kind: 'move',
    label: 'Application ready',
    destination: 'ready',
    message: 'Moved to Ready.',
  });
});
