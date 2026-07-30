'use client';

/**
 * EditDetails — change the facts the whole product is judged against.
 *
 * Read-only until asked. My details is mostly a screen people come to in order
 * to *check* something, and a page of live inputs invites accidental edits to
 * the file that decides what every job is scored against. Editing is a
 * deliberate act, so it takes a click to enter and a click to save.
 *
 * Only the fields the backend will accept appear here. The allowlist lives in
 * src/application/profile-write.mjs; this form is a view of it, not a second
 * copy of the rules — anything it sent that was not allowlisted would be
 * refused anyway.
 */

import { useState, useTransition } from 'react';
import { saveDetails } from '@/app/actions';
import {
  PROFILE_DETAIL_FIELDS,
  PROFILE_DETAIL_SECTIONS,
} from '@/lib/profile-maintenance.mjs';

const FIELD =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2.5 text-[15px] outline-none transition placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-act)]';

export function EditDetails({ initial }: { initial: Record<string, string | string[]> }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of PROFILE_DETAIL_FIELDS) {
      seed[f.path] = typeof initial[f.path] === 'string' ? (initial[f.path] as string) : '';
    }
    const roles = initial['target_roles.primary'];
    seed.roles = Array.isArray(roles) ? roles.join('\n') : '';
    return seed;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-4 py-2.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
      >
        Change these details
      </button>
    );
  }

  const save = () => {
    setSaving(true);
    setError(null);
    const fields: Record<string, string | string[]> = {};
    // Empty strings are sent deliberately here, unlike in setup: on an edit
    // form, clearing a box is a request to remove that value.
    for (const f of PROFILE_DETAIL_FIELDS) fields[f.path] = values[f.path] ?? '';
    fields['target_roles.primary'] = values.roles.split('\n').map((r) => r.trim()).filter(Boolean);

    startTransition(async () => {
      const result = await saveDetails({ fields });
      if ('error' in result) {
        setError(result.error);
        setSaving(false);
        return;
      }
      window.location.reload();
    });
  };

  return (
    <div className="paper-surface rounded-2xl border p-5">
      {PROFILE_DETAIL_SECTIONS.map((section, index) => (
        <fieldset
          key={section.title}
          className={index === 0 ? '' : 'mt-6 border-t border-[var(--color-line)] pt-6'}
        >
          <legend className="mb-4 text-[17px] font-bold tracking-tight">{section.title}</legend>

          {section.fields.map((f) => (
            <label key={f.path} className="mb-4 block">
              <span className="mb-1 block text-sm font-semibold">{f.label}</span>
              <input
                className={FIELD}
                value={values[f.path]}
                placeholder={f.placeholder}
                onChange={(e) => setValues((v) => ({ ...v, [f.path]: e.target.value }))}
              />
            </label>
          ))}

          {index === 1 && (
            <label className="mb-5 block">
              <span className="mb-1 block text-sm font-semibold">Job titles you would take</span>
              <span className="mb-2 block text-sm text-[var(--color-ink-soft)]">One per line.</span>
              <textarea
                className={`${FIELD} resize-y`}
                rows={4}
                value={values.roles}
                onChange={(e) => setValues((v) => ({ ...v, roles: e.target.value }))}
              />
            </label>
          )}
        </fieldset>
      ))}

      {error && (
        <div className="mb-4 rounded-lg border border-[var(--color-attention)] bg-[var(--color-attention-wash)] p-4">
          <p className="font-semibold text-[var(--color-attention)]">That did not save</p>
          <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{error}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={saving}
          className="cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
