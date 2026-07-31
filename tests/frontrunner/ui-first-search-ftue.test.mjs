import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('finishing setup leads directly to the first-search experience', async () => {
  const setup = await read('ui/src/components/setup-flow.tsx');
  assert.match(setup, /window\.location\.href = '\/found\?welcome=1'/u);
  assert.match(setup, /Finish and find roles/u);
  assert.match(setup, /Complete required details first/u);
  assert.match(setup, /Review your profile before the first search/u);
});

test('setup checks profile fields rather than trusting the profile file alone', async () => {
  const setup = await read('ui/src/lib/setup.ts');
  assert.match(setup, /profileCompleteness/u);
  assert.match(setup, /profileMissing/u);
  assert.match(setup, /items\.some\(\(i\) => i\.required && !i\.present\) \|\| profileMissing\.length > 0/u);
});

test('re-entering onboarding preserves existing answers for correction instead of clearing them', async () => {
  const welcome = await read('ui/src/app/welcome/page.tsx');
  assert.match(welcome, /readProfileSnapshot/u);
  assert.match(welcome, /initial=\{\{/u);
  assert.match(welcome, /salaryCurrency/u);
  assert.match(welcome, /remoteValue/u);
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
  // The promise under test is "free, and you can connect later" — not the
  // phrase "configured sources", which stopped being accurate when search
  // gained a sweep of the public ATS directories and no longer depends on a
  // curated company list.
  assert.match(control, /It costs nothing; you can connect an AI subscription later/u);
});

test('allowance tooltips avoid the sticky header instead of being clipped', async () => {
  const button = await read('ui/src/components/ai-button.tsx');
  assert.match(button, /clearAbove/u);
  assert.match(button, /clearBelow/u);
  assert.match(button, /top-full right-0 mt-2/u);
  assert.match(button, /z-30/u);
});
