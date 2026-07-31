'use client';

import { useRef, useState, useTransition } from 'react';
import { addCvVersion } from '@/app/actions';
import { CV_FILE_ACCEPT, readCvFile } from '@/lib/cv-file';
import type { CvVersionSummary } from '@/lib/profile-save';
import { cvReplacementReadiness } from '@/lib/profile-maintenance.mjs';

const FIELD =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-3 text-[15px] text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-act)]';

export function AdditionalCvs({ versions }: { versions: CvVersionSummary[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [draft, setDraft] = useState('');
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const readiness = cvReplacementReadiness(draft);

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setReading(true);
    setError(null);
    try {
      setDraft(await readCvFile(file));
      setFileName(file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file could not be read.');
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const reset = () => {
    setOpen(false);
    setLabel('');
    setDraft('');
    setFileName('');
    setError(null);
  };

  const save = () => {
    if (!readiness.ready) {
      setError(readiness.reason);
      return;
    }
    setError(null);
    startSaving(async () => {
      const result = await addCvVersion(label, draft);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      window.location.reload();
    });
  };

  return (
    <div className="border-t border-[var(--color-line)] py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">Other CVs</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--color-ink-soft)]">
            Keep versions for different kinds of work. They are reference material for tailoring,
            not replacements for the canonical CV above and are not scored directly.
          </p>
        </div>
        {open && (
          <button
            type="button"
            onClick={reset}
            disabled={saving}
            className="min-h-10 cursor-pointer rounded-lg px-3 text-sm font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
        )}
      </div>

      {versions.length > 0 ? (
        <ul className="mt-4 divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-card)]">
          {versions.map((version) => (
            <li key={version.name} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-3 text-sm">
              <span className="font-medium text-[var(--color-ink)]">{version.name}</span>
              <span className="text-[var(--color-ink-faint)]">
                {version.words === null ? 'Large file' : `${version.words.toLocaleString()} words`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-[var(--color-ink-faint)]">No additional CVs yet.</p>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-4 min-h-10 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 py-2 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
        >
          Add another CV
        </button>
      ) : (
        <div className="mt-5 rounded-xl border border-[var(--color-line)] bg-[var(--color-paper)] p-4">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold">What is this version for?</span>
            <span className="mb-2 block text-sm text-[var(--color-ink-soft)]">Optional — for example, “operations roles”.</span>
            <input
              className={FIELD}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Operations roles"
              disabled={saving}
            />
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept={CV_FILE_ACCEPT}
              hidden
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={reading || saving}
              className="min-h-10 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 py-2 text-sm font-semibold transition hover:border-[var(--color-act)] hover:text-[var(--color-act)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {reading ? 'Reading file…' : 'Choose a file'}
            </button>
            <span className="text-sm text-[var(--color-ink-faint)]">
              {fileName || 'Word, Markdown or text · read on this device'}
            </span>
          </div>

          <label className="mt-4 block">
            <span className="mb-2 block text-sm font-semibold">CV text</span>
            <textarea
              className={`${FIELD} resize-y`}
              rows={10}
              value={draft}
              placeholder="Paste this version here…"
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              disabled={saving}
            />
          </label>
          <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
            {readiness.words.toLocaleString()} {readiness.words === 1 ? 'word' : 'words'}
          </p>

          {error && (
            <div className="mt-4 rounded-lg border border-[var(--color-attention)] bg-[var(--color-attention-wash)] p-4">
              <p className="font-semibold text-[var(--color-attention)]">That CV was not added</p>
              <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{error}</p>
            </div>
          )}

          <button
            type="button"
            onClick={save}
            disabled={reading || saving}
            className="mt-5 min-h-10 cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
          >
            {saving ? 'Adding…' : 'Add this CV'}
          </button>
        </div>
      )}
    </div>
  );
}
