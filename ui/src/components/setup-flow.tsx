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
 * The CV and the five facts needed for a useful first search are mandatory:
 * name, email, location and at least one target title. Everything else is
 * clearly marked recommended or optional and can be added later from My
 * details. In particular, never invent a phone number, salary floor or visa
 * position to make a checklist look complete.
 *
 * NOTHING IS SENT ANYWHERE. Said once, plainly, on the step where they add
 * their CV — the moment the worry actually occurs — and not repeated. Constant
 * reassurance reads as a product with something to hide.
 *
 * NO AI HERE. Onboarding does not spend the user's allowance. They have not
 * seen the product work yet, and asking them to pay for the privilege of
 * setting it up is the wrong first impression.
 */

import { useMemo, useState, useTransition } from 'react';
import { ensureSearchSources, saveDetails } from '@/app/actions';
import { suggestCvContact } from '@/lib/cv-contact-suggestions.mjs';
import { suggestJobTitles } from '@/lib/job-title-suggestions.mjs';
import { locationDefaults } from '@/lib/location-defaults.mjs';
import { onboardingCompleteness } from '@/lib/profile-completeness.mjs';

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
  phone: string;
  linkedin: string;
  portfolioUrl: string;
  github: string;
  location: string;
  country: string;
  city: string;
  timezone: string;
  visaStatus: string;
  targetRoles: string;
  salaryTarget: string;
  minimumSalary: string;
  salaryCurrency: string;
  remote: 'remote' | 'hybrid' | 'onsite' | '';
}

