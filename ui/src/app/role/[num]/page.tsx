/**
 * The role page — where a decision gets made, and the only place that spends
 * the user's AI allowance.
 *
 * Order matters. The assessment comes first — what the job is, why they fit,
 * what is weak, what interviewers will push on — and only then does the page
 * offer to build a tailored CV.
 *
 * That sequence is the whole correction. An earlier version put "Generate
 * tailored CV" on the list page, which asked someone to spend their allowance
 * on a role they had not read. The honest response to that button is "I don't
 * know enough yet."
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readTracker, readReport } from '@/lib/roles';
import { parseReport } from '@/lib/report';
import { safeExternalUrl } from '@/lib/urls';
import { ReportMarkdown } from '@/components/report-markdown';
import { Match } from '@/components/match';
import { BuildCv } from '@/components/build-cv';
import { CvLinks } from '@/components/cv-links';

export const dynamic = 'force-dynamic';

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2 text-base font-bold tracking-tight">{title}</h2>
      <div className="space-y-2.5 text-[15px] leading-relaxed text-[var(--color-ink-soft)] [&_strong]:text-[var(--color-ink)]">
        <ReportMarkdown body={body} />
      </div>
    </section>
  );
}

export default async function RolePage({ params }: { params: Promise<{ num: string }> }) {
  const { num } = await params;
  const roles = await readTracker();
  const role = roles.find((r) => String(r.num) === num);
  if (!role) notFound();

  const markdown = role.reportPath ? await readReport(role.reportPath) : null;
  const report = markdown ? parseReport(markdown) : null;
  const jobUrl = safeExternalUrl(role.url);

  return (
    // pb-28: the action bar is sticky, so without room beneath it the final
    // section scrolls underneath and cannot be read.
    <div className="pb-28">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-[var(--color-ink-faint)] transition hover:text-[var(--color-act)]"
      >
        ← Back
      </Link>

      <header className="mb-8">
        <h1 className="text-[26px] font-bold leading-tight tracking-tight">{role.company}</h1>
        <p className="mt-0.5 text-[17px] text-[var(--color-ink-soft)]">{role.role}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Match score={role.score} />
          <span className="text-sm text-[var(--color-ink-faint)]">{role.status}</span>
          {role.hasPdf && (
            <span className="text-sm font-medium text-[var(--color-ready)]">Tailored CV ready</span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
        {role.pdf && <CvLinks pdf={role.pdf} />}
        {/* Read the original before trusting anything below it. */}
        {jobUrl && (
          <a
            href={jobUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink-soft)] transition hover:border-[var(--color-act)] hover:text-[var(--color-act)]"
          >
            Read the original job advert
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M4.5 2h5.5v5.5M10 2L4 8M8 10H2V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
        </div>
      </header>

      {/* The assessment. */}
      {report ? (
        <>
          {report.primary.map((s) => (
            <Section key={s.id} title={s.title} body={s.body} />
          ))}

          {report.secondary.length > 0 && (
            <details className="mb-8 rounded-xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-4">
              <summary className="cursor-pointer text-sm font-semibold">
                More detail
                <span className="ml-2 font-normal text-[var(--color-ink-faint)]">
                  scoring, keywords, posting checks
                </span>
              </summary>
              <div className="mt-5 border-t border-[var(--color-line)] pt-5">
                {report.secondary.map((s) => (
                  <Section key={s.id} title={s.title} body={s.body} />
                ))}
              </div>
            </details>
          )}
        </>
      ) : (
        <div className="mb-8 rounded-xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-8 text-center">
          <p className="font-medium">No assessment for this role yet.</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Score it to see how well it matches your CV.
          </p>
        </div>
      )}

      {/*
        The AI action sits at the BOTTOM, after the reasons to want it, and is
        badged so it is never a surprise.
      */}
      <div className="sticky bottom-4 rounded-xl border border-[var(--color-line-strong)] bg-[var(--color-card)] p-5 shadow-md shadow-black/5">
        <BuildCv roleNum={role.num} hasPdf={role.hasPdf} pdf={role.pdf} url={jobUrl} score={role.score} />
      </div>
    </div>
  );
}
