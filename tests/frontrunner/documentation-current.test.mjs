import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');

test('README documents the executable canonical pipeline and generated benchmark', () => {
  const pkg = JSON.parse(read('package.json'));
  const readme = read('README.md');
  assert.equal(pkg.scripts.pipeline, 'node src/pipeline/run.mjs');
  assert.equal(pkg.scripts['pipeline:prepare'], 'node src/pipeline/run.mjs --prepare-only');
  assert.match(readme, /npm run pipeline/);
  assert.match(readme, /npm run pipeline:prepare/);
  assert.match(readme, /src\/benchmark\/corpora\/pipeline-benchmark\.json/);
  assert.match(readme, /105-role leadership calibration/);
  assert.match(readme, /npm run benchmark:prefilter/);
  assert.equal(
    pkg.scripts['benchmark:prefilter'],
    'node src/benchmark/prefilter-calibration.mjs',
  );
  assert.match(readme, /provider APIs.*Playwright is a fallback/is);
});

test('architecture documents tool-less Claude and does not resurrect browser-first or privileged batch flow', () => {
  const architecture = read('docs/ARCHITECTURE.md');
  assert.doesNotMatch(architecture, /batch-runner\.sh.*--cli/s);
  assert.doesNotMatch(architecture, /Extract.*Playwright\/WebFetch/);
  assert.match(architecture, /API engines[\s\S]*Tool-less Claude CLI/);
  assert.doesNotMatch(architecture, /self-contained worker|skipped permissions/);
  assert.match(architecture, /mandatory prefilter/);
});

test('canonical agent documentation routes pipeline mode to code, not hand-built agent fan-out', () => {
  const agents = read('AGENTS.md');
  const skill = read('.agents/skills/frontrunner/SKILL.md');
  const mode = read('modes/pipeline.md');
  assert.match(agents, /src\/pipeline\/run\.mjs` is the canonical backend orchestrator/);
  assert.match(skill, /For `pipeline`, run `npm run pipeline`/);
  assert.doesNotMatch(skill, /For `scan`, `apply`[^.]+and `pipeline`/);
  assert.match(mode, /Do not manually reconstruct the stages/);
  assert.doesNotMatch(mode, /Playwright \(preferred\)/);
});

test('batch documentation accurately says tool-less Claude, A-G, and mandatory deterministic filtering', () => {
  const batch = read('batch/README.md');
  assert.match(batch, /tool-less Claude/);
  assert.match(batch, /zero tools/);
  assert.match(batch, /A-G report/);
  assert.match(batch, /runs the deterministic prefilter again/);
  assert.doesNotMatch(batch, /supports multiple CLIs|A-F report/);
});

test('maintainer documentation cannot revive upstream governance, support, or archived web claims', () => {
  const files = [
    'CONTRIBUTING.md',
    'SUPPORT.md',
    'docs/CONTRIBUTORS.md',
    'docs/REVIEWING.md',
  ];
  const current = files.map(file => `${file}\n${read(file)}`).join('\n');
  for (const retired of [
    /discord\.gg/iu,
    /55K\+ stars/iu,
    /santifer\.io\/ai-agent-fleet/iu,
    /contribution ladder/iu,
    /reviewer, then maintainer/iu,
    /npm\s+-C\s+web/iu,
    /full authority over content direction/iu,
  ]) {
    assert.doesNotMatch(current, retired);
  }
  assert.match(read('CONTRIBUTING.md'), /sole maintainer/iu);
  assert.match(read('CONTRIBUTING.md'), /`web\/` tree is archived/iu);
  assert.match(read('docs/CONTRIBUTORS.md'), /historical credit/iu);
});

test('supported-host documentation distinguishes tested CLIs from compatibility paths', () => {
  for (const file of [
    'AGENTS.md',
    'README.md',
    'SUPPORT.md',
    'docs/ARCHITECTURE.md',
    'docs/FAQ.md',
    'docs/SETUP.md',
    'docs/SUPPORTED_CLIS.md',
  ]) {
    const source = read(file);
    assert.match(source, /Claude Code/iu, file);
    assert.match(source, /Codex/iu, file);
    assert.match(source, /Antigravity CLI/iu, file);
    assert.match(source, /tested/iu, file);
    assert.match(source, /compatibility/iu, file);
  }
});

test('threat model labels skipped-permission and raw-HTML findings as historical, not current gaps', () => {
  const threatModel = read('docs/frontrunner-threat-model.md');
  const historicalEntry = threatModel.indexOf(
    '## Inherited entry points and attack surfaces (historical)',
  );
  const historicalTable = threatModel.indexOf(
    '## Inherited threat table (historical)',
  );
  assert.ok(historicalEntry > 0);
  assert.ok(historicalTable > historicalEntry);
  assert.ok(
    threatModel.indexOf('Runs with `--dangerously-skip-permissions`')
      > historicalEntry,
  );
  assert.match(
    threatModel.slice(0, historicalEntry),
    /Privileged JD-facing agents and document generation \| Fixed/iu,
  );
});

test('every market pipeline mode carries the canonical backend override', () => {
  const modesDir = join(ROOT, 'modes');
  const marketPipelines = readdirSync(modesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(modesDir, entry.name, 'pipeline.md'))
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(marketPipelines.length >= 18);
  for (const file of marketPipelines) {
    const content = readFileSync(file, 'utf8');
    assert.match(content, /Frontrunner backend override:[\s\S]*npm run pipeline/);
    assert.match(content, /Playwright only as fallback/);
    assert.doesNotMatch(content, /browser_navigate|browser_snapshot|Playwright \(preferred\)/);
  }
});
