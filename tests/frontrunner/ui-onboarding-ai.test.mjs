import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('onboarding teaches the shared AI visual language and discloses the Claude boundary', async () => {
  const panel = await read('ui/src/components/onboarding-ai-profile.tsx');
  assert.match(panel, /Your first AI-assisted step/u);
  assert.match(panel, /violet button with a sparkle/u);
  assert.match(panel, /connected Claude\s+subscription/su);
  assert.match(panel, /usage comes out of that subscription/u);
  assert.match(panel, /never\s+receives your Claude password or subscription credentials/su);
  assert.match(panel, /<AiButton/u);
  assert.match(panel, /Find details in my CV/u);
});

test('AI profile suggestions require field selection and remain draft-only until setup finishes', async () => {
  const [setup, panel, actions, backend] = await Promise.all([
    read('ui/src/components/setup-flow.tsx'),
    read('ui/src/components/onboarding-ai-profile.tsx'),
    read('ui/src/app/actions.ts'),
    read('src/application/profile-extraction.mjs'),
  ]);
  assert.match(panel, /type="checkbox"/u);
  assert.match(panel, /Evidence:/u);
  assert.match(panel, /Use selected details/u);
  assert.match(setup, /proposals\.reduce\(applyProfileProposal, current\)/u);
  assert.match(actions, /return await extractProfile\(cv\)/u);
  assert.doesNotMatch(actions, /extractCvProfile[\s\S]{0,1200}saveProfile\(/u);
  assert.match(backend, /This module never writes user\s+\* data/su);
  assert.doesNotMatch(backend, /writeFile|publishProfileSave|replaceFileAtomic/u);
});

test('clear explicit facts for empty fields are the only suggestions preselected', async () => {
  const panel = await read('ui/src/components/onboarding-ai-profile.tsx');
  assert.match(
    panel,
    /proposal\.basis === 'explicit'\s*&& proposal\.confidence === 'high'\s*&& !currentProposalValue\(draft, proposal\)\.trim\(\)/su,
  );
  assert.match(panel, /would replace/u);
});
