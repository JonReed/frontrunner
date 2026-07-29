// @ts-check
/**
 * paths.mjs — the single source of truth for where things live.
 *
 * WHY THIS EXISTS
 * ---------------
 * 61 of the 99 root scripts each contained their own copy of:
 *
 *     const ROOT = dirname(fileURLToPath(import.meta.url));
 *
 * which is correct only while the file sits in the repository root. That one
 * duplicated assumption is what made reorganising the tree expensive: moving a
 * file silently broke every path it resolved, and there were 61 places to fix.
 *
 * Every module now imports from here instead, via the `#paths` subpath declared
 * in package.json. Subpath imports resolve from the package root rather than
 * relative to the importing file, so a module can be moved anywhere in the tree
 * without touching a single import. The next reorganisation is free.
 *
 *     import { ROOT, DATA_DIR } from '#paths';
 *
 * Do not add `../` to anything here. If a path is needed, name it here once.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. This file lives at <root>/src/, so up one level. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Product-named alias for modules where it makes call sites clearer. */
export const FRONTRUNNER = ROOT;

// -- User layer (never auto-updated; see DATA_CONTRACT.md) -------------------
export const DATA_DIR = join(ROOT, 'data');
export const REPORTS_DIR = join(ROOT, 'reports');
export const OUTPUT_DIR = join(ROOT, 'output');
export const JDS_DIR = join(ROOT, 'jds');
export const INTERVIEW_PREP_DIR = join(ROOT, 'interview-prep');
export const CONFIG_DIR = join(ROOT, 'config');

export const CV_FILE = join(ROOT, 'cv.md');
export const PROFILE_FILE = join(CONFIG_DIR, 'profile.yml');
export const PORTALS_FILE = join(ROOT, 'portals.yml');
export const APPLICATIONS_FILE = join(DATA_DIR, 'applications.md');
export const PIPELINE_FILE = join(DATA_DIR, 'pipeline.md');

// -- System layer ------------------------------------------------------------
export const SRC_DIR = join(ROOT, 'src');
export const MODES_DIR = join(ROOT, 'modes');
export const TEMPLATES_DIR = join(ROOT, 'templates');
export const PROVIDERS_DIR = join(ROOT, 'providers');
export const BATCH_DIR = join(ROOT, 'batch');
