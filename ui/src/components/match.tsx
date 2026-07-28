/**
 * Match — how good a fit a role is, in words.
 *
 * The evaluation produces a number out of 5. That number means something to
 * whoever built the rubric and nothing to a person looking for a job: 4.1 is
 * not obviously good, and 3.6 is not obviously borderline.
 *
 * So the label leads and the number follows as supporting detail. Someone
 * scanning the page should understand their options without learning a scale.
 *
 * Bands match the CLI's own thresholds, so the two never disagree about what
 * counts as worth applying to.
 */

export type MatchTone = 'excellent' | 'strong' | 'possible' | 'weak' | 'unknown';

export function matchOf(score: number | null): { tone: MatchTone; label: string } {
  if (score === null) return { tone: 'unknown', label: 'Not scored yet' };
  if (score >= 4.5) return { tone: 'excellent', label: 'Excellent match' };
  if (score >= 4.0) return { tone: 'strong', label: 'Strong match' };
  if (score >= 3.0) return { tone: 'possible', label: 'Possible match' };
  return { tone: 'weak', label: 'Weak match' };
}

const TONE: Record<MatchTone, string> = {
  excellent: 'bg-[var(--color-ready-wash)] text-[var(--color-ready)]',
  strong: 'bg-[var(--color-ready-wash)] text-[var(--color-ready)]',
  possible: 'bg-[var(--color-attention-wash)] text-[var(--color-attention)]',
  weak: 'bg-[var(--color-paper)] text-[var(--color-ink-faint)]',
  unknown: 'bg-[var(--color-paper)] text-[var(--color-ink-faint)]',
};

export function Match({ score, showNumber = true }: { score: number | null; showNumber?: boolean }) {
  const { tone, label } = matchOf(score);
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[tone]}`}>{label}</span>
      {showNumber && score !== null && (
        <span className="tabular text-xs text-[var(--color-ink-faint)]">{score.toFixed(1)}</span>
      )}
    </span>
  );
}
