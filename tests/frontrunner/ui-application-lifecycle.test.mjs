import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRecordEmployerRejection,
  previousOutcomeAction,
  primaryOutcomeAction,
} from '../../ui/src/lib/outcome-actions.mjs';
import { followupPresentation } from '../../ui/src/lib/followup-presentation.mjs';

test('post-reply lifecycle records explicit observed outcomes in order', () => {
  assert.equal(primaryOutcomeAction('Responded')?.destination, 'interview');
  assert.equal(primaryOutcomeAction('Interview')?.destination, 'offer');
  assert.equal(primaryOutcomeAction('Offer')?.destination, 'hired');
  assert.equal(primaryOutcomeAction('Hired'), null);

  assert.equal(previousOutcomeAction('Hired')?.destination, 'offer');
  assert.equal(previousOutcomeAction('Offer')?.destination, 'interview');
  assert.equal(previousOutcomeAction('Interview')?.destination, 'active');
  assert.equal(previousOutcomeAction('Responded')?.destination, 'applied');
});

test('employer rejection stays distinct from candidate withdrawal', () => {
  assert.equal(canRecordEmployerRejection('applied', 'Applied'), true);
  assert.equal(canRecordEmployerRejection('active', 'Interview'), true);
  assert.equal(canRecordEmployerRejection('active', 'Hired'), false);
  assert.equal(canRecordEmployerRejection('prepare', 'Evaluated'), false);
});

test('follow-up labels make urgency and interview thank-yous explicit', () => {
  assert.deepEqual(
    followupPresentation({
      status: 'applied',
      urgency: 'overdue',
      daysUntilNext: -3,
      nextFollowupDate: '2026-07-26',
    }),
    { label: 'Follow-up overdue by 3 days', tone: 'attention' },
  );
  assert.deepEqual(
    followupPresentation({
      status: 'interview',
      urgency: 'waiting',
      daysUntilNext: 1,
      nextFollowupDate: '2026-07-30',
    }),
    { label: 'Thank-you in 1 day', tone: 'quiet' },
  );
});
