import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { RE2JS } from 're2js';

import { ROOT } from '#paths';

export const PREFILTER_CONFIG_LIMITS = Object.freeze({
  maxPatternsPerGroup: 100,
  maxPatternsPerBlocker: 20,
  maxTotalPatterns: 500,
  maxPatternChars: 500,
  maxBlockers: 50,
  maxReasonChars: 500,
});

const TOP_LEVEL_KEYS = new Set([
  'keep_signals',
  'ic_families',
  'wrong_functions',
  'below_level',
  'hard_blockers',
  'comp',
]);
const BLOCKER_KEYS = new Set(['id', 'enabled', 'all', 'reason']);
const COMP_KEYS = new Set(['enabled', 'clearance_margin']);

export class PrefilterConfigError extends Error {
  constructor(source, message) {
    super(`prefilter config ${source}: ${message}`);
    this.name = 'PrefilterConfigError';
    this.source = source;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label, source) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new PrefilterConfigError(source, `${label} contains unknown key "${unknown[0]}"`);
  }
}

function compilePattern(value, label, source) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PrefilterConfigError(source, `${label} must be a non-empty regex string`);
  }
  if (value.length > PREFILTER_CONFIG_LIMITS.maxPatternChars) {
    throw new PrefilterConfigError(
      source,
      `${label} exceeds ${PREFILTER_CONFIG_LIMITS.maxPatternChars} characters`,
    );
  }
  try {
    // Job descriptions are hostile input. RE2JS executes the supported regex
    // subset in linear time, so a crafted advertisement cannot trigger the
    // catastrophic backtracking possible in JavaScript's native RegExp.
    return RE2JS.compile(value, RE2JS.CASE_INSENSITIVE);
  } catch (error) {
    throw new PrefilterConfigError(
      source,
      `${label} is not valid linear-time regex syntax: ${error.message}`,
    );
  }
}

function compileList(
  value,
  label,
  source,
  { allowEmpty = true, maxPatterns = PREFILTER_CONFIG_LIMITS.maxPatternsPerGroup } = {},
) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new PrefilterConfigError(source, `${label} must be an array`);
  }
  if (value.length > maxPatterns) {
    throw new PrefilterConfigError(
      source,
      `${label} has more than ${maxPatterns} patterns`,
    );
  }
  if (!allowEmpty && value.length === 0) {
    throw new PrefilterConfigError(source, `${label} must contain at least one pattern`);
  }
  return value.map((pattern, index) => compilePattern(pattern, `${label}[${index}]`, source));
}

