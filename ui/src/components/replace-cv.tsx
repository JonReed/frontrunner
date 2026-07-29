'use client';

import { useRef, useState, useTransition } from 'react';
import { saveDetails } from '@/app/actions';
import { cvReplacementReadiness } from '@/lib/profile-maintenance.mjs';

const PLAIN = /\.(md|markdown|txt|text|rtf)$/iu;
const WORD = /\.docx$/iu;
const LEGACY_WORD = /\.doc$/iu;
const MAX_PLAIN_BYTES = 512 * 1024;
const MAX_DOCX_BYTES = 8 * 1024 * 1024;

const FIELD =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-3 text-[15px] text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-act)]';

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsText(file);
  });
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([^A-Za-z0-9\s])/gu, '$1');
}

async function readCvFile(file: File): Promise<string> {
  if (PLAIN.test(file.name)) {
    if (file.size > MAX_PLAIN_BYTES) {
      throw new Error('That text file is over 512 KB. Choose the CV itself rather than a larger notes file.');
    }
    return readTextFile(file);
  }

  if (WORD.test(file.name)) {
    if (file.size > MAX_DOCX_BYTES) {
      throw new Error('That Word file is over 8 MB. Save a copy without large images, then try again.');
    }
    const mammoth = await import('mammoth');
    const { value } = await mammoth.convertToMarkdown({ arrayBuffer: await file.arrayBuffer() });
    return unescapeMarkdown(value);
  }

  throw new Error(
    LEGACY_WORD.test(file.name)
      ? 'That is an older Word format. Open it in Word and save it as .docx, then try again.'
      : 'Choose a Word (.docx), Markdown or text file. For a PDF, export the original as Word or paste its text so the layout is not misread.',
  );
}

export function ReplaceCv({ currentWords, hasCv }: { currentWords: number; hasCv: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [fileName, setFileName] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const readiness = cvReplacementReadiness(draft);

  const changeDraft = (value: string) => {
    setDraft(value);
    setConfirming(false);
    setError(null);
  };

  const chooseFile = async (file?: File) => {
    if (!file) return;
    setReading(true);
    setConfirming(false);
    setError(null);
    try {
      changeDraft(await readCvFile(file));
      setFileName(file.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file could not be read.');
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const requestReplacement = () => {
    if (!readiness.ready) {
      setError(readiness.reason);
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const replace = () => {
    startSaving(async () => {
      const result = await saveDetails({ cv: draft });
      if ('error' in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      window.location.reload();
    });
  };

  if (!open) {
    return (
      <div className="border-t border-[var(--color-line)] py-4">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-10 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 py-2 text-sm font-semibold text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
        >
          {hasCv ? 'Replace CV' : 'Add your CV'}
        </button>
        {hasCv && (
          <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
            Existing reports and tailored PDFs will not change.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--color-line)] py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">{hasCv ? 'Replace your canonical CV' : 'Add your canonical CV'}</h3>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--color-ink-soft)]">
            This becomes the evidence Frontrunner uses for future matching and CV suggestions.
            Existing reports and generated PDFs stay as they are.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirming(false);
            setError(null);
          }}
          disabled={saving}
          className="min-h-10 cursor-pointer rounded-lg px-3 text-sm font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".docx,.md,.markdown,.txt,.text,.rtf"
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
          rows={12}
          value={draft}
          placeholder="Paste your complete CV here…"
          onChange={(event) => changeDraft(event.target.value)}
          disabled={saving}
        />
      </label>
      <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
        {readiness.words.toLocaleString()} {readiness.words === 1 ? 'word' : 'words'}
        {hasCv ? ` · current CV: ${currentWords.toLocaleString()} words` : ''}
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--color-attention)] bg-[var(--color-attention-wash)] p-4">
          <p className="font-semibold text-[var(--color-attention)]">That CV was not changed</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{error}</p>
        </div>
      )}

      {confirming ? (
        <div className="mt-5 rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-paper)] p-4">
          <p className="font-semibold">
            {hasCv ? 'Replace the CV used for every future assessment?' : 'Use this CV for future assessments?'}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--color-ink-soft)]">
            {hasCv
              ? 'Your current canonical CV will be overwritten. This cannot be undone in the interface.'
              : 'You can replace it later from this page.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={replace}
              disabled={saving}
              className="min-h-10 cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
            >
              {saving ? 'Replacing…' : hasCv ? 'Replace canonical CV' : 'Use this CV'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={saving}
              className="min-h-10 cursor-pointer rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)]"
            >
              Keep editing
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={requestReplacement}
          disabled={reading || saving}
          className="mt-5 min-h-10 cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
        >
          Review replacement
        </button>
      )}
    </div>
  );
}
