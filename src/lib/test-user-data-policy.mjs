/**
 * Fail-closed protection for real user data while a test process is active.
 *
 * Tests may write freely inside temporary fixtures. They may never write the
 * checkout's user layer, even when a missing or renamed fixture override makes
 * production code fall back to ROOT.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import { ROOT } from '#paths';

const USER_FILES = new Set([
  'cv.md',
  'article-digest.md',
  'portals.yml',
  'voice-dna.md',
]);
const USER_DIRECTORIES = new Set([
  'workspace',
  'cv-versions',
  'data',
  'interview-prep',
  'jds',
  'output',
  'reports',
  'writing-samples',
]);
const USER_CONFIG_FILES = new Set([
  'config/profile.yml',
  'workspace/profile/preferences.md',
  'workspace/profile/targeting.md',
]);

export function testProcessActive() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT
    || process.env.FRONTRUNNER_TEST_PROTECTED_ROOT,
  );
}

export function isRealUserDataPath(file, root = ROOT) {
  if (typeof file !== 'string' || !file) return false;
  const absolute = isAbsolute(file) ? resolve(file) : resolve(process.cwd(), file);
  const local = relative(resolve(root), absolute);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    return false;
  }
  const portable = local.split(sep).join('/');
  if (USER_FILES.has(portable) || USER_CONFIG_FILES.has(portable)) return true;
  return USER_DIRECTORIES.has(portable.split('/')[0]);
}

export function assertTestUserDataWriteAllowed(file, options = {}) {
  if (!testProcessActive()) return;
  const root = options.root ?? process.env.FRONTRUNNER_TEST_PROTECTED_ROOT ?? ROOT;
  if (!isRealUserDataPath(file, root)) return;
  const error = new Error(
    `test process refused to write real user data: ${relative(resolve(root), resolve(file))}`,
  );
  error.code = 'TEST_USER_DATA_WRITE_BLOCKED';
  throw error;
}
