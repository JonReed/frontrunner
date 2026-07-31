'use client';

/**
 * ChipList — a short list of short things, edited without a separator.
 *
 * Used for keywords, locations and company names. A comma-separated textarea
 * would ask someone to know the separator, and it turns "remove one entry"
 * into a text-editing task where a stray comma silently changes the meaning.
 * Each entry is a thing you can see and a cross you can press.
 *
 * Shared by setup and Where to search on purpose: they collect the same kind
 * of value at different moments, and two implementations would drift in what
 * counts as a duplicate.
 */

import { useState } from 'react';

const FIELD =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2.5 text-[15px] text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-act)]';
const ADD =
  'inline-flex min-h-[42px] cursor-pointer items-center rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] disabled:cursor-not-allowed disabled:opacity-60';

export function ChipList({
  label,
  hint,
  placeholder,
  items,
  onChange,
  tone = 'act',
}: {
  label: string;
  hint?: string;
  placeholder: string;
  items: string[];
  onChange: (next: string[]) => void;
  tone?: 'act' | 'muted';
}) {
  const [entry, setEntry] = useState('');

  const add = () => {
    const value = entry.trim();
    if (!value) return;
    // Case-insensitive, because "Remote" and "remote" are the same intention
    // typed twice and the backend folds them anyway. Rejecting it here means
    // the user sees why nothing happened.
    if (items.some((item) => item.toLowerCase() === value.toLowerCase())) {
      setEntry('');
      return;
    }
    onChange([...items, value]);
    setEntry('');
  };

  const chip = tone === 'act'
    ? 'bg-[var(--color-act-wash)] text-[var(--color-act)]'
    : 'bg-[var(--color-paper-deep)] text-[var(--color-ink-soft)]';

  return (
    <div className="mb-7">
      <p className="text-sm font-semibold">{label}</p>
      {hint && <p className="mb-2.5 mt-0.5 text-sm text-[var(--color-ink-soft)]">{hint}</p>}

      {items.length > 0 && (
        <ul className="mb-3 mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item}>
              <span className={`inline-flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-medium ${chip}`}>
                {item}
                <button
                  type="button"
                  onClick={() => onChange(items.filter((candidate) => candidate !== item))}
                  aria-label={`Remove ${item}`}
                  className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full text-current opacity-60 transition hover:bg-[var(--color-card)] hover:opacity-100"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="m1.5 1.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          className={`${FIELD} max-w-sm flex-1`}
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the entry rather than submitting a form. Someone
            // typing a list expects Enter between items, and losing four of
            // them to an accidental save is the worse failure.
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
          aria-label={label}
        />
        <button type="button" onClick={add} disabled={!entry.trim()} className={ADD}>
          Add
        </button>
      </div>
    </div>
  );
}
