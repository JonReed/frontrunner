#!/usr/bin/env node

/**
 * Application-scoped document bundles under workspace/documents/applications.
 *
 * The CLI can only resolve or initialize canonical paths. It accepts no root
 * override and writes no caller-supplied document content.
 */

import { existsSync, lstatSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  APPLICATION_DOCUMENTS_DIR,
  WORKSPACE_DIR,
} from '#paths';
import {
  ensureDirectoryProtected,
  replaceFileAtomic,
} from '../lib/locked-file.mjs';
import { withFileLock } from '../lib/file-lock.mjs';
import { testProcessActive } from '../lib/test-user-data-policy.mjs';

const DECISIONS = new Set(['reuse', 'reuse-with-edits', 'regenerate']);
const MAX_LABEL_LENGTH = 160;
const MAX_CHANGED_SECTIONS = 32;
const MAX_SECTION_LENGTH = 120;

export function slugifyArtifactSegment(value, fallback = 'application') {
  const text = String(value ?? '').trim();
  if (text.length > MAX_LABEL_LENGTH) {
    throw new RangeError(`artifact label must not exceed ${MAX_LABEL_LENGTH} characters`);
  }
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function artifactRoot(options) {
  if (options.outputRoot === undefined) return APPLICATION_DOCUMENTS_DIR;
  if (!testProcessActive()) {
    throw new Error('application artifact root overrides are test-only');
  }
  return resolve(options.outputRoot);
}

function assertNoSymlinkComponents(base, target) {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  const local = relative(resolvedBase, resolvedTarget);
  if (local === '..' || local.startsWith(`..${sep}`)) {
    throw new Error('application artifact path escaped its canonical root');
  }
  const components = local ? local.split(sep) : [];
  let cursor = resolvedBase;
  for (const component of ['', ...components]) {
    if (component) cursor = resolve(cursor, component);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`application artifact path contains a symbolic link: ${cursor}`);
    }
  }
}

export function applicationArtifactPaths(input, options = {}) {
  const report = String(input?.reportNum ?? '');
  const version = String(input?.version ?? 1);
  if (!/^\d{1,9}$/.test(report)) {
    throw new TypeError('reportNum must be a numeric report number');
  }
  if (Number(report) < 1) {
    throw new TypeError('reportNum must be a positive report number');
  }
  if (!/^\d{1,6}$/.test(version) || Number(version) < 1) {
    throw new TypeError('version must be a positive integer');
  }

  if (typeof input?.company !== 'string' || input.company.trim() === '') {
    throw new TypeError('company must be a non-empty string');
  }
  if (typeof input?.role !== 'string' || input.role.trim() === '') {
    throw new TypeError('role must be a non-empty string');
  }
  const key = `${report.padStart(3, '0')}-${
    slugifyArtifactSegment(input.company, 'company')
  }-${slugifyArtifactSegment(input.role, 'role')}`;
  const root = resolve(artifactRoot(options), key);
  const tailoredRoot = resolve(root, 'cv', 'tailored', `v${version.padStart(3, '0')}`);
  return {
    key,
    root,
    jd: {
      current: resolve(root, 'jd', 'current.md'),
      previous: resolve(root, 'jd', 'previous.md'),
    },
    cv: {
      source: {
        html: resolve(root, 'cv', 'source', 'original.html'),
        pdf: resolve(root, 'cv', 'source', 'original.pdf'),
      },
      tailored: {
        root: tailoredRoot,
        html: resolve(tailoredRoot, 'cv.html'),
        pdf: resolve(tailoredRoot, 'cv.pdf'),
        changes: resolve(tailoredRoot, 'changes.md'),
      },
    },
    decision: {
      reuse: resolve(root, 'decision', 'reuse.json'),
    },
  };
}

function ensureApplicationArtifactDirs(paths) {
  for (const directory of [
    resolve(paths.root, 'jd'),
    resolve(paths.root, 'cv', 'source'),
    paths.cv.tailored.root,
    resolve(paths.root, 'decision'),
  ]) {
    ensureDirectoryProtected(directory);
  }
  return paths;
}

export function initializeApplicationArtifacts(application, options = {}) {
  const paths = applicationArtifactPaths(application, options);
  const boundary = options.outputRoot === undefined ? WORKSPACE_DIR : artifactRoot(options);
  assertNoSymlinkComponents(boundary, paths.root);
  const initialized = ensureApplicationArtifactDirs(paths);
  assertNoSymlinkComponents(boundary, paths.root);
  return initialized;
}

export async function recordReuseDecision(application, input, options = {}) {
  if (!DECISIONS.has(input?.decision)) {
    throw new TypeError(`decision must be one of: ${[...DECISIONS].join(', ')}`);
  }
  if (input.score !== null && input.score !== undefined) {
    if (!Number.isFinite(input.score) || input.score < 0 || input.score > 1) {
      throw new TypeError('score must be null or a number between 0 and 1');
    }
  }
  const changedSections = input.changedSections ?? [];
  if (!Array.isArray(changedSections) || changedSections.length > MAX_CHANGED_SECTIONS) {
    throw new TypeError(`changedSections must contain at most ${MAX_CHANGED_SECTIONS} entries`);
  }
  const normalizedSections = changedSections.map(section => {
    if (typeof section !== 'string') {
      throw new TypeError('changed section names must be strings');
    }
    const value = section.trim();
    if (!value || value.length > MAX_SECTION_LENGTH) {
      throw new TypeError(`changed section names must be 1-${MAX_SECTION_LENGTH} characters`);
    }
    return value;
  });
  if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
    throw new TypeError('reason must be a string or null');
  }
  if (
    input.userOverride !== undefined
    && input.userOverride !== null
    && typeof input.userOverride !== 'boolean'
  ) {
    throw new TypeError('userOverride must be a boolean');
  }

  const record = {
    schema_version: 1,
    decision: input.decision,
    score: input.score ?? null,
    reason: input.reason?.trim().slice(0, 120) || null,
    changed_sections: normalizedSections,
    user_override: Boolean(input.userOverride),
    recorded_at: (options.now ?? (() => new Date()))().toISOString(),
  };
  const paths = initializeApplicationArtifacts(application, options);
  const boundary = options.outputRoot === undefined ? WORKSPACE_DIR : artifactRoot(options);
  assertNoSymlinkComponents(boundary, dirname(paths.decision.reuse));
  await withFileLock(paths.decision.reuse, () => {
    assertNoSymlinkComponents(boundary, dirname(paths.decision.reuse));
    replaceFileAtomic(paths.decision.reuse, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  }, options.lockOptions);
  return record;
}

function usage() {
  return 'Usage: node src/cv/application-artifacts.mjs --report N --company NAME --role ROLE [--version N] [--init]';
}

async function main() {
  const { values } = parseArgs({
    options: {
      report: { type: 'string' },
      company: { type: 'string' },
      role: { type: 'string' },
      version: { type: 'string', default: '1' },
      init: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (!values.report || !values.company || !values.role) {
    throw new Error(usage());
  }
  const paths = applicationArtifactPaths({
    reportNum: values.report,
    company: values.company,
    role: values.role,
    version: values.version,
  });
  if (values.init) initializeApplicationArtifacts({
    reportNum: values.report,
    company: values.company,
    role: values.role,
    version: values.version,
  });
  console.log(JSON.stringify(paths, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`application-artifacts: ${error.message}`);
    process.exitCode = 1;
  });
}