export function compilePrefilterConfig(rawConfig, { source = '<memory>' } = {}) {
  const config = rawConfig ?? {};
  if (!isRecord(config)) {
    throw new PrefilterConfigError(source, 'top level must be a mapping');
  }
  rejectUnknownKeys(config, TOP_LEVEL_KEYS, 'top level', source);

  const blockers = config.hard_blockers ?? [];
  if (!Array.isArray(blockers)) {
    throw new PrefilterConfigError(source, 'hard_blockers must be an array');
  }
  if (blockers.length > PREFILTER_CONFIG_LIMITS.maxBlockers) {
    throw new PrefilterConfigError(
      source,
      `hard_blockers has more than ${PREFILTER_CONFIG_LIMITS.maxBlockers} entries`,
    );
  }

  const blockerIds = new Set();
  let blockerPatternCount = 0;
  const compiledBlockers = blockers.map((blocker, index) => {
    const label = `hard_blockers[${index}]`;
    if (!isRecord(blocker)) {
      throw new PrefilterConfigError(source, `${label} must be a mapping`);
    }
    rejectUnknownKeys(blocker, BLOCKER_KEYS, label, source);
    if (blocker.enabled != null && typeof blocker.enabled !== 'boolean') {
      throw new PrefilterConfigError(source, `${label}.enabled must be true or false`);
    }
    if (typeof blocker.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(blocker.id)) {
      throw new PrefilterConfigError(source, `${label}.id must be a lowercase identifier`);
    }
    if (blockerIds.has(blocker.id)) {
      throw new PrefilterConfigError(source, `${label}.id duplicates "${blocker.id}"`);
    }
    blockerIds.add(blocker.id);
    if (blocker.reason != null && typeof blocker.reason !== 'string') {
      throw new PrefilterConfigError(source, `${label}.reason must be a string`);
    }
    if (blocker.reason != null && (
      blocker.reason.trim().length === 0
      || blocker.reason.length > PREFILTER_CONFIG_LIMITS.maxReasonChars
    )) {
      throw new PrefilterConfigError(
        source,
        `${label}.reason must be non-empty and at most ${PREFILTER_CONFIG_LIMITS.maxReasonChars} characters`,
      );
    }
    const compiled = {
      id: blocker.id,
      all: compileList(blocker.all, `${label}.all`, source, {
        allowEmpty: false,
        maxPatterns: PREFILTER_CONFIG_LIMITS.maxPatternsPerBlocker,
      }),
      reason: blocker.reason ?? blocker.id,
    };
    blockerPatternCount += compiled.all.length;
    return blocker.enabled ? compiled : null;
  }).filter(Boolean);

  const comp = config.comp ?? {};
  if (!isRecord(comp)) {
    throw new PrefilterConfigError(source, 'comp must be a mapping');
  }
  rejectUnknownKeys(comp, COMP_KEYS, 'comp', source);
  if (comp.enabled != null && typeof comp.enabled !== 'boolean') {
    throw new PrefilterConfigError(source, 'comp.enabled must be true or false');
  }
  const margin = comp.clearance_margin ?? 0.8;
  if (typeof margin !== 'number') {
    throw new PrefilterConfigError(source, 'comp.clearance_margin must be a number greater than 0 and at most 1');
  }
  if (!Number.isFinite(margin) || margin <= 0 || margin > 1) {
    throw new PrefilterConfigError(source, 'comp.clearance_margin must be a number greater than 0 and at most 1');
  }

  const keep = compileList(config.keep_signals, 'keep_signals', source);
  const ic = compileList(config.ic_families, 'ic_families', source);
  const wrong = compileList(config.wrong_functions, 'wrong_functions', source);
  const junior = compileList(config.below_level, 'below_level', source);
  const totalPatterns = keep.length + ic.length + wrong.length + junior.length + blockerPatternCount;
  if (totalPatterns > PREFILTER_CONFIG_LIMITS.maxTotalPatterns) {
    throw new PrefilterConfigError(
      source,
      `configuration has more than ${PREFILTER_CONFIG_LIMITS.maxTotalPatterns} regex patterns in total`,
    );
  }

  return {
    source,
    keep,
    ic,
    wrong,
    junior,
    blockers: compiledBlockers,
    comp: { enabled: comp.enabled !== false, margin },
  };
}

export function readPrefilterConfig(file) {
  let config;
  try {
    config = yaml.load(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new PrefilterConfigError(file, `cannot be read: ${error.message}`);
  }
  return compilePrefilterConfig(config, { source: file });
}

/**
 * Where the prefilter rules come from, in priority order.
 *
 * The canonical user-layer location is `workspace/search/prefilter.yml` — it
 * is what `src/paths.mjs` declares, what `src/scan/prefilter.mjs --help`
 * documents, and what the UI names when it explains a rejection. This resolver
 * looked only in `config/`, so a file written to the documented path was
 * silently ignored while `workspace/archive-legacy.mjs` moved the `config/`
 * copy out from under it. Someone who tuned their rules got the shipped
 * defaults and no indication why.
 *
 * The legacy path is still honoured, second, so an installation that predates
 * the workspace layout keeps working until it is migrated.
 */
export function resolvePrefilterConfigPath({
  root = ROOT,
  override = process.env.FRONTRUNNER_PREFILTER,
} = {}) {
  if (override) return resolve(override);
  const candidates = [
    join(root, 'workspace', 'search', 'prefilter.yml'),
    join(root, 'config', 'prefilter.yml'),
  ];
  const example = join(root, 'config', 'prefilter.example.yml');
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(example)) return example;
  throw new PrefilterConfigError(example, 'file does not exist');
}

export function loadPrefilterRules(options = {}) {
  const file = resolvePrefilterConfigPath(options);
  return { file, ...readPrefilterConfig(file) };
}
