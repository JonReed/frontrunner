/**
 * DE (Germany / AGG) row in templates/protected-grounds.yml.
 *
 * Ported from upstream e8df8dc (career-ops #2333). The table is a prompt-level
 * data reference consumed by modes/interview-redflag.md Step 2c: no script
 * reads it, so a malformed row fails silently at the exact moment someone is
 * trying to understand what happened in their own interview. These assertions
 * are the only thing standing between a bad edit and a confidently wrong
 * jurisdiction lookup.
 *
 * The register discipline documented in the file header is load-bearing for
 * this row specifically: the AGG creates civil liability, but §8/§9/§10 carry
 * real exceptions, and nationality is NOT a standalone §1 ground. A row that
 * drops the exceptions or promotes nationality to a statutory ground would
 * turn an awareness aid into a false accusation.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import yaml from 'js-yaml';
import { TEMPLATES_DIR } from '#paths';

const raw = readFileSync(join(TEMPLATES_DIR, 'protected-grounds.yml'), 'utf-8');
const rows = yaml.load(raw)?.protected_grounds ?? [];
const de = rows.find((row) => row?.jurisdiction === 'DE');

test('DE row exists and satisfies the table contribution rule', () => {
  assert.ok(de, 'templates/protected-grounds.yml has no DE row');
  assert.equal(de.jurisdiction_name, 'Germany');
  assert.ok(Array.isArray(de.grounds) && de.grounds.length > 0);
  assert.ok(typeof de.legal_basis === 'string' && de.legal_basis.length > 0);
  assert.ok(Array.isArray(de.sources) && de.sources.length > 0);
  // as_of must stay a quoted string — an unquoted YAML date parses to a Date
  // object and every downstream string comparison silently changes meaning.
  assert.equal(typeof de.as_of, 'string');
  assert.match(de.as_of, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(
    de.sources.some((source) => source.includes('gesetze-im-internet.de/agg')),
    'DE row must cite the official AGG statute text',
  );
});

test('DE grounds cover the six §1 grounds plus gender identity and nationality', () => {
  const topics = de.grounds.map((ground) => ground.topic);
  for (const expected of [
    /ethnische Herkunft/,
    /Geschlecht \(/,
    /Geschlechtsidentität/,
    /Religion oder Weltanschauung/,
    /Behinderung/,
    /Alter/,
    /Sexuelle Identität/,
    /Staatsangehörigkeit/,
  ]) {
    assert.ok(
      topics.some((topic) => expected.test(topic)),
      `DE row missing a ground matching ${expected}`,
    );
  }
  // Bilingual terms: transcripts arrive in either language, and modes/de
  // supplies the German vocabulary. Both halves must survive the UTF-8 parse.
  assert.ok(topics.every((topic) => /\(.+\)/.test(topic)), 'every DE topic needs an English gloss');
  assert.ok(topics.some((topic) => topic.includes('ä') || topic.includes('ü')));
});

test('DE row keeps its statutory exceptions so lawful questions are not flagged', () => {
  const contexts = de.grounds.flatMap((ground) => ground.legitimate_contexts ?? []).join(' ');
  assert.match(contexts, /§9 AGG/, 'religious-organisation exception missing');
  assert.match(contexts, /§10 AGG/, 'permissible age differentiation missing');
  assert.match(contexts, /§8 AGG/, 'genuine occupational requirement exception missing');
  assert.match(
    contexts,
    /Aufenthaltstitel|Arbeitserlaubnis/,
    'work-authorisation carve-out missing — asking about the right to work is lawful',
  );
  const pregnancy = de.grounds.find((ground) => /Geschlecht \(/.test(ground.topic));
  assert.match(
    (pregnancy.legitimate_contexts ?? []).join(' '),
    /ALWAYS inadmissible/,
    'pregnancy questions have no exception under ADS guidance and the row must say so',
  );
});

test('DE legal_basis carries the AGG sections and does not promote nationality to a §1 ground', () => {
  for (const section of ['§1', '§7', '§8', '§9', '§10', '§22', '§3']) {
    assert.ok(de.legal_basis.includes(section), `legal_basis missing ${section}`);
  }
  assert.match(de.legal_basis, /not an explicit\s+standalone §1 ground/);
  assert.match(de.legal_basis, /Recht zur\s+Lüge/, '"right to lie" case law is the DE-specific point');
});

test('the header still lists DE/AGG as a candidate row for contributors', () => {
  // tests/core/11-cross-surface-contracts.mjs asserts the commented candidate
  // list mentions AGG. Adding the row must not delete the guidance that
  // explains the discipline the row was held to.
  assert.match(raw, /CANDIDATE ROWS FOR CONTRIBUTORS/);
  assert.match(raw, /Allgemeines Gleichbehandlungsgesetz \(AGG\)/);
});
