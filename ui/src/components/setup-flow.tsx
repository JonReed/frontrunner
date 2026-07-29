'use client';

/**
 * SetupFlow — first run, handheld.
 *
 * This is the screen that decides whether someone stays. They have installed
 * something on a recommendation, they are probably not a developer, and they
 * are about to hand over their entire employment history to it. Every decision
 * here is made for that person.
 *
 * Rules this flow follows, all of them consequences of that:
 *
 * ONE QUESTION AT A TIME. A single form with fourteen fields reads as work.
 * Four short steps read as a conversation, and each one can say why it is
 * asking — which is the only thing that makes the CV step feel reasonable
 * rather than intrusive.
 *
 * NOTHING IS MANDATORY EXCEPT THE CV. Everything else has a sane default or
 * can be added later from My details. Blocking someone on their phone number
 * before they have seen a single job would be absurd.
 *
 * NOTHING IS SENT ANYWHERE. Said once, plainly, on the step where they paste
 * their CV — the moment the worry actually occurs — and not repeated. Constant
 * reassurance reads as a product with something to hide.
 *
 * NO AI HERE. Onboarding does not spend the user's allowance. They have not
 * seen the product work yet, and asking them to pay for the privilege of
 * setting it up is the wrong first impression.
 */

import { useState } from 'react';

const STEPS = ['Your CV', 'About you', 'What you want', 'Finish'] as const;

export interface SetupDraft {
  cv: string;
  fullName: string;
  email: string;
  location: string;
  targetRoles: string;
  salaryTarget: string;
  remote: 'remote' | 'hybrid' | 'onsite' | '';
}

const EMPTY: SetupDraft = {
  cv: '',
  fullName: '',
  email: '',
  location: '',
  targetRoles: '',
  salaryTarget: '',
  remote: '',
};

/* ------------------------------------------------------------------ pieces */

const FIELD =
  'w-full rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2.5 text-[15px] text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-act)]';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-5 block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {hint && <span className="mb-2 block text-sm text-[var(--color-ink-soft)]">{hint}</span>}
      {children}
    </label>
  );
}

/**
 * Progress, in the same visual language as the role journey rail.
 *
 * Segments plus a sentence, not a percentage: the same reasoning as the rail —
 * a bar implies a machine measuring you, and this is a conversation.
 */
