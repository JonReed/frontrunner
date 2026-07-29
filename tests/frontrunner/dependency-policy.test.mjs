import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import { ROOT } from '#paths';

const dependabot = yaml.load(
  readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8'),
  { schema: yaml.JSON_SCHEMA },
);

test('Dependabot is the only dependency update bot', () => {
  assert.equal(existsSync(join(ROOT, 'renovate.json')), false);
  assert.equal(existsSync(join(ROOT, '.renovaterc')), false);
  assert.equal(existsSync(join(ROOT, '.renovaterc.json')), false);
});

test('npm updates use explicit maturity windows and keep majors separate', () => {
  const npmUpdates = dependabot.updates.filter(
    update => update['package-ecosystem'] === 'npm',
  );

  assert.ok(npmUpdates.length > 0);
  for (const update of npmUpdates) {
    assert.equal(update.schedule.interval, 'daily');
    assert.equal(update.cooldown['default-days'], 7);
    assert.equal(update.cooldown['semver-major-days'], 30);
    assert.equal(update.cooldown['semver-minor-days'], 7);
    assert.equal(update.cooldown['semver-patch-days'], 3);
    assert.deepEqual(update.cooldown.include, ['*']);

    for (const group of Object.values(update.groups ?? {})) {
      assert.deepEqual(
        group['update-types'],
        ['minor', 'patch'],
        `${update.directory} must not group major updates`,
      );
    }
  }
});

test('GitHub Actions updates have a seven-day maturity window', () => {
  const actionsUpdate = dependabot.updates.find(
    update => update['package-ecosystem'] === 'github-actions',
  );

  assert.ok(actionsUpdate);
  assert.equal(actionsUpdate.cooldown['default-days'], 7);
  assert.deepEqual(actionsUpdate.cooldown.include, ['*']);
});

test('scheduled audits cover every committed npm lockfile', () => {
  const workflow = yaml.load(
    readFileSync(join(ROOT, '.github', 'workflows', 'dependency-audit.yml'), 'utf8'),
    { schema: yaml.JSON_SCHEMA },
  );
  const entries = workflow.jobs.audit.strategy.matrix.include;
  const auditedLockfiles = entries.map(entry => entry.lockfile).sort();

  assert.deepEqual(auditedLockfiles, [
    'package-lock.json',
    'ui/package-lock.json',
    'web/package-lock.json',
  ]);
  assert.match(
    workflow.jobs.audit.steps.at(-1).run,
    /^npm audit --package-lock-only --audit-level=high$/u,
  );
});
