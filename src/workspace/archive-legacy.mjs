#!/usr/bin/env node

/**
 * Archive the pre-workspace user layer without importing it into the new
 * installation. This is intentionally an archive, not a compatibility layer:
 * fresh onboarding owns the active workspace and old code never reads backup.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { replaceFileAtomic } from '../lib/locked-file.mjs';

export const LEGACY_PRIVATE_PATHS = Object.freeze([
  'cv.md',
  'article-digest.md',
  'voice-dna.md',
  'portals.yml',
  'config/profile.yml',
  'config/prefilter.yml',
  'config/cv-facts.json',
  'config/benchmarks.yml',
  'modes/_profile.md',
  'modes/_custom.md',
  'data',
  'reports',
  'output',
  'jds',
  'interview-prep',
  'writing-samples',
  'cv-versions',
  '.frontrunner-web',
  'ui/.jobs',
  'batch/logs',
  'batch/tracker-additions',
  'batch/batch-state.tsv',
  'batch/batch-input.tsv',
  'batch/batch-input.filtered.tsv',
  'batch/prefilter-rejects.tsv',
  'batch/liveness-results.tsv',
  'batch/liveness-active.tsv',
  'batch/.pipeline-run.lock',
  'batch/.pipeline-run.lock.recover',
]);

function portable(value) {
  return value.split(sep).join('/');
}

function assertInstallationRoot(root) {
  const absolute = resolve(root);
  if (
    !isAbsolute(absolute)
    || !existsSync(join(absolute, 'package.json'))
    || !existsSync(join(absolute, 'src', 'paths.mjs'))
  ) {
    throw new Error('archive target is not a Frontrunner installation');
  }
  return absolute;
}

function archiveId(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

export function planLegacyArchive({ root = ROOT, id = archiveId() } = {}) {
  const installation = assertInstallationRoot(root);
  const backupRoot = join(installation, 'workspace', '.legacy-backup', id);
  const entries = LEGACY_PRIVATE_PATHS
    .map(source => ({
      source,
      sourcePath: join(installation, ...source.split('/')),
      destinationPath: join(backupRoot, ...source.split('/')),
    }))
    .filter(entry => existsSync(entry.sourcePath))
    .map(entry => {
      const stat = lstatSync(entry.sourcePath);
      return {
        ...entry,
        kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
      };
    });
  return { installation, backupRoot, entries };
}

export function applyLegacyArchive(options = {}) {
  const plan = planLegacyArchive(options);
  if (plan.entries.length === 0) return { ...plan, moved: [], manifestPath: null };
  if (existsSync(plan.backupRoot)) {
    throw new Error(`legacy backup destination already exists: ${plan.backupRoot}`);
  }

  mkdirSync(plan.backupRoot, { recursive: true, mode: 0o700 });
  const manifestPath = join(plan.backupRoot, 'manifest.json');
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    installation: plan.installation,
    status: 'moving',
    entries: plan.entries.map(entry => ({
      source: entry.source,
      kind: entry.kind,
      destination: portable(relative(plan.installation, entry.destinationPath)),
      moved: false,
    })),
  };
  replaceFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const moved = [];
  try {
    for (let index = 0; index < plan.entries.length; index++) {
      const entry = plan.entries[index];
      if (existsSync(entry.destinationPath)) {
        throw new Error(`legacy archive destination already exists: ${entry.destinationPath}`);
      }
      mkdirSync(dirname(entry.destinationPath), { recursive: true, mode: 0o700 });
      renameSync(entry.sourcePath, entry.destinationPath);
      moved.push(entry.source);
      manifest.entries[index].moved = true;
      replaceFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    }
    manifest.status = 'complete';
    replaceFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { ...plan, moved, manifestPath };
  } catch (error) {
    manifest.status = 'interrupted';
    manifest.error = String(error?.message ?? error).slice(0, 500);
    replaceFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    throw error;
  }
}

function usage() {
  return `Usage: node src/workspace/archive-legacy.mjs [--apply]

Without --apply, prints the exact legacy private paths that would be moved.
--apply moves them under workspace/.legacy-backup/<timestamp>/ and writes a
manifest. Nothing is copied into the active onboarding workspace.`;
}

async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg.startsWith('-') && arg !== '--apply' && arg !== '--help')) {
    throw new Error('unknown option');
  }
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }
  const applying = args.includes('--apply');
  const result = applying ? applyLegacyArchive() : planLegacyArchive();
  console.log(JSON.stringify({
    mode: applying ? 'apply' : 'preview',
    backup: portable(relative(result.installation, result.backupRoot)),
    paths: applying ? result.moved : result.entries.map(entry => entry.source),
    manifest: result.manifestPath
      ? portable(relative(result.installation, result.manifestPath))
      : null,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(`archive-legacy: ${error.message}`);
    process.exitCode = 1;
  });
}
