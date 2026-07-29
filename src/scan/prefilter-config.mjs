import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

import { ROOT } from '#paths';

export const PREFILTER_CONFIG_LIMITS = Object.freeze({
  maxPatternsPerGroup: 100,
  maxPatternChars: 500,
  maxBlockers: 50,
});

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

function hasNestedUnboundedQuantifier(pattern) {
  const stripped = pattern
    .replace(/\\./g, 'x')
    .replace(/\[(?:\\.|[^\]])*\]/g, 'x');
  return /\)\s*(?:[+*]|\{\d*,\})/.test(stripped)
    || /(?:\.\*|\.\+).*(?:\.\*|\.\+)/.test(stripped);
}

function compilePattern(value, label, source) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PrefilterConfigError(source, `${label} must be a non-empty regex string`);
  }
  if (value.length > PREFILTER_CONFIG_LIMITS.maxPatternChars) {
    throw new PrefilterConfigError(
      source,
      `${label} exceeds ${PREFILTER_CONFIG_LIMITS.maxPatternChars} characters`,
    );
  }
  if (/(^|[^\\])\\[1-9]/.test(value)) {
    throw new PrefilterConfigError(source, `${label} uses a backreference, which is not allowed`);
  }
  if (hasNestedUnboundedQuantifier(value)) {
    throw new PrefilterConfigError(source, `${label} contains a potentially super-linear regex`);
  }
  try {
    return new RegExp(value, 'i');
  } catch (error) {
    throw new PrefilterConfigError(source, `${label} is not a valid regex: ${error.message}`);
  }
}

function compileList(value, label, source, { allowEmpty = true } = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new PrefilterConfigError(source, `${label} must be an array`);
  }
  if (value.length > PREFILTER_CONFIG_LIMITS.maxPatternsPerGroup) {
    throw new PrefilterConfigError(
      source,
      `${label} has more than ${PREFILTER_CONFIG_LIMITS.maxPatternsPerGroup} patterns`,
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

  const compiledBlockers = blockers.map((blocker, index) => {
    const label = `hard_blockers[${index}]`;
    if (!isRecord(blocker)) {
      throw new PrefilterConfigError(source, `${label} must be a mapping`);
    }
    if (blocker.enabled != null && typeof blocker.enabled !== 'boolean') {
      throw new PrefilterConfigError(source, `${label}.enabled must be true or false`);
    }
    if (!blocker.enabled) return null;
    if (typeof blocker.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(blocker.id)) {
      throw new PrefilterConfigError(source, `${label}.id must be a lowercase identifier`);
    }
    if (blocker.reason != null && typeof blocker.reason !== 'string') {
      throw new PrefilterConfigError(source, `${label}.reason must be a string`);
    }
    return {
      id: blocker.id,
      all: compileList(blocker.all, `${label}.all`, source, { allowEmpty: false }),
      reason: blocker.reason ?? blocker.id,
    };
  }).filter(Boolean);

  const comp = config.comp ?? {};
  if (!isRecord(comp)) {
    throw new PrefilterConfigError(source, 'comp must be a mapping');
  }
  if (comp.enabled != null && typeof comp.enabled !== 'boolean') {
    throw new PrefilterConfigError(source, 'comp.enabled must be true or false');
  }
  const margin = Number(comp.clearance_margin ?? 0.8);
  if (!Number.isFinite(margin) || margin <= 0 || margin > 1) {
    throw new PrefilterConfigError(source, 'comp.clearance_margin must be a number greater than 0 and at most 1');
  }

  return {
    source,
    keep: compileList(config.keep_signals, 'keep_signals', source),
    ic: compileList(config.ic_families, 'ic_families', source),
    wrong: compileList(config.wrong_functions, 'wrong_functions', source),
    junior: compileList(config.below_level, 'below_level', source),
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

export function resolvePrefilterConfigPath({
  root = ROOT,
  override = process.env.CAREER_OPS_PREFILTER,
} = {}) {
  if (override) return resolve(override);
  const user = join(root, 'config', 'prefilter.yml');
  const example = join(root, 'config', 'prefilter.example.yml');
  if (existsSync(user)) return user;
  if (existsSync(example)) return example;
  throw new PrefilterConfigError(example, 'file does not exist');
}

export function loadPrefilterRules(options = {}) {
  const file = resolvePrefilterConfigPath(options);
  return { file, ...readPrefilterConfig(file) };
}
