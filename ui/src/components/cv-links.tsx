/**
 * CvLinks — view or download a generated CV.
 *
 * People want to READ what the AI wrote before sending it to an employer, so
 * the PDF opens inline in a new tab rather than dropping into Downloads. The
 * download is offered separately for when they actually want the file.
 */

export function CvLinks({ roleNum, size = 'md' }: { roleNum: number; size?: 'sm' | 'md' }) {
  const href = `/api/file?role=${encodeURIComponent(roleNum)}&format=pdf`;
  const cls =
    size === 'sm'
      ? // Inline text link, but 40px of thumb on a phone. It stays visually a
        // link; only the hit area grows.
        'inline-flex min-h-[40px] items-center text-sm text-[var(--color-ink-faint)] underline decoration-[var(--color-line-strong)] underline-offset-2 transition hover:text-[var(--color-act)] sm:min-h-0'
      : 'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]';

  return (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {size === 'sm' ? 'View CV' : 'View your tailored CV'}
      {size === 'md' && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M4.5 2h5.5v5.5M10 2L4 8M8 10H2V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </a>
  );
}
