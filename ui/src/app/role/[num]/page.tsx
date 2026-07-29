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
import { RoleJourney } from '@/components/journey-rail';
import { RoleActions } from '@/components/role-actions';
import { readHealth } from '@/lib/health';
import { readFollowups } from '@/lib/followups';
import { FollowupStatus } from '@/components/followup-status';
import { readRunningCvJob } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section className="border-b border-[var(--color-line)] py-6 first:pt-0 last:border-0 last:pb-0">
      <h2 className="mb-2 text-base font-bold tracking-tight">{title}</h2>
      <div className="space-y-2.5 text-[15px] leading-relaxed text-[var(--color-ink-soft)] [&_strong]:text-[var(--color-ink)]">
        <ReportMarkdown body={body} />
      </div>
    </section>
  );
}

export default async function RolePage({ params }: { params: Promise<{ num: string }> }) {
  const { num } = await params;
  const [roles, health, followups] = await Promise.all([
    readTracker(),
    readHealth(),
    readFollowups(),
  ]);
  const role = roles.find((r) => String(r.num) === num);
  if (!role) notFound();
  const followup = followups.find((entry) => entry.num === role.num);
  const runningCvJob = await readRunningCvJob(role.num);

  const markdown = role.reportPath ? await readReport(role.reportPath) : null;
  const report = markdown ? parseReport(markdown) : null;
  const jobUrl = safeExternalUrl(role.url);
  const backHref = role.stage === 'inbox'
    ? '/found'
    : `/applications?stage=${role.stage}`;
  const backLabel = role.stage === 'inbox' ? 'Everything found' : 'My applications';

  return (
    // pb-28: the action bar is sticky, so without room beneath it the final
    // section scrolls underneath and cannot be read.
    <div className="mx-auto max-w-3xl pb-10 sm:pb-28">
      <Link
        href={backHref}
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-ink-faint)] transition hover:text-[var(--color-act)]"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M11.5 7h-9M6 3.5 2.5 7 6 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {backLabel}
      </Link>

      <div className="mb-8 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-4 shadow-[0_1px_2px_rgb(26_25_23/0.03)]">
        <RoleJourney stage={role.stage} status={role.status} />
      </div>

      <header className="mb-9">
        <p className="mb-1 text-[15px] font-semibold text-[var(--color-act)]">{role.company}</p>
        <h1 className="text-[30px] font-bold leading-[1.12] tracking-[-0.025em] sm:text-[36px]">{role.role}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Match score={role.score} />
          <span className="text-sm text-[var(--color-ink-faint)]">{role.status}</span>
          {role.hasPdf && (
            <span className="text-sm font-medium text-[var(--color-ready)]">Tailored CV ready</span>
          )}
          {followup && <FollowupStatus followup={followup} detail />}
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
          <article className="mb-8 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-6 shadow-[0_1px_2px_rgb(26_25_23/0.03)] sm:px-7">
            {report.primary.map((s) => (
              <Section key={s.id} title={s.title} body={s.body} />
            ))}
          </article>

          {report.secondary.length > 0 && (
            <details className="mb-8 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] px-5 py-4">
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
        <div className="mb-8 rounded-2xl border border-dashed border-[var(--color-line-strong)] bg-[var(--color-card)] p-8 text-center">
          <p className="font-medium">No assessment for this role yet.</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Score it to see how well it matches your CV.
          </p>
        </div>
      )}

      <section className="mb-8 rounded-2xl border border-[var(--color-line)] bg-[var(--color-card)] p-5">
        <h2 className="font-semibold">Move this role</h2>
        <p className="mb-4 mt-0.5 text-sm text-[var(--color-ink-soft)]">
          Update where it sits, or remove it from the live lists. Its assessment and CV are kept.
        </p>
        <RoleActions
          roleNum={role.num}
          stage={role.stage}
          status={role.status}
          hasPdf={role.hasPdf}
        />
      </section>

      {/*
        The AI action sits at the BOTTOM, after the reasons to want it, and is
        badged so it is never a surprise.
      */}
      <div className="rounded-2xl border border-[var(--color-line-strong)] bg-[color:var(--color-paper-translucent)] p-5 shadow-[0_12px_32px_rgb(26_25_23/0.12)] backdrop-blur-md sm:sticky sm:bottom-4">
        <BuildCv
          roleNum={role.num}
          hasPdf={role.hasPdf}
          pdf={role.pdf}
          url={jobUrl}
          score={role.score}
          connected={health.signedIn}
          initialJob={runningCvJob}
        />
      </div>
    </div>
  );
}
