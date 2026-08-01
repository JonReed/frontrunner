import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';

const read = (file) => readFileSync(join(ROOT, file), 'utf8');

test('the canonical pipeline scripts are what the docs point at', () => {
  /*
    Checks REALITY, not wording: the npm scripts exist and invoke the canonical
    orchestrator. Asserting that README.md recites a particular sentence is a
    different thing, and not a thing worth testing — descriptive documentation
    is not executed, so freezing its phrasing only makes editing it expensive.
    tests/frontrunner/documentation-links.test.mjs still catches docs that point
    at commands or paths which do not exist, which is the failure that matters.
  */
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.pipeline, 'node src/pipeline/run.mjs');
  assert.equal(pkg.scripts['pipeline:prepare'], 'node src/pipeline/run.mjs --prepare-only');
  assert.equal(pkg.scripts['benchmark:prefilter'], 'node src/benchmark/prefilter-calibration.mjs');
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
  // Only the negative half is kept. "Upstream branding must not reappear" is a
  // real constraint with a real cost if broken; "this file must contain the
  // phrase 'sole maintainer'" is an editing tax with no failure behind it.
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
