/**
 * Crash-recoverable publication of one evaluation.
 *
 * A write-ahead journal is persisted before the report or tracker fragment.
 * Replaying that journal is idempotent, so interruption at any stage cannot
 * lose the tracker handoff or reuse the report number for different content.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { ROOT } from '#paths';
import { withFileLock } from '../lib/file-lock.mjs';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { resolveTrackerPath } from '../tracker/tracker-utils.mjs';

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 1_500_000;
const MAX_REPORT_CHARS = 1_000_000;
const MAX_TRACKER_CHARS = 32_000;
const JOURNAL_RE = /^(\d+)-PUBLISHING\.json$/;

function publicationPaths(rootDir, number, slug, date) {
  const num = String(number).padStart(3, '0');
  const filename = `${num}-${slug}-${date}.md`;
  return {
    num,
    filename,
    reportPath: join(rootDir, 'reports', filename),
    trackerPath: join(rootDir, 'batch', 'tracker-additions', `${num}-${slug}.tsv`),
    journalPath: join(rootDir, 'reports', `${num}-PUBLISHING.json`),
  };
}

function validatePublication(value, rootDir, journalPath) {
  if (!value || value.version !== JOURNAL_VERSION) {
    throw new Error(`unsupported evaluation publication journal: ${basename(journalPath)}`);
  }
  const { number, slug, date, report, tracker, mergeTracker } = value;
  if (!Number.isInteger(number) || number < 1 || number > 999_999) {
    throw new Error('publication report number must be a positive integer');
  }
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('publication slug is invalid');
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('publication date is invalid');
  }
  if (typeof report !== 'string' || report.length === 0 || report.length > MAX_REPORT_CHARS) {
    throw new Error('publication report content is invalid');
  }
  if (typeof tracker !== 'string' || tracker.length === 0 || tracker.length > MAX_TRACKER_CHARS) {
    throw new Error('publication tracker content is invalid');
  }
  if (typeof mergeTracker !== 'boolean') {
    throw new Error('publication mergeTracker flag is invalid');
  }
  const paths = publicationPaths(rootDir, number, slug, date);
  if (paths.journalPath !== journalPath) {
    throw new Error(`publication journal filename does not match its report number: ${basename(journalPath)}`);
  }
  return { ...value, ...paths };
}

function readJournal(journalPath, rootDir) {
  const raw = readFileSync(journalPath, 'utf8');
  if (Buffer.byteLength(raw) > MAX_JOURNAL_BYTES) {
    throw new Error(`evaluation publication journal is too large: ${basename(journalPath)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`evaluation publication journal is not valid JSON: ${basename(journalPath)}`);
  }
  return validatePublication(parsed, rootDir, journalPath);
}

function writeExact(filePath, content) {
  if (existsSync(filePath)) {
    if (readFileSync(filePath, 'utf8') !== content) {
      throw new Error(`refusing to replace different publication content: ${filePath}`);
    }
    return;
  }
  replaceFileAtomic(filePath, content, { mode: 0o600 });
}

function trackerContainsPublication(rootDir, publication) {
  const trackerPath = resolveTrackerPath(rootDir);
  if (!existsSync(trackerPath)) return false;
  const tracker = readFileSync(trackerPath, 'utf8');
  return tracker.split(/\r?\n/u).some(line =>
    line.includes(`[${publication.num}](`)
    && line.includes(publication.filename));
}

function mergeTrackerDefault(rootDir) {
  const trackerPath = resolveTrackerPath(rootDir);
  return execFileSync(process.execPath, [join(rootDir, 'src', 'tracker', 'merge-tracker.mjs')], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FRONTRUNNER_TRACKER: trackerPath,
      FRONTRUNNER_ADDITIONS: join(rootDir, 'batch', 'tracker-additions'),
    },
  });
}

async function replayJournal(journalPath, {
  rootDir,
  mergeTrackerFn = mergeTrackerDefault,
  afterStage,
} = {}) {
  return withFileLock(journalPath, async () => {
    if (!existsSync(journalPath)) return null;
    const publication = readJournal(journalPath, rootDir);

    writeExact(publication.reportPath, publication.report);
    await afterStage?.('report', publication);

    if (publication.mergeTracker && trackerContainsPublication(rootDir, publication)) {
      // The previous process completed the merge and died before journal
      // cleanup. Never recreate an already-consumed tracker fragment.
    } else {
      writeExact(publication.trackerPath, publication.tracker);
      await afterStage?.('tracker', publication);
      if (publication.mergeTracker) {
        await mergeTrackerFn(rootDir, publication);
        await afterStage?.('merge', publication);
        if (!trackerContainsPublication(rootDir, publication)) {
          throw new Error(`tracker merge did not publish report ${publication.num}`);
        }
      }
    }

    unlinkSync(journalPath);
    await afterStage?.('complete', publication);
    return publication;
  });
}

export async function publishEvaluationArtifacts({
  number,
  slug,
  date,
  report,
  tracker,
  mergeTracker = true,
  rootDir = ROOT,
}, options = {}) {
  const paths = publicationPaths(rootDir, number, slug, date);
  const publication = validatePublication({
    version: JOURNAL_VERSION,
    number,
    slug,
    date,
    report,
    tracker,
    mergeTracker,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
  }, rootDir, paths.journalPath);

  await withFileLock(paths.journalPath, async () => {
    if (existsSync(paths.journalPath)) {
      throw new Error(`evaluation publication already pending: ${basename(paths.journalPath)}`);
    }
    replaceFileAtomic(
      paths.journalPath,
      `${JSON.stringify(publication, [
        'version', 'number', 'slug', 'date', 'report', 'tracker',
        'mergeTracker', 'createdAt', 'ownerPid',
      ], 2)}\n`,
      { mode: 0o600 },
    );
  });
  await options.afterStage?.('journal', publication);
  return replayJournal(paths.journalPath, {
    rootDir,
    mergeTrackerFn: options.mergeTrackerFn,
    afterStage: options.afterStage,
  });
}

export async function recoverEvaluationPublications({
  rootDir = ROOT,
  mergeTrackerFn,
  afterStage,
} = {}) {
  const reportsDir = join(rootDir, 'reports');
  if (!existsSync(reportsDir)) return [];
  const journals = readdirSync(reportsDir)
    .filter(name => JOURNAL_RE.test(name))
    .sort((left, right) => Number(left.match(JOURNAL_RE)[1]) - Number(right.match(JOURNAL_RE)[1]));
  const recovered = [];
  for (const name of journals) {
    const result = await replayJournal(join(reportsDir, name), {
      rootDir,
      mergeTrackerFn,
      afterStage,
    });
    if (result) recovered.push(result);
  }
  return recovered;
}
