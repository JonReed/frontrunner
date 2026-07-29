import { followupPresentation } from '@/lib/followup-presentation.mjs';
import type { Followup } from '@/lib/followups';

export function FollowupStatus({
  followup,
  detail = false,
}: {
  followup: Followup;
  detail?: boolean;
}) {
  const presentation = followupPresentation(followup);
  const date = followup.nextFollowupDate
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }).format(new Date(`${followup.nextFollowupDate}T00:00:00Z`))
    : null;
  const tone = presentation.tone === 'attention'
    ? 'bg-[var(--color-attention-wash)] text-[var(--color-attention)]'
    : 'bg-[var(--color-paper-deep)] text-[var(--color-ink-faint)]';

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}
      title={detail && date ? `Scheduled for ${date}` : undefined}
    >
      {presentation.label}
      {detail && date ? ` · ${date}` : ''}
    </span>
  );
}
