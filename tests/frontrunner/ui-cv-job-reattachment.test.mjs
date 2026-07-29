import assert from 'node:assert/strict';
import test from 'node:test';

import { runningCvJobForRole } from '../../ui/src/lib/job-selection.mjs';

const job = (roleNum, status = 'running') => ({
  id: `cv-${roleNum}-fixture`,
  operation: 'cv.build',
  kind: 'build-cv',
  roleNum,
  status,
});

test('a role page reconnects only to its own running CV job', () => {
  const jobs = [
    job(41),
    job(42, 'done'),
    { ...job(42), operation: 'pipeline.run', kind: 'pipeline' },
    job(43),
  ];

  assert.equal(runningCvJobForRole(jobs, 41)?.id, 'cv-41-fixture');
  assert.equal(runningCvJobForRole(jobs, 42), null);
  assert.equal(runningCvJobForRole(jobs, 43)?.id, 'cv-43-fixture');
  assert.equal(runningCvJobForRole(jobs, 99), null);
});
