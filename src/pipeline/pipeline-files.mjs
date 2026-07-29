/**
 * Canonical publisher for pipeline working files and inbox outcomes.
 *
 * Pipeline locking belongs to the caller because some files are private to one
 * leased run while data/pipeline.md uses its shared transaction lock. This
 * boundary owns durable atomic replacement and protected-test enforcement.
 */

import { replaceFileAtomic } from '../lib/locked-file.mjs';

export function publishPipelineFile(file, contents, options = {}) {
  replaceFileAtomic(file, contents, options);
}
