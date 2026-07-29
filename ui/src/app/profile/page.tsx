/**
 * "My details" — what the tool knows about you, and therefore what every
 * assessment is judged against.
 *
 * Read first, edit on request. config/profile.yml is a hand-edited file full
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
import { readProfile as readEditableFields } from '@/lib/profile-save';
import { EditDetails } from '@/components/edit-details';
import { ReplaceCv } from '@/components/replace-cv';
import { readHealth } from '@/lib/health';
import { ConnectionDetail } from '@/components/connection';

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

const NOT_SET = <span className="text-[var(--color-ink-faint)]">Not set</span>;

export default async function ProfilePage() {
  const [p, editable, health] = await Promise.all([readProfile(), readEditableFields(), readHealth()]);
  const text = (path: string) => typeof editable[path] === 'string' ? editable[path] as string : '';
  const searchArea = [text('location.city'), text('location.country')].filter(Boolean).join(', ');

  return (
    <>
      <div className="mb-8">
        <h1 className="text-[30px] font-bold leading-tight tracking-[-0.025em] sm:text-[34px]">My details</h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          Every role is judged against this. The better it describes you, the better the matches.
        </p>
      </div>

      <section className="mb-9 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-2 shadow-[0_1px_2px_rgb(26_25_23/0.03)] sm:px-6">
        <dl>
          <Row label="Name" value={p.name ?? NOT_SET} />
          <Row label="Email" value={p.email ?? NOT_SET} />
          <Row label="Location" value={p.location ?? NOT_SET} />
        </dl>
      </section>

      <h2 className="mb-2.5 text-[17px] font-bold tracking-tight">What you are looking for</h2>
      <section className="mb-9 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-2 shadow-[0_1px_2px_rgb(26_25_23/0.03)] sm:px-6">
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
          <Row label="Work authorisation" value={text('location.visa_status') || NOT_SET} />
        </dl>
      </section>

      <ConnectionDetail health={health} />

      <h2 className="mb-2.5 text-[17px] font-bold tracking-tight">Your CV</h2>
      <section className="mb-9 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-2 shadow-[0_1px_2px_rgb(26_25_23/0.03)] sm:px-6">
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
      </section>

      {/*
        This block used to say editing was coming, because writing a heavily
        commented YAML file without destroying it was unsolved. It now goes
        through src/application/profile-write.mjs, which patches the document
        in place and leaves every comment and unknown key intact.
      */}
      <EditDetails initial={editable} />
    </>
  );
}
