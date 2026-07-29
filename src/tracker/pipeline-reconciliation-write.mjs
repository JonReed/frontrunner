/**
 * Crash-safe publication boundary for pipeline reconciliation.
 *
 * The caller must hold the canonical pipeline lock across its read, decision
 * and this publication. Keeping the backup and replacement here makes the
 * interruption boundary directly testable without adding test-only behavior
 * to the CLI.
 */

import { replaceFileAtomic } from '../lib/locked-file.mjs';

export function publishPipelineReconciliation({
  pipelineFile,
  currentContent,
  nextContent,
  afterBackup,
} = {}) {
  if (typeof pipelineFile !== 'string' || pipelineFile.length === 0) {
    throw new TypeError('pipelineFile is required');
  }
  if (typeof currentContent !== 'string' || typeof nextContent !== 'string') {
    throw new TypeError('pipeline reconciliation contents must be strings');
  }
  if (currentContent === nextContent) {
    return { changed: false, backupPath: null };
  }

  const backupPath = `${pipelineFile}.pre-reconcile.bak`;
  replaceFileAtomic(backupPath, currentContent, { mode: 0o600 });
  afterBackup?.(backupPath);
  replaceFileAtomic(pipelineFile, nextContent);
  return { changed: true, backupPath };
}
