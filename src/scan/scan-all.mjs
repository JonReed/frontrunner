#!/usr/bin/env node

/**
 * scan-all.mjs — what "Search for roles" actually means.
 *
 * Two passes, in this order, both zero-token:
 *
 *   1. The tracked companies in workspace/search/portals.yml (scan.mjs).
 *      Depth on employers the user has chosen to follow.
 *
 *   2. A bounded reverse sweep of public ATS directories (scan-ats-full.mjs).
 *      Breadth across every company on Greenhouse, Lever, Ashby, Workday and
 *      iCIMS, matched against the same title and location filters.
 *
 * WHY BOTH. The product used to run only the first, which made a curated
 * company list the foundation of the whole search — so a new user inherited
 * the template's list (technology companies, because that is the search this
 * project was built for) and a search that could not find anything relevant
 * to them until they edited YAML. The second pass needs no company list at
 * all: it reads the user's own keywords and finds whoever is hiring against
 * them. That inverts the dependency. The curated list becomes an addition —
 * depth where the user wants it — rather than the thing the product stands on.
 *
 * WHY BOUNDED. A full sweep of every public ATS board is a multi-hour job, and
 * the person who pressed the button is waiting. So the sweep runs against a
 * wall-clock budget: at the deadline it is asked to stop, its own signal
 * handler writes a checkpoint, and the next search resumes from there with
 * --resume. Every search therefore finishes in a predictable time AND makes
 * real progress through the directory, rather than restarting from the top or
 * running until it is killed.
 *
 * Both passes append through the same locked writer and dedupe against the
 * same scan history, so running them together cannot produce duplicates.
 */

import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { runBoundedSubprocess } from '../security/subprocess.mjs';

/**
 * How long the reverse sweep may run.
 *
 * The scan operation's own timeout is 15 minutes, so this leaves room for the
 * tracked-company pass before it and for the checkpoint write after it. Being
 * stopped here is the expected outcome, not a failure.
 */
const SWEEP_BUDGET_MS = 8 * 60_000;
/** Long enough for the sweep's SIGTERM handler to persist its checkpoint. */
const SWEEP_GRACE_MS = 5_000;
/** Fresh postings only. The reverse sweep is a discovery pass, not an archive. */
const SWEEP_SINCE_DAYS = 7;
const OUTPUT_BYTES = 4 * 1024 * 1024;
/** The tracked-company pass is small and bounded by the user's own list. */
const TRACKED_TIMEOUT_MS = 5 * 60_000;

function tail(text) {
  return String(text ?? '').trim().split('\n').slice(-4).join('\n');
}

/**
 * Run one pass, treating a non-zero exit as a reported outcome rather than a
 * thrown failure.
 *
 * A search is worth running even when half of it fails: an unreachable job
 * board must not lose the user the results the other pass already found.
 */
async function pass(name, args, { timeoutMs, terminationGraceMs = 500, run = runBoundedSubprocess }) {
  try {
    const result = await run(process.execPath, args, {
      cwd: ROOT,
      timeoutMs,
      terminationGraceMs,
      maxStdoutBytes: OUTPUT_BYTES,
      maxStderrBytes: 512 * 1024,
    });
    return {
      pass: name,
      status: result.status === 0 ? 'ok' : 'failed',
      ...(result.status === 0 ? {} : { detail: tail(result.stderr) || tail(result.stdout) }),
    };
  } catch (error) {
    // A budget stop is success for the sweep: its checkpoint has been written
    // and the next search continues from it.
    if (error?.code === 'SUBPROCESS_TIMEOUT') {
      return { pass: name, status: 'budget-reached' };
    }
    return { pass: name, status: 'failed', detail: tail(error?.message) };
  }
}

export async function scanAll({ run = runBoundedSubprocess, log = console.log } = {}) {
  const results = [];

  log('Searching the companies you follow');
  results.push(await pass('tracked', [join(ROOT, 'src/scan/scan.mjs')], {
    timeoutMs: TRACKED_TIMEOUT_MS,
    run,
  }));

  log('Searching every public job board for your keywords');
  results.push(await pass('discovery', [
    join(ROOT, 'src/scan/scan-ats-full.mjs'),
    '--since', String(SWEEP_SINCE_DAYS),
    // Continues the directory sweep where the last search stopped. Harmless on
    // a first run: with no checkpoint it simply starts at the beginning.
    '--resume',
  ], {
    timeoutMs: SWEEP_BUDGET_MS,
    terminationGraceMs: SWEEP_GRACE_MS,
    run,
  }));

  // The search as a whole succeeded if either pass did. Reporting failure
  // because one board family was unreachable would throw away real results and
  // tell the user their search is broken when it is not.
  const succeeded = results.some(r => r.status === 'ok' || r.status === 'budget-reached');
  return { ok: succeeded, passes: results };
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  const summary = await scanAll();
  console.log(JSON.stringify(summary));
  if (!summary.ok) {
    // The reason each pass gave, not a guess. "Check that you are online" is
    // wrong and unactionable when the real cause was missing search settings,
    // and the job layer matches on these details to say something useful.
    for (const failure of summary.passes) {
      if (failure.detail) console.error(`${failure.pass}: ${failure.detail}`);
    }
    console.error('Neither search could run.');
    process.exitCode = 1;
  }
}