function Progress({ step }: { step: number }) {
  return (
    <div className="mb-8">
      <ol className="flex gap-1.5">
        {STEPS.map((s, i) => (
          <li key={s} className="min-w-0 flex-1">
            <span
              className={`block h-1 rounded-full ${
                i === step
                  ? 'bg-[var(--color-act)]'
                  : i < step
                    ? 'bg-[var(--color-act)]/35'
                    : 'bg-[var(--color-line)]'
              }`}
              aria-hidden="true"
            />
          </li>
        ))}
      </ol>
      <p className="mt-2.5 text-sm text-[var(--color-ink-soft)]">
        <span className="font-semibold text-[var(--color-ink)]">
          Step {step + 1} of {STEPS.length}: {STEPS[step]}
        </span>
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------- flow */

export function SetupFlow() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<SetupDraft>(EMPTY);
  const set = <K extends keyof SetupDraft>(k: K, v: SetupDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // The CV is the only hard gate. Everything else can be filled in later from
  // My details, and blocking on it would be inventing work.
  const canAdvance = step === 0 ? draft.cv.trim().length > 40 : true;

  return (
    <div className="mx-auto max-w-xl">
      {/*
        The welcome copy earns its place once, on the first screen, and then
        gets out of the way. Repeated above every step it took a third of a
        phone screen to tell someone something they had already read — and the
        thing they need is the question, not the preamble.
      */}
      <div className="mb-9">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">
          {step === 0 ? 'Let us get you set up' : 'Setting up'}
        </h1>
        {step === 0 && (
          <p className="mt-1.5 text-[15px] text-[var(--color-ink-soft)]">
            Three questions and a quick check, about five minutes. After this, Frontrunner reads
            job adverts and tells you which ones are worth your time.
          </p>
        )}
      </div>

      <Progress step={step} />

      {step === 0 && (
        <section>
          <h2 className="text-[22px] font-bold leading-tight tracking-tight">
            Start with your CV
          </h2>
          <p className="mt-1.5 text-[15px] text-[var(--color-ink-soft)]">
            Paste it in — any format, formatting does not matter. Every job found is scored
            against this, so it is the one thing that has to be here.
          </p>
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
            It is saved as a file on this computer and never uploaded. Parts of it are sent to
            your AI provider only when you ask for a tailored CV.
          </p>

          <div className="mt-6">
            <Field label="Your CV">
              <textarea
                value={draft.cv}
                onChange={(e) => set('cv', e.target.value)}
                rows={14}
                placeholder="Paste the whole thing here…"
                className={`${FIELD} resize-y leading-relaxed`}
              />
            </Field>
            <p className="-mt-3 text-sm text-[var(--color-ink-faint)]">
              {draft.cv.trim() ? `${draft.cv.trim().split(/\s+/).length} words` : 'Nothing yet'}
            </p>
          </div>
        </section>
      )}

      {step === 1 && (
        <section>
          <h2 className="text-[22px] font-bold leading-tight tracking-tight">About you</h2>
          <p className="mb-6 mt-1.5 text-[15px] text-[var(--color-ink-soft)]">
            Used on the CVs and cover letters this builds. Nothing here is sent anywhere on its
            own.
          </p>
          <Field label="Full name">
            <input
              className={FIELD}
              value={draft.fullName}
              onChange={(e) => set('fullName', e.target.value)}
              placeholder="Jane Smith"
              autoComplete="name"
            />
          </Field>
          <Field label="Email">
            <input
              className={FIELD}
              type="email"
              value={draft.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="jane@example.com"
              autoComplete="email"
            />
          </Field>
          <Field label="Where you are" hint="Used to judge whether a role is commutable.">
            <input
              className={FIELD}
              value={draft.location}
              onChange={(e) => set('location', e.target.value)}
              placeholder="Manchester, UK"
            />
          </Field>
        </section>
      )}

      {step === 2 && (
        <section>
          <h2 className="text-[22px] font-bold leading-tight tracking-tight">
            What you are looking for
          </h2>
          <p className="mb-6 mt-1.5 text-[15px] text-[var(--color-ink-soft)]">
            This is what the scoring is measured against. Rough is fine — it can be changed at any
            time.
          </p>
          <Field
            label="Job titles you would take"
            hint="One per line. Titles you would actually accept, not just aim for."
          >
            <textarea
              className={`${FIELD} resize-y`}
              rows={4}
              value={draft.targetRoles}
              onChange={(e) => set('targetRoles', e.target.value)}
              placeholder={'Head of Operations\nOperations Director'}
            />
          </Field>
          <Field label="Salary you are aiming for" hint="Optional. Roles below it get marked down.">
            <input
              className={FIELD}
              value={draft.salaryTarget}
              onChange={(e) => set('salaryTarget', e.target.value)}
              placeholder="£65,000"
              inputMode="numeric"
            />
          </Field>
          <fieldset className="mb-5">
            <legend className="mb-2 block text-sm font-semibold">How you want to work</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['remote', 'Remote'],
                  ['hybrid', 'Hybrid'],
                  ['onsite', 'On site'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => set('remote', draft.remote === value ? '' : value)}
                  aria-pressed={draft.remote === value}
                  className={`cursor-pointer rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                    draft.remote === value
                      ? 'border-[var(--color-act)] bg-[var(--color-act-wash)] text-[var(--color-act)]'
                      : 'border-[var(--color-line-strong)] bg-[var(--color-card)] text-[var(--color-ink-soft)] hover:border-[var(--color-act)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        </section>
      )}

      {step === 3 && (
        <section>
          <h2 className="text-[22px] font-bold leading-tight tracking-tight">
            That is everything needed
          </h2>
          <p className="mb-6 mt-1.5 text-[15px] text-[var(--color-ink-soft)]">
            Two files get written on this computer: your CV, and your details. Both are yours to
            edit later from My details.
          </p>

          <dl className="mb-6 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5">
            {[
              ['Your CV', draft.cv.trim() ? `${draft.cv.trim().split(/\s+/).length} words` : '—'],
              ['Name', draft.fullName || '—'],
              ['Email', draft.email || '—'],
              ['Location', draft.location || '—'],
              [
                'Job titles',
                draft.targetRoles.trim()
                  ? draft.targetRoles.trim().split('\n').filter(Boolean).join(', ')
                  : '—',
              ],
              ['Salary target', draft.salaryTarget || '—'],
              [
                'Working pattern',
                draft.remote ? draft.remote[0].toUpperCase() + draft.remote.slice(1) : '—',
              ],
            ].map(([k, v]) => (
              <div
                key={k}
                className="flex flex-col gap-x-6 gap-y-1 border-b border-[var(--color-line)] py-3 last:border-0 sm:flex-row"
              >
                <dt className="text-sm text-[var(--color-ink-faint)] sm:w-40 sm:shrink-0">{k}</dt>
                <dd className="min-w-0 flex-1 break-words text-[15px]">{v}</dd>
              </div>
            ))}
          </dl>

          {/*
            The seam. Writing user-layer files is a backend operation and goes
            through src/application/ per the project rules, so this flow
            collects and reviews but does not yet write. Stated plainly rather
            than shown as a button that silently does nothing.
          */}
          <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-5">
            <p className="font-semibold">Saving is not connected yet</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              This flow collects and checks your answers. Writing them to disk goes through the
              backend’s file operations, which is the next piece of work.
            </p>
          </div>
        </section>
      )}

      <div className="mt-8 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:text-[var(--color-ink)] disabled:invisible"
        >
          ← Back
        </button>
        {step < STEPS.length - 1 && (
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            disabled={!canAdvance}
            className="cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
          >
            {step === 0 && !canAdvance ? 'Paste your CV to continue' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  );
}
