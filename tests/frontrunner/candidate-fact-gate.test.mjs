import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertFacts,
  factClaims,
  verifyFacts,
} from '../../src/cv/verify-cv-facts.mjs';
import { validateCoverLetterHtml } from '../../src/cv/generate-cover-letter.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'frontrunner-candidate-facts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'cv.md');
  const config = join(root, 'cv-facts.json');
  writeFileSync(
    source,
    'Senior Platform Engineer at Acme Labs. Built using React and Docker. Improved reliability for 25 users.\n',
  );
  writeFileSync(config, JSON.stringify({
    allow_metrics: [],
    allow_facts: [],
    forbidden_phrases: [],
    warn_phrases: ['maybe'],
  }));
  return { root, source, config };
}

test('explicit employer, title and tool claims require trusted evidence', t => {
  const { source, config } = fixture(t);
  const supported = verifyFacts(
    'I worked at Acme Labs as a Senior Platform Engineer, using React and Docker.',
    { sourcePaths: [source], configPath: config },
  );
  assert.equal(supported.verdict, 'pass');
  assert.deepEqual(supported.unsupportedFacts, []);

  const unsupported = verifyFacts(
    'I worked at Invented Labs as a Principal Platform Engineer, using React and Terraform.',
    { sourcePaths: [source], configPath: config },
  );
  assert.equal(unsupported.verdict, 'block');
  assert.deepEqual(
    unsupported.unsupportedFacts,
    [
      { kind: 'employer', value: 'invented labs' },
      { kind: 'title', value: 'principal platform engineer' },
      { kind: 'tool', value: 'terraform' },
    ],
  );
});

test('unknown lowercase tools fail closed without turning ordinary prose into facts', () => {
  const claims = factClaims(
    'Built using react with kubernetes and google cloud. '
    + 'Used a service built with Rust to process events. '
    + 'I worked with the team in London.',
  );
  assert.deepEqual(claims, [
    { kind: 'tool', value: 'react' },
    { kind: 'tool', value: 'kubernetes' },
    { kind: 'tool', value: 'google cloud' },
    { kind: 'tool', value: 'rust' },
  ]);
});

test('explicit fact extraction is case- and Unicode-aware without swallowing trailing prose', () => {
  assert.deepEqual(
    factClaims(
      'I worked at acme labs as a senior engineer. '
      + 'I joined 株式会社アクメ as a 平台主管.',
    ),
    [
      { kind: 'employer', value: 'acme labs' },
      { kind: 'employer', value: '株式会社アクメ' },
      { kind: 'title', value: 'senior engineer' },
      { kind: 'title', value: '平台主管' },
    ],
  );
});

test('advisory phrases warn while blocking facts throw a stable error', t => {
  const { source, config } = fixture(t);
  const warning = verifyFacts('Maybe this needs review.', {
    sourcePaths: [source],
    configPath: config,
  });
  assert.equal(warning.verdict, 'warn');
  assert.deepEqual(warning.warnings, ['maybe']);

  assert.throws(
    () => assertFacts('Worked at Invented Labs.', {
      sourcePaths: [source],
      configPath: config,
      label: 'test document',
    }),
    /Fact check failed for test document.*employer=invented labs/,
  );
});

test('cover-letter gate blocks before any artifact can replace existing content', t => {
  const { root, source, config } = fixture(t);
  const existingArtifact = join(root, 'cover.pdf');
  writeFileSync(existingArtifact, 'existing-user-artifact');

  assert.throws(
    () => validateCoverLetterHtml(
      '<p>I improved reliability for 26 users while using Terraform.</p>',
      { sourcePaths: [source], configPath: config },
    ),
    /26 users.*tool=terraform/,
  );
  assert.equal(readFileSync(existingArtifact, 'utf8'), 'existing-user-artifact');
});

test('fact evidence cannot be redirected through a symbolic link', t => {
  const { root, config } = fixture(t);
  const external = join(root, 'external.md');
  const linkedSource = join(root, 'linked-cv.md');
  writeFileSync(external, 'Worked at Invented Labs.');
  symlinkSync(external, linkedSource);
  assert.throws(
    () => verifyFacts('Worked at Invented Labs.', {
      sourcePaths: [linkedSource],
      configPath: config,
    }),
    /must not be a symbolic link|stable regular file/,
  );
});
