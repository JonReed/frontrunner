/**
 * @param {{
 *   status: string;
 *   urgency: string;
 *   daysUntilNext: number | null;
 *   nextFollowupDate: string | null;
 * }} followup
 */
export function followupPresentation(followup) {
  const interview = followup.status === 'interview';
  const task = interview ? 'Thank-you' : 'Follow-up';
  if (followup.urgency === 'urgent') {
    return { label: `${task} needed`, tone: 'attention' };
  }
  if (followup.urgency === 'overdue') {
    const days = Math.max(0, -(followup.daysUntilNext ?? 0));
    return {
      label: days > 0
        ? `${task} overdue by ${days} ${days === 1 ? 'day' : 'days'}`
        : `${task} due today`,
      tone: 'attention',
    };
  }
  if (followup.urgency === 'cold') {
    return { label: 'Follow-up limit reached', tone: 'quiet' };
  }
  const days = followup.daysUntilNext;
  if (days === 0) return { label: `${task} due today`, tone: 'attention' };
  if (typeof days === 'number' && days > 0) {
    return {
      label: `${task} in ${days} ${days === 1 ? 'day' : 'days'}`,
      tone: 'quiet',
    };
  }
  return {
    label: followup.nextFollowupDate ? `${task} scheduled` : 'Follow-up tracked',
    tone: 'quiet',
  };
}
