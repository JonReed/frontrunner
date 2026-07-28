/**
 * "My details" — what the tool knows about you, and therefore what every
 * assessment is judged against.
 *
 * Read-only in this first pass, on purpose. config/profile.yml and cv.md are
 * hand-edited files full of comments and structure; writing them back from a
 * form without careful round-tripping would silently destroy that. Showing
 * what is set, and being honest that editing happens in the files for now, is
 * better than a form that quietly loses work.
 */

import { readProfile } from '@/lib/profile';

export const dynamic = 'force-dynamic';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-[var(--color-line)] py-3 last:border-0">
      <dt className="w-40 shrink-0 text-sm text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1 text-[15px]">{value}</dd>
    </div>
  );
}

const NOT_SET = <span className="text-[var(--color-ink-faint)]">Not set</span>;

export default async function ProfilePage() {
  const p = await readProfile();

  return (
    <>
      <div className="mb-8">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight">My details</h1>
        <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">
          Every role is judged against this. The better it describes you, the better the matches.
        </p>
      </div>

      <section className="mb-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-2">
        <dl>
          <Row label="Name" value={p.name ?? NOT_SET} />
          <Row label="Email" value={p.email ?? NOT_SET} />
          <Row label="Location" value={p.location ?? NOT_SET} />
        </dl>
      </section>

      <h2 className="mb-2 text-base font-bold tracking-tight">What you are looking for</h2>
      <section className="mb-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-2">
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
        </dl>
      </section>

      <h2 className="mb-2 text-base font-bold tracking-tight">Your CV</h2>
      <section className="mb-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-2">
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
      </section>

      {/*
        Honest about the current limitation rather than shipping a form that
        might mangle a commented YAML file.
      */}
      <div className="rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-5">
        <p className="text-sm font-semibold">Editing is coming</p>
        <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
          For now these live in <code className="rounded bg-[var(--color-paper)] px-1 py-0.5 text-[13px]">config/profile.yml</code>{' '}
          and <code className="rounded bg-[var(--color-paper)] px-1 py-0.5 text-[13px]">cv.md</code>. Ask the assistant to
          change them for you — &ldquo;update my target salary to £180k&rdquo; works.
        </p>
      </div>
    </>
  );
}
