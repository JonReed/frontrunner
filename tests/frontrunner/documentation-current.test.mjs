import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

test('README documents the executable canonical pipeline and generated benchmark', () => {
  const pkg = JSON.parse(read('package.json'));
  const readme = read('README.md');
  assert.equal(pkg.scripts.pipeline, 'node src/pipeline/run.mjs');
  assert.equal(pkg.scripts['pipeline:prepare'], 'node src/pipeline/run.mjs --prepare-only');
  assert.match(readme, /npm run pipeline/);
  assert.match(readme, /npm run pipeline:prepare/);
  assert.match(readme, /benchmarks\/pipeline-benchmark\.json/);
  assert.match(readme, /provider APIs.*Playwright is a fallback/is);
});

test('architecture does not resurrect the nonexistent multi-CLI batch flag or browser-first flow', () => {
  const architecture = read('docs/ARCHITECTURE.md');
  assert.doesNotMatch(architecture, /batch-runner\.sh.*--cli/s);
  assert.doesNotMatch(architecture, /Extract.*Playwright\/WebFetch/);
  assert.match(architecture, /API engines[\s\S]*Claude batch/);
  assert.match(architecture, /mandatory prefilter/);
});

test('canonical agent documentation routes pipeline mode to code, not hand-built agent fan-out', () => {
  const agents = read('AGENTS.md');
  const skill = read('.agents/skills/career-ops/SKILL.md');
  const mode = read('modes/pipeline.md');
  assert.match(agents, /src\/pipeline\/run\.mjs` is the canonical backend orchestrator/);
  assert.match(skill, /For `pipeline`, run `npm run pipeline`/);
  assert.doesNotMatch(skill, /For `scan`, `apply`[^.]+and `pipeline`/);
  assert.match(mode, /Do not manually reconstruct the stages/);
  assert.doesNotMatch(mode, /Playwright \(preferred\)/);
});

test('batch documentation accurately says Claude-only, A-G, and mandatory deterministic filtering', () => {
  const batch = read('batch/README.md');
  assert.match(batch, /Claude Code headless workers/);
  assert.match(batch, /A-G report/);
  assert.match(batch, /runs the deterministic prefilter again/);
  assert.doesNotMatch(batch, /supports multiple CLIs|A-F report/);
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