const EMPTY: SetupDraft = {
  cv: '',
  otherCvs: [],
  fullName: '',
  email: '',
  phone: '',
  linkedin: '',
  portfolioUrl: '',
  github: '',
  location: '',
  country: '',
  city: '',
  timezone: '',
  visaStatus: '',
  targetRoles: '',
  salaryTarget: '',
  minimumSalary: '',
  salaryCurrency: '',
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

export function SetupFlow({ initial }: { initial?: Partial<SetupDraft> } = {}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<SetupDraft>(() => ({ ...EMPTY, ...initial, otherCvs: initial?.otherCvs ?? [] }));
  const [pasteOpen, setPasteOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const suggestedContact = useMemo(() => suggestCvContact(draft.cv), [draft.cv]);
  const suggestedRoles = useMemo(() => suggestJobTitles(draft.cv), [draft.cv]);
  const set = <K extends keyof SetupDraft>(k: K, v: SetupDraft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const addSuggestedRole = (title: string) =>
    setDraft((d) => {
      const roles = d.targetRoles.split('\n').map((role) => role.trim()).filter(Boolean);
      if (roles.some((role) => role.toLocaleLowerCase('en') === title.toLocaleLowerCase('en'))) {
        return d;
      }
      return { ...d, targetRoles: [...roles, title].join('\n') };
    });

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

  const completeness = onboardingCompleteness(draft);

  const advance = () => {
    if (step === 0) {
      setDraft((d) => ({
        ...d,
        fullName: d.fullName || suggestedContact.name || '',
        email: d.email || suggestedContact.email || '',
        location: d.location || suggestedContact.location || '',
      }));
    }
    if (step === 1) {
      setDraft((d) => {
        const regional = locationDefaults(d.location);
        return {
          ...d,
          city: d.city || regional.city,
          country: d.country || regional.country,
          timezone: d.timezone || regional.timezone,
          salaryCurrency: d.salaryCurrency || regional.currency,
        };
      });
    }
    setStep((s) => s + 1);
  };

  /**
   * Write everything, then leave setup for good.
   *
   * A full page navigation rather than a client route change: the whole app
   * reads these files on the server, and every screen behind this one was
   * rendered when they did not exist.
   *
   * Every field shown by onboarding is sent, including an explicit blank when
   * the answer was not supplied. That matters on a half-created workspace:
   * an old example value must not survive simply because the new screen hid
   * the field.
   */
  const save = () => {
    if (!completeness.ready) {
      setError(`Complete these details before your first search: ${completeness.requiredMissing.map((item) => item.label).join(', ')}.`);
      return;
    }
    setSaving(true);
    setError(null);
    const fields: Record<string, string | string[]> = {};
    fields['candidate.full_name'] = draft.fullName.trim();
    fields['candidate.email'] = draft.email.trim();
    fields['candidate.phone'] = draft.phone.trim();
    fields['candidate.linkedin'] = draft.linkedin.trim();
    fields['candidate.portfolio_url'] = draft.portfolioUrl.trim();
    fields['candidate.github'] = draft.github.trim();
    fields['candidate.location'] = draft.location.trim();
    const regional = locationDefaults(draft.location);
    fields['location.city'] = draft.city.trim() || regional.city;
    fields['location.country'] = draft.country.trim() || regional.country;
    fields['location.timezone'] = draft.timezone.trim() || regional.timezone;
    fields['location.visa_status'] = draft.visaStatus.trim();
    fields['compensation.currency'] = draft.salaryCurrency.trim() || regional.currency;
    fields['compensation.target_range'] = draft.salaryTarget.trim();
    fields['compensation.minimum'] = draft.minimumSalary.trim();
    fields['compensation.location_flexibility'] = REMOTE_LABEL[draft.remote] ?? '';

    const roles = draft.targetRoles.split('\n').map((r) => r.trim()).filter(Boolean);
    fields['target_roles.primary'] = roles;

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
      const sources = await ensureSearchSources();
      if ('error' in sources) {
        setError(sources.error);
        setSaving(false);
        return;
      }
      // Setup is complete; the next useful thing is the first search, not an
      // empty dashboard that makes a new user infer the product's purpose.
      window.location.href = '/found?welcome=1';
    });
  };

  const canAdvance = step === 0
    ? draft.cv.trim().length > 40
    : step === 1
      ? Boolean(draft.fullName.trim() && draft.email.trim() && draft.location.trim())
      : step === 2
        ? draft.targetRoles.split(/\r?\n/u).some((role) => role.trim())
        : true;

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
          {step === 0 ? "Let's get you set up" : 'Setting up'}
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
          {(suggestedContact.name || suggestedContact.email || suggestedContact.location) && (
            <p className="mb-5 rounded-lg border border-[var(--color-line)] bg-[var(--color-card)] px-3.5 py-3 text-sm text-[var(--color-ink-soft)]">
              We filled what we could identify in your CV. Check it and change anything that is
              not right.
            </p>
          )}
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
              onChange={(e) => {
                const next = e.target.value;
                setDraft((current) => {
                  const previousRegional = locationDefaults(current.location);
                  const nextRegional = locationDefaults(next);
                  return {
                    ...current,
                    location: next,
                    city: current.city === previousRegional.city ? nextRegional.city : current.city,
                    country: current.country === previousRegional.country ? nextRegional.country : current.country,
                    timezone: current.timezone === previousRegional.timezone ? nextRegional.timezone : current.timezone,
                    salaryCurrency: current.salaryCurrency === previousRegional.currency
                      ? nextRegional.currency
                      : current.salaryCurrency,
                  };
                });
              }}
              placeholder="Manchester, UK"
            />
          </Field>
          <div className="grid gap-x-5 sm:grid-cols-2">
            <Field label="Phone" hint="Optional — used only in application material.">
              <input
                className={FIELD}
                value={draft.phone}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="+44 20 1234 5678"
                autoComplete="tel"
              />
            </Field>
            <Field label="LinkedIn" hint="Optional.">
              <input
                className={FIELD}
                value={draft.linkedin}
                onChange={(e) => set('linkedin', e.target.value)}
                placeholder="linkedin.com/in/you"
                inputMode="url"
              />
            </Field>
            <Field label="Portfolio" hint="Optional.">
              <input
                className={FIELD}
                value={draft.portfolioUrl}
                onChange={(e) => set('portfolioUrl', e.target.value)}
                placeholder="https://your-site.example"
                inputMode="url"
              />
            </Field>
            <Field label="GitHub" hint="Optional.">
              <input
                className={FIELD}
                value={draft.github}
                onChange={(e) => set('github', e.target.value)}
                placeholder="github.com/you"
                inputMode="url"
              />
            </Field>
          </div>
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
            hint="Choose any useful suggestions from your CV, then add or change them. Only include roles you would actually accept."
          >
            <textarea
              className={`${FIELD} resize-y`}
              rows={4}
              value={draft.targetRoles}
              onChange={(e) => set('targetRoles', e.target.value)}
              placeholder={'Head of Operations\nOperations Director'}
            />
            {suggestedRoles.length > 0 ? (
              <div className="mt-3">
                <p className="text-sm font-medium text-[var(--color-ink-soft)]">
                  Suggested from your CV
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestedRoles.map((title) => {
                    const selected = draft.targetRoles
                      .split('\n')
                      .some((role) => role.trim().toLocaleLowerCase('en') === title.toLocaleLowerCase('en'));
                    return (
                      <button
                        key={title}
                        type="button"
                        onClick={() => addSuggestedRole(title)}
                        disabled={selected}
                        aria-pressed={selected}
                        className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                          selected
                            ? 'cursor-default border-[var(--color-act)] bg-[var(--color-act-wash)] text-[var(--color-act)]'
                            : 'cursor-pointer border-[var(--color-line-strong)] bg-[var(--color-card)] text-[var(--color-ink-soft)] hover:border-[var(--color-act)] hover:text-[var(--color-act)]'
                        }`}
                      >
                        {selected ? '✓ ' : '+ '}
                        {title}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-[var(--color-ink-faint)]">
                We could not reliably identify a title in your CV, so add the roles you would be
                happy to see.
              </p>
            )}
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
          <div className="grid gap-x-5 sm:grid-cols-2">
            <Field
              label="Lowest figure you would consider"
              hint="Optional and private — leave blank if you do not use a walk-away number."
            >
              <input
                className={FIELD}
                value={draft.minimumSalary}
                onChange={(e) => set('minimumSalary', e.target.value)}
                placeholder="£55,000"
                inputMode="numeric"
              />
            </Field>
            <Field label="Salary currency" hint="Check the suggested currency before saving.">
              <input
                className={`${FIELD} uppercase`}
                value={draft.salaryCurrency}
                onChange={(e) => set('salaryCurrency', e.target.value.toUpperCase())}
                placeholder="GBP"
                maxLength={8}
                autoCapitalize="characters"
              />
            </Field>
          </div>
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
          <div className="grid gap-x-5 sm:grid-cols-2">
            <Field label="Search area" hint="The city or region you would commute to, if different from where you live.">
              <input
                className={FIELD}
                value={draft.city}
                onChange={(e) => set('city', e.target.value)}
                placeholder="Manchester"
              />
            </Field>
            <Field label="Search country" hint="Check this inferred value; it is never guessed from a US default.">
              <input
                className={FIELD}
                value={draft.country}
                onChange={(e) => set('country', e.target.value)}
                placeholder="United Kingdom"
              />
            </Field>
            <Field label="Timezone" hint="Optional, but useful for remote roles.">
              <input
                className={FIELD}
                value={draft.timezone}
                onChange={(e) => set('timezone', e.target.value)}
                placeholder="Europe/London"
              />
            </Field>
            <Field label="Work authorisation" hint="Optional. Say what is true for you, or leave blank.">
              <input
                className={FIELD}
                value={draft.visaStatus}
                onChange={(e) => set('visaStatus', e.target.value)}
                placeholder="No sponsorship required"
              />
            </Field>
          </div>
        </section>
      )}

      {step === 3 && (
        <section>
          <h2 className="text-[22px] font-bold leading-tight tracking-tight">
            Review your profile before the first search
          </h2>
          <p className="mb-6 mt-1.5 text-[15px] text-[var(--color-ink-soft)]">
            We will show you what was captured and what is still missing. Nothing is hidden behind
            a completed-looking screen, and you can change every value later from My details.
          </p>

          <div className="mb-6 space-y-3">
            <div
              className={`rounded-xl border p-4 ${
                completeness.ready
                  ? 'border-[var(--color-ready)]/35 bg-[var(--color-ready-wash)]'
                  : 'border-[var(--color-attention)] bg-[var(--color-attention-wash)]'
              }`}
            >
              <p className="font-semibold">
                {completeness.ready ? 'Core profile ready' : 'A few core details still need you'}
              </p>
              {completeness.requiredMissing.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--color-ink-soft)]">
                  {completeness.requiredMissing.map((item) => <li key={item.id}>{item.label} — {item.reason}</li>)}
                </ul>
              )}
              {completeness.ready && (
                <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                  The first search can run. The recommended details below improve matching but do
                  not block you.
                </p>
              )}
            </div>

            {completeness.recommendedMissing.length > 0 && (
              <details className="rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold">
                  Recommended to confirm ({completeness.recommendedMissing.length})
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--color-ink-soft)]">
                  {completeness.recommendedMissing.map((item) => <li key={item.id}>{item.label} — {item.reason}</li>)}
                </ul>
              </details>
            )}

            {completeness.optionalMissing.length > 0 && (
              <p className="text-sm text-[var(--color-ink-faint)]">
                {completeness.optionalMissing.length} optional field{completeness.optionalMissing.length === 1 ? '' : 's'}
                {' '}not provided. That is fine — add them later if they are useful to you.
              </p>
            )}
          </div>

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
              ['Phone', draft.phone || 'Not provided'],
              ['Location', draft.location || '—'],
              ['LinkedIn', draft.linkedin || 'Not provided'],
              ['Portfolio', draft.portfolioUrl || 'Not provided'],
              ['GitHub', draft.github || 'Not provided'],
              [
                'Job titles',
                draft.targetRoles.trim()
                  ? draft.targetRoles.trim().split('\n').filter(Boolean).join(', ')
                  : '—',
              ],
              ['Salary target', draft.salaryTarget || '—'],
              ['Lowest figure', draft.minimumSalary || 'Not provided'],
              ['Salary currency', draft.salaryCurrency || 'Not confirmed'],
              [
                'Working pattern',
                draft.remote ? draft.remote[0].toUpperCase() + draft.remote.slice(1) : '—',
              ],
              ['Search area', draft.city || 'Not provided'],
              ['Search country', draft.country || 'Not confirmed'],
              ['Timezone', draft.timezone || 'Not confirmed'],
              ['Work authorisation', draft.visaStatus || 'Not provided'],
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
            disabled={saving || !completeness.ready}
            className="w-full cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-3 text-[15px] font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)] sm:w-auto"
          >
            {saving ? 'Saving…' : completeness.ready ? 'Finish and find roles' : 'Complete required details first'}
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
            onClick={advance}
            disabled={!canAdvance}
            className="cursor-pointer rounded-lg bg-[var(--color-act)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-act-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-line-strong)]"
          >
            {!canAdvance && step === 0
              ? 'Add your CV to continue'
              : !canAdvance && step === 1
                ? 'Complete your details to continue'
                : !canAdvance && step === 2
                  ? 'Add a target title to continue'
                  : 'Continue'}
          </button>
        )}
      </div>
    </div>
  );
}
