import assert from 'node:assert/strict';
import test from 'node:test';

import { pipelineActions } from '../../ui/src/lib/pipeline-actions.mjs';

test('roles already waiting are assessed without silently running another scan', () => {
  const actions = pipelineActions(247, true);
  assert.deepEqual(actions.primary, {
    action: 'assess',
    label: 'Assess waiting roles',
    description: 'assess the roles already waiting against your CV',
  });
  assert.deepEqual(actions.scan, {
    action: 'scan',
    label: 'Scan for new roles',
  });
});

test('an empty inbox offers the complete find-and-assess path', () => {
  const actions = pipelineActions(0, true);
  assert.equal(actions.primary?.action, 'find-and-assess');
  assert.equal(actions.scan.label, 'Scan only');
});

test('assessment is unavailable while disconnected but zero-token search remains', () => {
  const actions = pipelineActions(12, false);
  assert.equal(actions.primary, null);
  assert.equal(actions.scan.action, 'scan');
});
