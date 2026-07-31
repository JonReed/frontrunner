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
  /*
    The cover letter, drafted the same way and from the same cached
    description. A separate operation rather than a flag on cv.build so the two
    dedupe independently: someone who has already built a CV for a role must be
    able to add a letter without the request being folded into the finished
    build.
  */
  'cover.build': Object.freeze({
    timeoutMs: 5 * 60_000,
    costsTokens: true,
    build(input) {
      return [
        join(ROOT, 'src/cv/claude-cover.mjs'),
        '--url', input.jobUrl,
        '--tracker', String(input.roleNum),
        ...(input.reportPath ? ['--report', input.reportPath] : []),
        ...(input.model ? ['--model', input.model] : []),
      ];
    },
    dedupe(input) {
      return `cover.build:tracker:${input.roleNum}`;
    },
  }),
  'pipeline.run': Object.freeze({
    resourceKey: 'pipeline-state',
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
    resourceKey: 'pipeline-state',
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
    resourceKey: 'pipeline-state',
    timeoutMs: 15 * 60_000,
    costsTokens() {
      return false;
    },
    build() {
      // Both scan passes, not just the tracked-company one. See scan-all.mjs:
      // searching only the curated list made that list the foundation of the
      // product, which is wrong for anyone who has not built one yet.
      return [join(ROOT, 'src/scan/scan-all.mjs')];
    },
    dedupe() {
      return 'scan.run';
    },
  }),
  /*
    Turn company names into job boards this installation can actually read.

    Zero tokens: the resolver probes the public Greenhouse, Lever, Ashby and
    Workday APIs and keeps a board only when it exists and currently lists a
    job. That matters for where this runs — it is offered during setup, when
    the Claude CLI is usually not yet signed in, so anything model-backed would
    simply fail for most new installations.

    The names reach argv, so the contract anchors each one on a letter or digit:
    a company called "--write" is not a company. Nothing else about the command
    comes from the request.
  */
  'companies.discover': Object.freeze({
    timeoutMs: 5 * 60_000,
    costsTokens() {
      return false;
    },
    build(input) {
      return [
        join(ROOT, 'src/scan/discover-ats.mjs'),
        ...input.names,
        '--write',
        '--summary',
      ];
    },
    dedupe() {
      return 'companies.discover';
    },
  }),
  /*
    Ask the model which employers this CV suits. Spends allowance, so it is
    deduped like any other model operation — and it only ever produces a
    shortlist on disk. Following a suggestion is a separate act by the user,
    resolved through the zero-token discovery above.
  */
  'companies.suggest': Object.freeze({
    timeoutMs: 5 * 60_000,
    costsTokens: true,
    build(input) {
      return [
        join(ROOT, 'src/cv/claude-companies.mjs'),
        ...(input.model ? ['--model', input.model] : []),
      ];
    },
    dedupe() {
      return 'companies.suggest';
    },
  }),
});

export function applicationOperationResourceKey(operation, dedupeKey) {
  return DEFINITIONS[operation]?.resourceKey ?? dedupeKey;
}

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
    resourceKey: applicationOperationResourceKey(
      normalized.operation,
      definition.dedupe(normalized.input),
    ),
  });
}
