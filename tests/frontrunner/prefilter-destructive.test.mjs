import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ROOT } from '#paths';

const PREFILTER = join(ROOT, 'src', 'scan', 'prefilter.mjs');
const CALIBRATION = join(ROOT, 'src', 'benchmark', 'prefilter-calibration.mjs');

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-prefilter-destructive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'jds'));
  return dir;
}

function validConfig(overrides = '') {
  return `keep_signals: []
ic_families: []
wrong_functions: []
below_level:
  - '\\bjunior\\b'
hard_blockers: []
comp:
  enabled: false
  clearance_margin: 0.8
${overrides}`;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 3_000,
    ...options,
  });
}

test('destructive CLI: summary completes and hostile TSV fields cannot create columns or rows', (t) => {
  const dir = sandbox(t);
  const input = join(dir, 'input.md');
  const config = join(dir, 'prefilter.yml');
  const rejects = join(dir, 'rejects.tsv');
  const output = join(dir, 'filtered.tsv');
  writeFileSync(input, '- [ ] https://example.com/job | =2+2\tCorp | Junior\tEngineer\n');
  writeFileSync(config, validConfig());

  const result = run([
    PREFILTER,
    '--summary',
    '--input', input,
    '--jds', join(dir, 'jds'),
    '--rejects', rejects,
    '--out', output,
    '--config', config,
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\s+below_level/);
  const rows = readFileSync(rejects, 'utf8').trimEnd().split('\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].split('\t').length, 5);
  assert.match(rows[1], /'=2\+2 Corp\tJunior Engineer\tbelow_level\tJunior/);
});

test('destructive CLI: invalid config fails before replacing existing artifacts', (t) => {
  const invalidConfigs = [
    ['bad-array.yml', 'below_level: junior\n', /below_level must be an array/],
    ['bad-regex.yml', "keep_signals:\n  - '^(a+)+$'\n", /super-linear regex/],
    ['bad-margin.yml', 'comp:\n  clearance_margin: nope\n', /clearance_margin/],
    [
      'empty-blocker.yml',
      'hard_blockers:\n  - id: reject_all\n    enabled: true\n    all: []\n',
      /must contain at least one pattern/,
    ],
  ];

  for (const [name, contents, expected] of invalidConfigs) {
    const dir = sandbox(t);
    const input = join(dir, 'input.md');
    const config = join(dir, name);
    const rejects = join(dir, 'rejects.tsv');
    const output = join(dir, 'filtered.tsv');
    writeFileSync(input, '- [ ] https://example.com/job | Acme | Director\n');
    writeFileSync(config, contents);
    writeFileSync(rejects, 'existing rejects\n');
    writeFileSync(output, 'existing output\n');

    const result = run([
      PREFILTER,
      '--input', input,
      '--jds', join(dir, 'jds'),
      '--rejects', rejects,
      '--out', output,
      '--config', config,
    ]);

    assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
    assert.match(result.stderr, expected);
    assert.equal(readFileSync(rejects, 'utf8'), 'existing rejects\n');
    assert.equal(readFileSync(output, 'utf8'), 'existing output\n');
  }
});

test('destructive CLI: one invalid output target preserves both existing artifacts', (t) => {
  const dir = sandbox(t);
  const input = join(dir, 'input.md');
  const config = join(dir, 'prefilter.yml');
  const rejects = join(dir, 'rejects.tsv');
  const output = join(dir, 'filtered.tsv');
  writeFileSync(input, '- [ ] https://example.com/job | Acme | Junior Engineer\n');
  writeFileSync(config, validConfig());
  writeFileSync(rejects, 'existing rejects\n');
  mkdirSync(output);

  const result = run([
    PREFILTER,
    '--input', input,
    '--jds', join(dir, 'jds'),
    '--rejects', rejects,
    '--out', output,
    '--config', config,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output target is not a file/);
  assert.equal(readFileSync(rejects, 'utf8'), 'existing rejects\n');
});

test('destructive CLI: aliased input and artifact paths fail before overwriting', (t) => {
  const dir = sandbox(t);
  const input = join(dir, 'input.md');
  const config = join(dir, 'prefilter.yml');
  const artifact = join(dir, 'artifact.tsv');
  writeFileSync(input, '- [ ] https://example.com/job | Acme | Junior Engineer\n');
  writeFileSync(config, validConfig());
  writeFileSync(artifact, 'existing artifact\n');

  const sameArtifacts = run([
    PREFILTER,
    '--input', input,
    '--jds', join(dir, 'jds'),
    '--rejects', artifact,
    '--out', artifact,
    '--config', config,
  ]);
  assert.notEqual(sameArtifacts.status, 0);
  assert.match(sameArtifacts.stderr, /rejects and out must use different paths/);
  assert.equal(readFileSync(artifact, 'utf8'), 'existing artifact\n');

  const inputAsAudit = run([
    PREFILTER,
    '--input', input,
    '--jds', join(dir, 'jds'),
    '--rejects', input,
    '--config', config,
  ]);
  assert.notEqual(inputAsAudit.status, 0);
  assert.match(inputAsAudit.stderr, /input and rejects must use different paths/);
  assert.match(readFileSync(input, 'utf8'), /Junior Engineer/);
});

test('destructive CLI: flags missing values fail before replacing artifacts', (t) => {
  const dir = sandbox(t);
  const rejects = join(dir, 'rejects.tsv');
  writeFileSync(rejects, 'existing rejects\n');

  const result = run([
    PREFILTER,
    '--input',
    '--summary',
    '--rejects', rejects,
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--input requires a value/);
  assert.equal(readFileSync(rejects, 'utf8'), 'existing rejects\n');
});

test('destructive CLI: oversized hostile titles remain bounded and terminate', (t) => {
  const dir = sandbox(t);
  const input = join(dir, 'input.md');
  const config = join(dir, 'prefilter.yml');
  const rejects = join(dir, 'rejects.tsv');
  const output = join(dir, 'filtered.tsv');
  writeFileSync(input, `- [ ] https://example.com/job | Acme | ${'a'.repeat(50_000)}\n`);
  writeFileSync(config, validConfig());

  const result = run([
    PREFILTER,
    '--input', input,
    '--jds', join(dir, 'jds'),
    '--rejects', rejects,
    '--out', output,
    '--config', config,
  ]);

  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(output, 'utf8').length < 5_000);
});

test('destructive calibration: --check exits non-zero and names false rejects', (t) => {
  const dir = sandbox(t);
  const config = join(dir, 'prefilter.yml');
  const corpus = join(dir, 'corpus.json');
  writeFileSync(config, `keep_signals: []
ic_families: []
wrong_functions:
  - '\\bmarketing\\b'
below_level: []
hard_blockers: []
comp:
  enabled: false
  clearance_margin: 0.8
`);
  writeFileSync(corpus, JSON.stringify([
    { title: 'Head of Marketing', score: 4.2 },
    { title: 'Director of Engineering', score: 4.5 },
  ]));

  const result = run([
    CALIBRATION,
    '--config', config,
    '--corpus', corpus,
    '--check',
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /false rejects:\s+1/);
  assert.match(result.stdout, /Head of Marketing/);
});
