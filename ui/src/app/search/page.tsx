/**
 * "Where to search" — the settings that decide what the scanner brings back.
 *
 * Previously these existed only as `workspace/search/portals.yml`, so the
 * question every user eventually asks — why am I seeing these jobs, and not
 * others? — had no answer inside the product. The keywords were written once
 * during setup from their target job titles and were then unreachable.
 *
 * This page is read-and-edit rather than read-only, unlike My details. The
 * reason is that being wrong here is normal: a first search always brings back
 * something surprising, and tuning the keywords is the loop that makes the
 * tool fit the person rather than the other way round.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { readSearchConfig } from '@/lib/search-config';
import { readRunningCompanyDiscovery, readRunningCompanySuggestion } from '@/lib/jobs';
import { readCompanySuggestions } from '@/lib/company-suggestions';
import { readHealth } from '@/lib/health';
import { readSetup } from '@/lib/setup';
import { SearchSettings } from '@/components/search-settings';
import { CreateSearchSettings } from '@/components/create-search-settings';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Where to search' };

export default async function SearchPage() {
  if (readSetup().needed) redirect('/welcome');
  const [config, discoveryJob, suggestionJob, suggestions, health] = await Promise.all([
    readSearchConfig(),
    readRunningCompanyDiscovery(),
    readRunningCompanySuggestion(),
    readCompanySuggestions(),
    readHealth(),
  ]);

  return (
    <>
      <div className="mb-8">
        <p className="page-eyebrow">Your search</p>
        <h1 className="editorial-title">Where to search</h1>
        <p className="page-lead mt-3 text-[var(--color-ink-soft)]">
          These decide which jobs are brought back at all. Everything here is free except asking
          the AI to suggest employers, which is marked where it appears.
        </p>
      </div>

      {config.unreadable ? (
        /*
          Deliberately not offered a fix button. Creating settings would refuse
          — the file is there — and the screen would come straight back, which
          is the worst kind of dead end: one that looks like it is working.
        */
        <section className="paper-surface mb-9 rounded-2xl border border-[var(--color-attention)] p-8">
          <p className="font-semibold text-[var(--color-attention)]">
            Your search settings could not be read
          </p>
          <p className="mt-1 max-w-lg text-sm text-[var(--color-ink-soft)]">
            The file <code>workspace/search/portals.yml</code> has a formatting error, so
            Frontrunner has left it untouched rather than risk losing what is in it. Searching will
            not work until it is fixed. If you have not edited it by hand, deleting the file lets
            Frontrunner build a fresh one.
          </p>
        </section>
      ) : config.exists ? (
        <SearchSettings
          config={config}
          discoveryJob={discoveryJob}
          suggestionJob={suggestionJob}
          suggestions={suggestions}
          connected={health.signedIn}
        />
      ) : (
        /*
          Reachable by installations created before setup wrote this file, and
          by anyone who deleted it. Offering the fix beats explaining the
          problem: the alternative is a scan that fails with a missing-file
          error naming a path they cannot act on.
        */
        <CreateSearchSettings />
      )}

      <p className="text-sm text-[var(--color-ink-soft)]">
        Roles that were brought back and then ruled out are listed under{' '}
        <Link href="/found" className="font-medium text-[var(--color-act)] underline underline-offset-2">
          Everything found
        </Link>
        , with the reason for each one.
      </p>
    </>
  );
}
