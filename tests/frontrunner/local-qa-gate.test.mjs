import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import * as yaml from 'js-yaml';

import { ROOT } from '#paths';

test('local commit/push hooks cover the complete backend and UI QA gates', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const hook = readFileSync(join(ROOT, '.github', 'hooks', 'pre-commit'), 'utf8');
  const pushHook = readFileSync(join(ROOT, '.github', 'hooks', 'pre-push'), 'utf8');
  const workflow = yaml.load(
    readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8'),
    { schema: yaml.JSON_SCHEMA },
  );
  const workflowCommands = workflow.jobs.test.steps
    .map(step => step?.run)
    .filter(Boolean);
  const uiWorkflow = yaml.load(
    readFileSync(join(ROOT, '.github', 'workflows', 'ui-ci.yml'), 'utf8'),
    { schema: yaml.JSON_SCHEMA },
  );
  const uiWorkflowCommands = uiWorkflow.jobs.ui.steps
    .map(step => step?.run)
    .filter(Boolean);

  assert.equal(packageJson.scripts.test, 'node test-all.mjs');
  assert.equal(packageJson.scripts.qa, 'npm test && npm run benchmark:check');
  assert.match(packageJson.scripts['hooks:install'], /core\.hooksPath \.github\/hooks/u);
  assert.equal(packageJson.scripts['qa:full'], 'npm run qa && npm run qa:ui');
  assert.match(hook, /^#!\/bin\/sh[\s\S]*exec npm run qa:full\s*$/u);
  assert.match(pushHook, /^#!\/bin\/sh[\s\S]*exec npm run qa:full\s*$/u);
  assert.deepEqual(
    workflowCommands.filter(command => /test-all|benchmark:check|npm run qa/u.test(command)),
    ['npm run qa'],
  );
  assert.deepEqual(uiWorkflowCommands, ['npm ci --ignore-scripts', 'npm run qa:ui']);
});
