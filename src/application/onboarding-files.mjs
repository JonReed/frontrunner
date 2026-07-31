/**
 * Provision the non-personal files that make a completed onboarding usable.
 *
 * The template is system-owned; the destination is private user state. Copy
 * only when the destination is absent, under the same lock used by other
 * local writers, so an existing customised portals file is never replaced.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';

import { ROOT } from '#paths';
import { withFileLock } from '../lib/file-lock.mjs';
import { copyFileAtomic, replaceFileAtomic } from '../lib/locked-file.mjs';

export function onboardingBase() {
  return process.env.FRONTRUNNER_PROFILE_BASE || ROOT;
}

export const portalsPath = (base = onboardingBase()) =>
  join(base, 'workspace', 'search', 'portals.yml');
export const portalsTemplatePath = (base = onboardingBase()) =>
  join(base, 'templates', 'portals.example.yml');
export const targetingPath = (base = onboardingBase()) =>
  join(base, 'workspace', 'profile', 'targeting.md');
export const preferencesPath = (base = onboardingBase()) =>
  join(base, 'workspace', 'profile', 'preferences.md');
export const trackerPath = (base = onboardingBase()) =>
  join(base, 'workspace', 'applications', 'tracker.md');

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

function uniqueText(values) {
  return [...new Set((values ?? [])
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean))];
}

export function renderTargeting({ roles = [], superpower = '', workExcites = '', workDrains = '', dealBreakers = '' } = {}) {
  const titles = uniqueText(roles);
  if (titles.length === 0) throw new Error('At least one target role is required to create the search brief.');
  const section = (heading, value, fallback) => `## ${heading}\n\n${String(value ?? '').trim() || fallback}\n`;
  return `# Search brief

This file contains the candidate's confirmed search preferences. It was created
from onboarding answers and can be edited at any time.

## Target roles

${titles.map(title => `- ${title}`).join('\n')}

${section('Distinctive strengths', superpower, 'Not specified yet.')}
${section('Work that is energising', workExcites, 'Not specified yet.')}
${section('Work to avoid', workDrains, 'Not specified yet.')}
${section('Deal-breakers', dealBreakers, 'Not specified yet.')}`;
}

export function renderPortalsTemplate(template, { roles = [], city = '', country = '', workingPattern = '' } = {}) {
  const titles = uniqueText(roles);
  if (titles.length === 0) throw new Error('At least one target role is required to configure the scanner.');
  const doc = parseDocument(template);
  if (doc.errors?.length) throw new Error(`The bundled portals template is invalid: ${doc.errors[0].message}`);
  doc.setIn(['title_filter', 'positive'], titles);
  // The inherited exclusions describe one particular engineer. Applying them
  // to a new user silently drops valid work, so onboarding starts neutral.
  doc.setIn(['title_filter', 'negative'], []);
  doc.setIn(['title_filter', 'seniority_boost'], []);
  // These inherited queries describe the template author's search and are not
  // consumed by the deterministic scanner. Keeping them enabled would be a
  // misleading profile leak for any compatibility host that still reads them.
  doc.set('search_queries', []);

  const local = uniqueText([city, country]);
  const remote = /remote|hybrid/iu.test(String(workingPattern ?? '')) ? ['Remote'] : [];
  doc.setIn(['location_filter', 'always_allow'], local);
  doc.setIn(['location_filter', 'allow'], uniqueText([...local, ...remote]));
  doc.setIn(['location_filter', 'block'], []);
  return String(doc);
}

async function createOnce(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  return withFileLock(target, () => {
    if (existsSync(target)) return { created: false, path: target };
    replaceFileAtomic(target, content, { mode: 0o600 });
    return { created: true, path: target };
  });
}

export async function ensurePortalsFile({ base = onboardingBase(), profile = null } = {}) {
  const target = portalsPath(base);
  const template = portalsTemplatePath(base);
  if (!existsSync(template)) {
    throw new Error('The bundled portals template is missing; onboarding was left incomplete.');
  }

  if (!profile) {
    mkdirSync(dirname(target), { recursive: true });
    return withFileLock(target, () => {
      if (existsSync(target)) return { created: false, path: target };
      copyFileAtomic(template, target, { mode: 0o600 });
      return { created: true, path: target };
    });
  }
  return createOnce(target, renderPortalsTemplate(readFileSync(template, 'utf8'), profile));
}

export async function ensureTargetingFile({ base = onboardingBase(), targeting } = {}) {
  return createOnce(targetingPath(base), renderTargeting(targeting));
}

export async function ensurePreferencesFile({ base = onboardingBase() } = {}) {
  const template = join(base, 'modes', '_custom.template.md');
  if (!existsSync(template)) throw new Error('The bundled preferences template is missing.');
  const target = preferencesPath(base);
  mkdirSync(dirname(target), { recursive: true });
  return withFileLock(target, () => {
    if (existsSync(target)) return { created: false, path: target };
    copyFileAtomic(template, target, { mode: 0o600 });
    return { created: true, path: target };
  });
}

export async function ensureTrackerFile({ base = onboardingBase() } = {}) {
  return createOnce(trackerPath(base), TRACKER);
}
