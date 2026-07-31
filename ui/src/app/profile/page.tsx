/**
 * "My details" — what the tool knows about you, and therefore what every
 * assessment is judged against.
 *
 * Read first, edit on request. workspace/profile/profile.yml is a hand-edited file full
 * of comments and structure, and for a long time that made a form too risky to
 * offer: a naive write would have destroyed it. It now goes through
 * src/application/profile-write.mjs, which patches the document in place and
 * leaves every comment and unknown key intact.
 *
 * The page still opens read-only. People come here to check something far more
 * often than to change it, and a screen of live inputs invites accidental
 * edits to the file every assessment is judged against.
 */

import { readProfile } from '@/lib/profile';
import { readProfileSnapshot } from '@/lib/profile-save';
import { EditDetails } from '@/components/edit-details';
import { ReplaceCv } from '@/components/replace-cv';
import { AdditionalCvs } from '@/components/additional-cvs';
import { readHealth } from '@/lib/health';
import { ConnectionDetail } from '@/components/connection';
import { profileCompleteness } from '@/lib/profile-completeness.mjs';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'My details' };

/**
 * Label above value on a phone, beside it on a laptop.
 *
 * A fixed 160px label column leaves about 110px for the value at 375px, which
 * is not enough for an email address (it overflowed the card) or for a row of
 * chips (each one wrapped to three lines). `break-words` covers the addresses
 * and URLs that have no space to break at.
 */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-x-6 gap-y-1 border-b border-[var(--color-line)] py-3 last:border-0 sm:flex-row">
      <dt className="text-sm text-[var(--color-ink-faint)] sm:w-40 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-[15px]">{value}</dd>
    </div>
  );
}

const NOT_SET = <span className="text-[var(--color-ink-faint)]">Not provided yet</span>;

export default async function ProfilePage() {
  const [p, snapshot, health] = await Promise.all([
    readProfile(),
    readProfileSnapshot(),
    readHealth(),
  ]);
  const editable = snapshot.fields;
  const text = (path: string) => typeof editable[path] === 'string' ? editable[path] as string : '';
  const searchArea = [text('location.city'), text('location.country')].filter(Boolean).join(', ');
  const completeness = profileCompleteness({ fields: editable, hasCv: p.hasCv });

  return (
    <>
      <div className="mb-8">
        <p className="page-eyebrow">Your profile</p>
        <h1 className="editorial-title">My details</h1>
        <p className="page-lead mt-3 text-[var(--color-ink-soft)]">
          Every role is judged against this. The better it describes you, the better the matches.
        </p>
      </div>

      {(completeness.requiredMissing.length > 0 || completeness.recommendedMissing.length > 0) && (
        <section
          className={`mb-8 rounded-2xl border p-5 ${
            completeness.requiredMissing.length > 0
              ? 'border-[var(--color-attention)] bg-[var(--color-attention-wash)]'
              : 'border-[var(--color-line)] bg-[var(--color-card)]'
          }`}
        >
          <p className="font-semibold">
            {completeness.requiredMissing.length > 0
              ? 'Your profile still needs a few core details'
              : 'A few profile details are worth confirming'}
          </p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            An existing profile file does not mean every field is complete. Missing values are
            shown honestly here rather than filled with example data.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--color-ink-soft)]">
            {[...completeness.requiredMissing, ...completeness.recommendedMissing].map((item) => (
              <li key={item.id}><span className="font-medium">{item.label}</span> — {item.reason}</li>
            ))}
          </ul>
          <a
            href="#edit-details"
            className="mt-3 inline-block text-sm font-semibold text-[var(--color-act)] underline underline-offset-2"
          >
            Review these details
          </a>
        </section>
      )}

      <section className="paper-surface mb-9 rounded-2xl border px-5 py-2 sm:px-6">
        <dl>
          <Row label="Name" value={p.name ?? NOT_SET} />
          <Row label="Email" value={p.email ?? NOT_SET} />
          <Row label="Location" value={p.location ?? NOT_SET} />
          <Row label="Phone" value={text('candidate.phone') || NOT_SET} />
          <Row label="LinkedIn" value={text('candidate.linkedin') || NOT_SET} />
          <Row label="Portfolio" value={text('candidate.portfolio_url') || NOT_SET} />
          <Row label="GitHub" value={text('candidate.github') || NOT_SET} />
        </dl>
      </section>

      <h2 className="mb-2.5 text-[17px] font-bold tracking-tight">What you are looking for</h2>
      <section className="paper-surface mb-9 rounded-2xl border px-5 py-2 sm:px-6">
        <dl>
          <Row
            label="Target roles"
            value={
              p.targetRoles.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {p.targetRoles.map((r) => (
                    <span
                      key={r}
                      className="rounded-full bg-[var(--color-act-wash)] px-2.5 py-1 text-xs font-medium text-[var(--color-act)]"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              ) : (
                NOT_SET
              )
            }
          />
          <Row label="Target pay" value={p.compTarget ?? NOT_SET} />
          <Row label="Walk-away figure" value={p.compMinimum ?? NOT_SET} />
          <Row label="Salary currency" value={text('compensation.currency') || NOT_SET} />
          <Row label="Working pattern" value={text('compensation.location_flexibility') || NOT_SET} />
          <Row label="Search area" value={searchArea || NOT_SET} />
          <Row label="Timezone" value={text('location.timezone') || NOT_SET} />
          <Row label="Work authorisation (optional)" value={text('location.visa_status') || NOT_SET} />
        </dl>
      </section>

      <ConnectionDetail health={health} />

      <h2 className="mb-2.5 text-[17px] font-bold tracking-tight">Your CV</h2>
      <section className="paper-surface mb-9 rounded-2xl border px-5 py-2 sm:px-6">
        <dl>
          <Row
            label="Status"
            value={
              p.hasCv ? (
                <span className="font-medium text-[var(--color-ready)]">
                  Loaded · {p.cvWords.toLocaleString()} words
                </span>
              ) : (
                <span className="font-medium text-[var(--color-attention)]">
                  No CV yet — matching cannot work without one
                </span>
              )
            }
          />
        </dl>
        <ReplaceCv currentWords={p.cvWords} hasCv={p.hasCv} />
        <AdditionalCvs versions={snapshot.versions} />
      </section>

      {/*
        This block used to say editing was coming, because writing a heavily
        commented YAML file without destroying it was unsolved. It now goes
        through src/application/profile-write.mjs, which patches the document
        in place and leaves every comment and unknown key intact.
      */}
      <div id="edit-details">
        <EditDetails initial={editable} />
      </div>
    </>
  );
}
