import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';

const SRC = join(ROOT, 'src');
const RAW_MUTATION_RE = /\b(?:writeFileSync|appendFileSync|copyFileSync|renameSync|unlinkSync|rmSync|createWriteStream|truncateSync|cpSync|symlinkSync)\b|\b(?:writeFile|appendFile|copyFile|rename|unlink|rm)\s*\(/u;

// These modules either implement the mutation boundary itself or mutate only
// contained system/runtime/temp state. Every exception is intentionally named:
// adding a raw filesystem mutator anywhere else fails CI.
const APPROVED_RAW_MUTATORS = new Set([
  'src/application/job-manager.mjs', // contained ui/.jobs runtime state
  'src/application/job-storage-cleanup.mjs', // contained ui/.jobs cleanup
  'src/benchmark/pipeline-benchmark.mjs', // maintainer-owned benchmark artifact
  'src/cv/claude-tailor.mjs', // private mkdtemp scratch directory
  'src/cv/generate-latex.mjs', // private mkdtemp compiler directory cleanup
  'src/evaluate/eval-golden.mjs', // private golden-test fixture directory
  'src/evaluate/openai-tailor.mjs', // private mkdtemp scratch directory
  'src/lib/file-lock.mjs', // canonical lock-directory implementation
  'src/lib/locked-file.mjs', // canonical protected mutation implementation
  'src/lib/root-paths.mjs', // explicit maintainer source-rewrite command
  'src/lib/skill-entrypoints.mjs', // versioned system-layer installer
  'src/scan/prefilter.mjs', // guarded legacy two-file rollback transaction
  'src/scan/validate-portals.mjs', // private self-test fixture directory
  'src/tracker/reply-watch.mjs', // private self-test fixture
  'src/tracker/tracker-utils.mjs', // legacy canonical tracker lock implementation
]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')
      ? [path]
      : [];
  });
}

test('production user-data mutations cannot bypass the canonical boundary', () => {
  const observed = sourceFiles(SRC)
    .filter(path => RAW_MUTATION_RE.test(readFileSync(path, 'utf8')))
    .map(path => relative(ROOT, path).split('\\').join('/'))
    .sort();
  assert.deepEqual(
    observed,
    [...APPROVED_RAW_MUTATORS].sort(),
    'raw filesystem mutation changed; route user-state writes through src/lib/locked-file.mjs or document a strictly contained exception',
  );
});
