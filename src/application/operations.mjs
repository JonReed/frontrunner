/**
 * Fixed mapping from application operations to backend process specifications.
 *
 * No request field ever becomes an executable, script path, working directory,
 * environment-variable name, or free-form flag.
 */

import { join } from 'node:path';

import { ROOT } from '#paths';
import { validateApplicationRequest } from './contract.mjs';

const DEFINITIONS = Object.freeze({
  'cv.build': Object.freeze({
    timeoutMs: 5 * 60_000,
    costsTokens: true,
    build(input) {
      return [
        join(ROOT, 'src/cv/claude-tailor.mjs'),
        '--url', input.jobUrl,
        '--tracker', String(input.roleNum),
        ...(input.reportPath ? ['--report', input.reportPath] : []),
        ...(input.model ? ['--model', input.model] : []),
      ];
    },
    dedupe(input) {
      return `cv.build:tracker:${input.roleNum}`;
    },
  }),
  'pipeline.run': Object.freeze({
    timeoutMs: 30 * 60_000,
    costsTokens(input) {
      return input.engine !== 'none';
    },
    build(input) {
      return [
        join(ROOT, 'src/pipeline/run.mjs'),
        '--input', input.input,
        '--engine', input.engine,
        ...(input.scan ? [] : ['--skip-scan']),
        '--json',
      ];
    },
    dedupe() {
      return 'pipeline.run';
    },
  }),
  'pipeline.prepare': Object.freeze({
    timeoutMs: 20 * 60_000,
    costsTokens() {
      return false;
    },
    build(input) {
      return [
        join(ROOT, 'src/pipeline/run.mjs'),
        '--input', input.input,
        '--prepare-only',
        ...(input.scan ? [] : ['--skip-scan']),
        '--json',
      ];
    },
    dedupe() {
      return 'pipeline.prepare';
    },
  }),
  'scan.run': Object.freeze({
    timeoutMs: 15 * 60_000,
    costsTokens() {
      return false;
    },
    build() {
      return [join(ROOT, 'src/scan/scan.mjs'), '--json'];
    },
    dedupe() {
      return 'scan.run';
    },
  }),
});

export function resolveApplicationOperation(request) {
  const normalized = validateApplicationRequest(request);
  const definition = DEFINITIONS[normalized.operation];
  const [script, ...args] = definition.build(normalized.input);
  return Object.freeze({
    request: normalized,
    command: process.execPath,
    args: Object.freeze([script, ...args]),
    cwd: ROOT,
    timeoutMs: definition.timeoutMs,
    costsTokens: typeof definition.costsTokens === 'function'
      ? definition.costsTokens(normalized.input)
      : definition.costsTokens,
    dedupeKey: normalized.idempotencyKey ?? definition.dedupe(normalized.input),
  });
}
