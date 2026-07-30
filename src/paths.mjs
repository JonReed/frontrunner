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
 *     import { ROOT, WORKSPACE_DIR } from '#paths';
 *
 * Do not add `../` to anything here. If a path is needed, name it here once.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root. This file lives at <root>/src/, so up one level. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Product-named alias for modules where it makes call sites clearer. */
export const FRONTRUNNER = ROOT;

// -- Private workspace (never tracked or auto-updated; see DATA_CONTRACT.md) --
//
// The repository root is product source. Everything written by or about one
// user belongs below this single boundary. No placeholder is tracked inside
// WORKSPACE_DIR, so a fresh clone is genuinely empty before onboarding.
export const WORKSPACE_DIR = join(ROOT, 'workspace');
export const PROFILE_DIR = join(WORKSPACE_DIR, 'profile');
export const SEARCH_DIR = join(WORKSPACE_DIR, 'search');
export const APPLICATIONS_DIR = join(WORKSPACE_DIR, 'applications');
export const STATE_DIR = join(WORKSPACE_DIR, '.state');
export const REPORTS_DIR = join(WORKSPACE_DIR, 'reports', 'evaluations');
export const ANALYSIS_REPORTS_DIR = join(WORKSPACE_DIR, 'reports', 'analysis');
export const OUTPUT_DIR = join(WORKSPACE_DIR, 'documents');
export const APPLICATION_DOCUMENTS_DIR = join(OUTPUT_DIR, 'applications');
export const JDS_DIR = join(WORKSPACE_DIR, 'jobs', 'descriptions');
export const INTERVIEW_PREP_DIR = join(WORKSPACE_DIR, 'interviews');
export const CV_VERSIONS_DIR = join(PROFILE_DIR, 'cv-versions');
export const WRITING_SAMPLES_DIR = join(PROFILE_DIR, 'writing-samples');
export const CONFIG_DIR = join(ROOT, 'config');

export const CV_FILE = join(PROFILE_DIR, 'cv.md');
export const PROFILE_FILE = join(PROFILE_DIR, 'profile.yml');
export const TARGETING_FILE = join(PROFILE_DIR, 'targeting.md');
export const PREFERENCES_FILE = join(PROFILE_DIR, 'preferences.md');
export const ARTICLE_DIGEST_FILE = join(PROFILE_DIR, 'article-digest.md');
export const VOICE_DNA_FILE = join(PROFILE_DIR, 'voice-dna.md');
export const PORTALS_FILE = join(SEARCH_DIR, 'portals.yml');
export const PREFILTER_CONFIG_FILE = join(SEARCH_DIR, 'prefilter.yml');
export const PIPELINE_FILE = join(SEARCH_DIR, 'pipeline.md');
export const BLACKLIST_FILE = join(SEARCH_DIR, 'blacklist.md');
export const APPLICATIONS_FILE = join(APPLICATIONS_DIR, 'tracker.md');
export const FOLLOWUPS_FILE = join(APPLICATIONS_DIR, 'follow-ups.md');
export const ACTIVE_INTERVIEWS_FILE = join(APPLICATIONS_DIR, 'active-interviews.md');
export const REPLY_CANDIDATES_FILE = join(APPLICATIONS_DIR, 'reply-candidates.json');
export const SALARY_OBSERVATIONS_FILE = join(APPLICATIONS_DIR, 'salary-observations.tsv');
export const ASSESSMENTS_FILE = join(APPLICATIONS_DIR, 'assessments.tsv');
export const SCAN_HISTORY_FILE = join(STATE_DIR, 'scan-history.tsv');
export const SCAN_RUNS_FILE = join(STATE_DIR, 'scan-runs.tsv');
export const PORTAL_HEALTH_FILE = join(STATE_DIR, 'portal-health.tsv');
export const PDF_INDEX_FILE = join(STATE_DIR, 'pdf-index.tsv');
export const STATUS_LOG_FILE = join(APPLICATIONS_DIR, 'status-log.tsv');
export const RUN_HISTORY_FILE = join(STATE_DIR, 'run-history.ndjson');

/**
 * @deprecated New code must import a semantic path above. Kept temporarily so
 * inherited modules fail into the private boundary rather than the repo root.
 */
export const DATA_DIR = STATE_DIR;

// -- System layer ------------------------------------------------------------
export const SRC_DIR = join(ROOT, 'src');
export const MODES_DIR = join(ROOT, 'modes');
export const TEMPLATES_DIR = join(ROOT, 'templates');
export const PROVIDERS_DIR = join(ROOT, 'providers');
export const BATCH_DIR = join(ROOT, 'batch');
