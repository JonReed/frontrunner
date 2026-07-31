'use client';

/**
 * AddRole — paste a job you found yourself.
 *
 * The product could previously only see roles its own scanner turned up. That
 * makes it useless for the most common thing that happens in a real job
 * search: someone sends you a link, or you spot one on LinkedIn. There was no
 * box to put it in, on any screen.
 *
 * Collapsed by default. Most sessions are about the roles already on the page,
 * and a permanent form at the top of Everything found would compete with them
 * — but it is one click away rather than a feature nobody finds.
 *
 * Company and job title are optional. The pipeline reads the real description
 * from the link; these only make the row recognisable in the list before
 * anything has assessed it, which matters when someone pastes three links in a
 * row and comes back an hour later.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addPendingRole } from '@/app/actions';

const FIELD =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2.5 text-[15px] text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-act)]';

export function AddRole() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await addPendingRole(url.trim(), company.trim(), role.trim());
      if ('error' in result) {
        setError(result.error);
        return;
      }
      if (result.duplicate) {
        // Not an error: the role is in the list, which is what they wanted.
        // Saying "already added" avoids the impression nothing happened.
        setNotice('That one is already in your list.');
        return;
      }
      setUrl('');
      setCompany('');
      setRole('');
      setNotice('Added. It will be assessed with the next run.');
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-9 inline-flex min-h-[42px] cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Add a job you found yourself
      </button>
    );
  }

  return (
    <section className="paper-surface mb-9 rounded-2xl border px-5 py-5 sm:px-6">
      <h2 className="text-[17px] font-bold tracking-tight">Add a job you found yourself</h2>
      <p className="mb-4 mt-0.5 text-sm text-[var(--color-ink-soft)]">
        Paste the link to the job advert. It joins the same queue as everything the search finds,
        and is assessed against your CV in the same way.
      </p>

      <label className="mb-4 block">
        <span className="mb-1 block text-sm font-semibold">Link to the job</span>
        <input
          className={FIELD}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && url.trim()) submit();
          }}
          placeholder="https://…"
          inputMode="url"
          autoComplete="off"
        />
      </label>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">
            Company <span className="font-normal text-[var(--color-ink-faint)]">optional</span>
          </span>
          <input
            className={FIELD}
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            placeholder="Who it is with"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold">
            Job title <span className="font-normal text-[var(--color-ink-faint)]">optional</span>
          </span>
          <input
            className={FIELD}
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="What the role is called"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={pending || !url.trim()}
          className="inline-flex min-h-[42px] cursor-pointer items-center rounded-lg bg-[var(--color-act)] px-4 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
        >
          {pending ? 'Adding…' : 'Add to my list'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setNotice(null);
          }}
          className="min-h-[42px] cursor-pointer px-2 text-sm font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)]"
        >
          Close
        </button>
        {notice && <span className="text-sm text-[var(--color-ready)]">{notice}</span>}
        {error && <span role="alert" className="text-sm text-[var(--color-attention)]">{error}</span>}
      </div>
    </section>
  );
}
