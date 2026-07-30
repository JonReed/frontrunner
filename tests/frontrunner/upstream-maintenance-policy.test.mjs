import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
const architecture = readFileSync(
  new URL('../../docs/ARCHITECTURE.md', import.meta.url),
  'utf8',
);

test('parent maintenance is selective and never imports the upstream branch wholesale', () => {
  for (const document of [agents, architecture]) {
    assert.doesNotMatch(document, /git\s+(?:merge|pull|rebase)\s+upstream(?:\/|\s+)main/iu);
  }
  assert.match(agents, /Upstream maintenance is permanently selective/u);
  assert.match(agents, /Never merge, rebase or pull the parent branch/u);
  assert.match(agents, /candidate SHA and the accept\/reject rationale/u);
  assert.match(agents, /npm run qa:full/u);
  assert.match(architecture, /accepted behavior is ported\s+selectively/u);
});
