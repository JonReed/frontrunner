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
 * NOTHING IS SENT ANYWHERE. Said once, plainly, on the step where they add
 * their CV — the moment the worry actually occurs — and not repeated. Constant
 * reassurance reads as a product with something to hide.
 *
 * NO AI HERE. Onboarding does not spend the user's allowance. They have not
 * seen the product work yet, and asking them to pay for the privilege of
 * setting it up is the wrong first impression.
 */

import { useState, useTransition } from 'react';
import { saveDetails } from '@/app/actions';

const STEPS = ['Your CV', 'About you', 'What you want', 'Finish'] as const;

/**
 * The working pattern goes into compensation.location_flexibility as prose,
 * because that is the field the evaluation modes already read. Inventing a new
 * key would mean nothing downstream understood the answer.
 */
const REMOTE_LABEL: Record<string, string> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On site',
};

/**
 * One CV. Most people arrive with several.
 *
 * Someone who has been job hunting has an "operations" version and a
 * "programme" version of the same career, worded differently and often
 * containing different facts — a project one of them has room for and the
 * other does not. Those extra versions are the best possible input for
 * tailoring, because they are the user's own words about their own work,
 * already vetted by them. Far better than anything scraped from a profile.
 *
 * But exactly one is canonical. `workspace/profile/cv.md` is what roles are scored against, and
 * the project's source-of-truth rules depend on there being a single answer to
 * "what does this person claim". The others are a corpus: material to draw a
 * suggestion from, never a fact that enters a CV on its own.
 *
 * That distinction is why they cannot simply be merged. An older version may
 * word a title differently, quote a metric that was later revised, or list a
 * role the user deliberately stopped claiming. Merging silently would
 * resurrect dropped claims and put two in-scope sources into contradiction —
 * which is the state in which "reformulated, never fabricated" is hardest to
 * hold.
 */
export interface CvEntry {
  id: string;
  /** The user's own name for this version — "the ops one". */
  label: string;
  text: string;
}

export interface SetupDraft {
  /** Canonical. Becomes workspace/profile/cv.md. */
  cv: string;
  /** Additional versions, kept as reference material. */
  otherCvs: CvEntry[];
  fullName: string;
  email: string;
  location: string;
  targetRoles: string;
  salaryTarget: string;
  remote: 'remote' | 'hybrid' | 'onsite' | '';
}

const EMPTY: SetupDraft = {
  cv: '',
  otherCvs: [],
  fullName: '',
  email: '',
  location: '',
  targetRoles: '',
  salaryTarget: '',
  remote: '',
};

const PLAIN = /\.(md|markdown|txt|text|rtf)$/i;
const WORD = /\.docx$/i;
const LEGACY_WORD = /\.doc$/i;

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsText(file);
  });
}

/**
 * Read a CV file into markdown, in the browser.
 *
 * Word is the format people actually have. Anyone with a PDF CV generated it
 * from Word or Google Docs, and both export .docx directly — so supporting
 * .docx covers nearly everyone, and PDF can be left alone rather than guessed
 * at. There is no deterministic way to read a two-column PDF; text extraction
 * interleaves the columns, and someone's career history is the wrong place to
 * discover that.
 *
 * mammoth is loaded on demand only after a Word file is chosen. It runs
 * entirely client-side, which keeps "nothing is uploaded" literally true and
 * keeps the parsing of an untrusted zip archive inside the browser sandbox
 * rather than in the server process.
 *
 * Markdown rather than raw text because workspace/profile/cv.md is markdown and the user edits
 * it later — keeping their headings and bullets is the difference between a
 * file they recognise and a wall of prose.
 */
/**
 * Undo mammoth's markdown escaping.
 *
 * It escapes every punctuation mark it emits, so a perfectly ordinary line
 * comes back as `Acme Ltd \(2019\-2024\)\.` — which is correct markdown and
 * looks, to the person whose CV it is, like the import corrupted it.
 *
 * Faithfulness beats markdown-correctness here. This text is read by a model
 * as prose and edited by a human in a textarea; neither benefits from escapes,
 * and both are hurt by backslashes on every full stop. A CV that genuinely
 * contained `*` or `_` had them literally, so restoring them is the right
 * answer rather than a compromise.
 */
