#!/usr/bin/env node

/**
 * Remove facts accidentally copied from the old illustrative profile template.
 *
 * This is intentionally narrow: it deletes only exact, known example values.
 * It is not a profile normaliser and must never erase a value merely because it
 * looks incomplete. A UK location entered by the person is the one exception:
 * its country, timezone and currency are deterministic, so we repair those
 * dependent fields together.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';

import { mutateFileLocked } from '../lib/locked-file.mjs';
import { profilePath } from './profile-write.mjs';

const UK_SUFFIX = /(?:,?\s*)(?:uk|u\.k\.|united kingdom|england|scotland|wales|northern ireland)\s*$/iu;

const ILLUSTRATIVE_DEFAULTS = Object.freeze({
  'candidate.phone': '+1-555-0123',
  'candidate.linkedin': 'linkedin.com/in/janesmith',
  'candidate.portfolio_url': 'https://janesmith.dev',
  'candidate.github': 'github.com/janesmith',
  'candidate.twitter': 'https://x.com/janesmith',
  'target_roles.archetypes': [
    { name: 'AI/ML Engineer', level: 'Senior/Staff', fit: 'primary' },
    { name: 'AI Product Manager', level: 'Senior', fit: 'secondary' },
    { name: 'Solutions Architect', level: 'Mid-Senior', fit: 'adjacent' },
  ],
  narrative: {
    headline: 'ML Engineer turned AI product builder',
    exit_story: 'Built and sold my SaaS after 5 years. Now focused on applied AI at scale.',
    superpowers: [
      'End-to-end ML pipelines',
      'Fast prototyping (idea to prod in 2 weeks)',
      'Cross-functional communication',
    ],
    proof_points: [
      { name: 'Project Alpha', url: 'https://janesmith.dev/project-alpha', hero_metric: 'Reduced inference latency 40%' },
      { name: 'Open Source Tool', url: 'https://github.com/janesmith/tool', hero_metric: '2K+ GitHub stars' },
    ],
  },
  'compensation.target_range': '$150K-200K',
  'compensation.currency': 'USD',
  'compensation.minimum': '$120K',
  'compensation.location_flexibility': 'Remote preferred, 1 week/month on-site possible',
  'location.country': 'United States',
  'location.city': 'San Francisco',
  'location.timezone': 'PST',
  'location.visa_status': 'No sponsorship needed',
  'location.authorized_in': ['United States'],
  'location.needs_sponsorship': false,
  cover_letter: {
    notice_period_days: 30,
    primary_domain: 'your current domain',
    language_learning: [{
      language: 'Spanish', current_level: 'B1', target_level: 'B2', target_date: 'end of 2026',
      sentence: 'Estoy aprendiendo español y espero alcanzar el nivel B2 a finales de 2026.',
      countries: ['Spain', 'Mexico', 'Argentina', 'Colombia', 'Chile'],
    }],
  },
});

function getValue(doc, path) {
  const value = doc.getIn(path.split('.'), false);
  return value && typeof value.toJSON === 'function' ? value.toJSON() : value;
}

function ukLocation(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || !UK_SUFFIX.test(raw)) return null;
  return raw.replace(UK_SUFFIX, '').replace(/[\s,]+$/u, '');
}

export function repairIllustrativeProfileDefaults(current) {
  const doc = parseDocument(current);
  if (doc.errors?.length) throw new Error(`profile could not be parsed: ${doc.errors[0].message}`);

  const changed = [];
  for (const [path, example] of Object.entries(ILLUSTRATIVE_DEFAULTS)) {
    if (isDeepStrictEqual(getValue(doc, path), example)) {
      doc.deleteIn(path.split('.'));
      changed.push(path);
    }
  }

  const city = ukLocation(getValue(doc, 'candidate.location'));
  if (city) {
    for (const [path, value] of Object.entries({
      'location.city': city,
      'location.country': 'United Kingdom',
      'location.timezone': 'Europe/London',
      'compensation.currency': 'GBP',
    })) {
      if (!isDeepStrictEqual(getValue(doc, path), value)) {
        doc.setIn(path.split('.'), value);
        changed.push(path);
      }
    }
  }

  return { content: String(doc), changed };
}

export async function repairStoredIllustrativeProfileDefaults() {
  const file = profilePath();
  if (!existsSync(file)) return { changed: [] };
  let changed = [];
  await mutateFileLocked(file, current => {
    const result = repairIllustrativeProfileDefaults(current);
    changed = result.changed;
    return result.content;
  });
  return { changed };
}

export async function main(args = process.argv.slice(2), output = process.stdout) {
  if (args.length > 1 || (args[0] && args[0] !== '--apply')) {
    throw new Error('usage: node src/application/repair-profile-defaults.mjs [--apply]');
  }
  if (args[0] !== '--apply') {
    output.write(`${JSON.stringify({ status: 'preview', file: profilePath() })}\n`);
    return { status: 'preview' };
  }
  const result = await repairStoredIllustrativeProfileDefaults();
  output.write(`${JSON.stringify({ status: 'repaired', ...result })}\n`);
  return result;
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) await main();
