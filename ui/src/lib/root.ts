import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

const configured = process.env.FRONTRUNNER_ROOT;

if (!configured || !isAbsolute(configured)) {
  throw new Error('Frontrunner UI must be started through the canonical npm run ui command.');
}

const candidate = realpathSync(resolve(configured));
if (
  !existsSync(resolve(candidate, 'package.json'))
  || !existsSync(resolve(candidate, 'src', 'application'))
) {
  throw new Error('FRONTRUNNER_ROOT does not identify a Frontrunner installation.');
}

/** Repository root injected by src/application/ui-launch.mjs. */
export const ROOT = candidate;

/** UI mirror of src/paths.mjs. Private paths are never assembled in routes. */
export const WORKSPACE = Object.freeze({
  root: join(ROOT, 'workspace'),
  profile: join(ROOT, 'workspace', 'profile'),
  cv: join(ROOT, 'workspace', 'profile', 'cv.md'),
  profileFile: join(ROOT, 'workspace', 'profile', 'profile.yml'),
  search: join(ROOT, 'workspace', 'search'),
  pipeline: join(ROOT, 'workspace', 'search', 'pipeline.md'),
  tracker: join(ROOT, 'workspace', 'applications', 'tracker.md'),
  reports: join(ROOT, 'workspace', 'reports', 'evaluations'),
  documents: join(ROOT, 'workspace', 'documents'),
  state: join(ROOT, 'workspace', '.state'),
  pdfIndex: join(ROOT, 'workspace', '.state', 'pdf-index.tsv'),
  rejects: join(ROOT, 'workspace', '.state', 'prefilter-rejects.tsv'),
  prefilterOverrides: join(ROOT, 'workspace', 'search', 'prefilter-overrides.tsv'),
});
