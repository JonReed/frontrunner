/**
 * Conservative cleanup for private application-job crash debris.
 *
 * Only exact, code-owned artifact names are candidates. A complete artifact
 * family is removed together under the job-state lock, and only when every
 * member is an old regular file and no valid job state exists. Symlinks,
 * directories, lookalike names and young files are left untouched.
 */

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { withFileLock } from '../lib/file-lock.mjs';

export const APPLICATION_JOB_ID_RE =
  /^(?:cv-\d+|job-(?:pipeline|prepare|scan))-[a-z0-9]+$/u;
export const DEFAULT_ORPHAN_ARTIFACT_RETENTION_MS = 24 * 60 * 60_000;

const ARTIFACT_SUFFIXES = Object.freeze([
  '.json',
  '.log',
  '.cancel',
  '.progress.json',
]);
const ATOMIC_TEMP_RE =
  /^\.(.+)\.(\d+)\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;

function artifactId(name) {
  for (const suffix of [...ARTIFACT_SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (!name.endsWith(suffix)) continue;
    const id = name.slice(0, -suffix.length);
    return APPLICATION_JOB_ID_RE.test(id) ? id : null;
  }
  return null;
}

function oldRegularFile(path, now, retentionMs) {
  try {
    const stat = lstatSync(path);
    return stat.isFile()
      && !stat.isSymbolicLink()
      && now - stat.mtimeMs > retentionMs;
  } catch {
    return false;
  }
}

function atomicTempArtifact(name) {
  const match = ATOMIC_TEMP_RE.exec(name);
  return match && artifactId(match[1]) ? match[1] : null;
}

export async function cleanupOrphanJobArtifacts({
  jobsDir,
  now,
  retentionMs = DEFAULT_ORPHAN_ARTIFACT_RETENTION_MS,
  readValidJob,
  lock = withFileLock,
}) {
  const names = readdirSync(jobsDir);
  const ids = new Set(names.map(artifactId).filter(Boolean));
  let artifactsRemoved = 0;

  for (const id of ids) {
    const statePath = join(jobsDir, `${id}.json`);
    await lock(statePath, async () => {
      if (readValidJob(id)) return;
      const paths = ARTIFACT_SUFFIXES
        .map(suffix => join(jobsDir, `${id}${suffix}`))
        .filter(path => {
          try {
            lstatSync(path);
            return true;
          } catch {
            return false;
          }
        });
      if (paths.length === 0) return;
      if (!paths.every(path => oldRegularFile(path, now, retentionMs))) return;
      for (const path of paths) {
        rmSync(path, { force: true });
        artifactsRemoved++;
      }
    });
  }

  // Atomic replacement debris has no live reader and is never a durable job
  // artifact. Strict basename/UUID matching prevents broad ".tmp" cleanup.
  for (const name of names) {
    if (!atomicTempArtifact(name)) continue;
    const path = join(jobsDir, name);
    if (!oldRegularFile(path, now, retentionMs)) continue;
    rmSync(path, { force: true });
    artifactsRemoved++;
  }

  return artifactsRemoved;
}