function unescapeMarkdown(text: string): string {
  // Not \w — that counts underscore as a word character, and `Cost\_centre` is
  // exactly the kind of line this exists to fix.
  return text.replace(/\\([^A-Za-z0-9\s])/g, '$1');
}

async function readCvFile(file: File): Promise<string> {
  if (PLAIN.test(file.name)) return readTextFile(file);
  if (WORD.test(file.name)) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.convertToMarkdown({ arrayBuffer: await file.arrayBuffer() });
    return unescapeMarkdown(value);
  }
  throw new Error(
    LEGACY_WORD.test(file.name)
      ? 'That is an older Word format. Open it in Word and save it as .docx, then try again.'
      : 'Only Word (.docx) and text files can be read. If you have a PDF, export the original as Word — Google Docs and Word both do this — or paste the text instead.',
  );
}

function wordCount(text: string) {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

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

/**
 * Choose a file. This is the primary onboarding path and a quieter secondary
 * convenience for additional CV versions.
 *
 * Text formats only, read in the browser and dropped straight into the box the
 * user can still edit. Nothing is uploaded — the file never leaves the machine,
 * which is also why this needs no server round trip.
 */
function FilePicker({
  onText,
  onError,
  primary = false,
}: {
  onText: (text: string) => void;
  onError: (message: string | null) => void;
  primary?: boolean;
}) {
  // Reading a Word file means fetching the parser first. On a slow connection
  // that is a visible pause, and an unlabelled pause after choosing a file
  // reads as nothing happened.
  const [busy, setBusy] = useState(false);

  // The focus ring lives on the label, not the input. A file input cannot be
  // styled, so the real one is visually hidden — and hidden means 1×1px, which
  // is where the global :focus-visible ring would land. A keyboard user
  // tabbing here would see nothing at all. focus-within puts the ring on the
  // thing that is actually on screen.
  return (
    <label
      className={
        primary
          ? 'flex min-h-36 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] px-6 py-7 text-center transition hover:border-[var(--color-act)] hover:bg-[var(--color-paper)] focus-ring-within'
          : 'inline-flex min-h-[40px] cursor-pointer items-center rounded text-sm font-medium text-[var(--color-ink-soft)] underline decoration-[var(--color-line-strong)] underline-offset-2 transition-[color] hover:text-[var(--color-act)] focus-ring-within sm:min-h-0'
      }
    >
      {primary ? (
        <>
          <svg
            width="28"
            height="28"
            viewBox="0 0 28 28"
            fill="none"
            aria-hidden="true"
            className="mb-3 text-[var(--color-act)]"
          >
            <path d="M14 19V5m0 0-5 5m5-5 5 5M6 17v5h16v-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-semibold text-[var(--color-ink)]">
            {busy ? 'Reading your Word CV…' : 'Choose your Word CV'}
          </span>
          <span className="mt-1 text-sm text-[var(--color-ink-faint)]">
            .docx works best · Markdown and text also accepted
          </span>
        </>
      ) : (
        busy ? 'Reading…' : 'or choose a Word file'
      )}
      <input
        type="file"
        className="sr-only"
        accept=".docx,.md,.markdown,.txt,.text,.rtf"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';                    // let the same file be picked twice
          if (!file) return;
          setBusy(true);
          onError(null);
          try {
            const text = await readCvFile(file);
            if (!text.trim()) {
              // A file that reads as empty is a real outcome, not a success:
              // scanned or image-only documents produce exactly this.
              onError('That file came out empty. Paste the text instead.');
              return;
            }
            onText(text);
          } catch (err) {
            onError(err instanceof Error ? err.message : 'Could not read that file.');
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}

/* -------------------------------------------------------------------- flow */

let nextCvId = 0;

export function SetupFlow() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<SetupDraft>(EMPTY);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const set = <K extends keyof SetupDraft>(k: K, v: SetupDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const addCv = () =>
    setDraft((d) => ({
      ...d,
      otherCvs: [...d.otherCvs, { id: `cv-${nextCvId++}`, label: '', text: '' }],
    }));

  const updateCv = (id: string, patch: Partial<CvEntry>) =>
    setDraft((d) => ({
      ...d,
      otherCvs: d.otherCvs.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));

  const removeCv = (id: string) =>
    setDraft((d) => ({ ...d, otherCvs: d.otherCvs.filter((c) => c.id !== id) }));

  /**
   * Write everything, then leave setup for good.
   *
   * A full page navigation rather than a client route change: the whole app
   * reads these files on the server, and every screen behind this one was
   * rendered when they did not exist.
   *
   * Empty answers are omitted rather than sent as blanks. Someone who skipped
   * the salary question has not asked for their salary target to be cleared,
   * and a first run should never write an empty string over a template's
   * documented default.
   */
  const save = () => {
    setSaving(true);
    setError(null);
    const fields: Record<string, string | string[]> = {};
    const put = (key: string, value: string) => {
      if (value.trim()) fields[key] = value.trim();
    };
    put('candidate.full_name', draft.fullName);
    put('candidate.email', draft.email);
    put('candidate.location', draft.location);
    put('location.city', draft.location);
    put('compensation.target_range', draft.salaryTarget);
    put('compensation.location_flexibility', REMOTE_LABEL[draft.remote] ?? '');

    const roles = draft.targetRoles.split('\n').map((r) => r.trim()).filter(Boolean);
    if (roles.length > 0) fields['target_roles.primary'] = roles;

    const versions = draft.otherCvs
      .filter((c) => c.text.trim())
      .map((c) => ({ label: c.label, text: c.text }));

    startTransition(async () => {
      const result = await saveDetails({ fields, cv: draft.cv, versions });
      if ('error' in result) {
        setError(result.error);
        setSaving(false);
        return;
      }
      window.location.href = '/';
    });
  };

  // The CV is the only hard gate. Everything else can be filled in later from
  // My details, and blocking on it would be inventing work.
  const canAdvance = step === 0 ? draft.cv.trim().length > 40 : true;

  return (
    <div className="onboarding-shell mx-auto max-w-2xl">
      <div className="onboarding-material" aria-hidden="true">
        <span className="onboarding-material__mark">
          <i />
          <b>✓</b>
        </span>
      </div>
      {/*
        The welcome copy earns its place once, on the first screen, and then
        gets out of the way. Repeated above every step it took a third of a
        phone screen to tell someone something they had already read — and the
        thing they need is the question, not the preamble.
      */}
      <div className="mb-9">
        <p className="page-eyebrow">Welcome to Frontrunner</p>
        <h1 className="editorial-title">
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
            Choose the Word document you already use. We will turn it into editable text for you
            to check before continuing.
          </p>
          <p className="mt-3 text-sm text-[var(--color-ink-faint)]">
            The import is processed in this browser and saved as a file on this computer. Relevant
            parts are sent to your AI provider when you use model-backed assessment or tailoring.
          </p>

          <div className="mt-6">
            <FilePicker
              primary
              onText={(text) => {
                set('cv', text);
                setPasteOpen(false);
              }}
              onError={setFileError}
            />
            {fileError && (
              <p className="mt-2 text-sm text-[var(--color-attention)]">{fileError}</p>
            )}

            {!draft.cv.trim() && !pasteOpen && (
              <button
                type="button"
                onClick={() => setPasteOpen(true)}
                className="mt-4 min-h-10 cursor-pointer text-sm font-medium text-[var(--color-ink-soft)] underline decoration-[var(--color-line-strong)] underline-offset-2 transition hover:text-[var(--color-act)]"
              >
                Paste CV text instead
              </button>
            )}

            {(draft.cv.trim() || pasteOpen) && (
              <div className="mt-5">
                <Field
                  label={draft.cv.trim() ? 'Review your CV text' : 'Paste your CV text'}
                  hint={draft.cv.trim() ? 'Check names, dates and headings before continuing.' : undefined}
                >
                  <textarea
                    value={draft.cv}
                    onChange={(e) => set('cv', e.target.value)}
                    rows={12}
                    placeholder="Paste the whole thing here…"
                    className={`${FIELD} resize-y leading-relaxed`}
                  />
                </Field>
                <p className="-mt-3 text-sm text-[var(--color-ink-faint)]">
                  {draft.cv.trim() ? `${wordCount(draft.cv)} words` : 'Nothing yet'}
                </p>
              </div>
            )}
          </div>

          {/*
            Other versions: optional, and deliberately quiet.

            Valuable — most people have an "ops" CV and a "programme" CV of the
            same career, and the differences between them are exactly what
            makes tailoring good. But this is minute two of someone's first
            session, and a first run that opens by demanding several documents
            is a first run people abandon. So it is collapsed, clearly
            optional, and says what it is for.
          */}
          <details className="mt-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-4">
            <summary className="cursor-pointer text-[15px] font-semibold">
              Have tailored versions of your CV?
              <span className="ml-2 font-normal text-[var(--color-ink-faint)]">optional</span>
            </summary>
            <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
              Most people have a few, worded for different kinds of job. They are not scored
              against and they do not replace the one above — they are kept as reference, so a
              tailored CV can draw on how you have described your own work before.
            </p>

            {draft.otherCvs.length > 0 && (
              <ul className="mt-4 flex flex-col gap-4">
                {draft.otherCvs.map((cv, i) => (
                  <li
                    key={cv.id}
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-paper)] p-4"
                  >
                    <div className="mb-3 flex items-center gap-3">
                      <input
                        className={`${FIELD} py-1.5 text-sm`}
                        value={cv.label}
                        onChange={(e) => updateCv(cv.id, { label: e.target.value })}
                        placeholder={`What is version ${i + 2} for?`}
                        aria-label="What this version is for"
                      />
                      <button
                        type="button"
                        onClick={() => removeCv(cv.id)}
                        className="shrink-0 cursor-pointer rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--color-ink-faint)] transition hover:text-[var(--color-attention)]"
                      >
                        Remove
                      </button>
                    </div>
                    <textarea
                      className={`${FIELD} resize-y text-sm leading-relaxed`}
                      rows={5}
                      value={cv.text}
                      onChange={(e) => updateCv(cv.id, { text: e.target.value })}
                      placeholder="Paste this version…"
                      aria-label="This version of your CV"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <span className="text-sm text-[var(--color-ink-faint)]">
                        {cv.text.trim() ? `${wordCount(cv.text)} words` : 'Nothing yet'}
                      </span>
                      <FilePicker
                        onText={(t) => updateCv(cv.id, { text: t })}
                        onError={setFileError}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={addCv}
              className="mt-4 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
            >
              Add another version
            </button>
          </details>
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
            Everything below is written to files on this computer, and all of it is yours to edit
            later from My details.
          </p>

          <dl className="mb-6 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5">
            {[
              ['Your main CV', draft.cv.trim() ? `${wordCount(draft.cv)} words` : '—'],
              [
                'Tailored versions',
                draft.otherCvs.filter((c) => c.text.trim()).length
                  ? draft.otherCvs
                      .filter((c) => c.text.trim())
                      .map((c, i) => c.label.trim() || `Version ${i + 2}`)
                      .join(', ')
                  : 'None',
              ],
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

          {error && (
            <div className="mb-4 rounded-xl border border-[var(--color-attention)] bg-[var(--color-attention-wash)] p-4">
              <p className="font-semibold text-[var(--color-attention)]">That did not save</p>
              <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{error}</p>
              <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
                Your answers are still here — nothing was lost.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-3 text-[15px] font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)] sm:w-auto"
          >
            {saving ? 'Saving…' : 'Save and start'}
          </button>
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
            {step === 0 && !canAdvance ? 'Add your CV to continue' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  );
}
