import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('finishing setup leads directly to the first-search experience', async () => {
  const setup = await read('ui/src/components/setup-flow.tsx');
  assert.match(setup, /window\.location\.href = '\/found\?welcome=1'/u);
  assert.match(setup, /Finish and find roles/u);
});

test('first search makes costs and the free scan path explicit', async () => {
  const [found, control] = await Promise.all([
    read('ui/src/app/found/page.tsx'),
    read('ui/src/components/pipeline-control.tsx'),
  ]);

  assert.match(found, /Let’s find your first roles/u);
  assert.match(found, /firstSearch=\{firstSearch\}/u);
  assert.match(control, /Run your first search/u);
  assert.match(control, /AI subscription is used only for roles that pass your filters/u);
  assert.match(control, /Search your configured sources now\. It costs nothing/u);
});

test('allowance tooltips avoid the sticky header instead of being clipped', async () => {
  const button = await read('ui/src/components/ai-button.tsx');
  assert.match(button, /clearAbove/u);
  assert.match(button, /clearBelow/u);
  assert.match(button, /top-full right-0 mt-2/u);
  assert.match(button, /z-30/u);
});
