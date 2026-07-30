import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import { ROOT } from '#paths';

const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .filter(name => /\.ya?ml$/u.test(name))
  .sort();

function loadWorkflow(name) {
  const source = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
  const document = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  return { document, source };
}

function visit(value, callback) {
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) visit(child, callback);
  }
}

test('GitHub workflows parse and declare least-privilege token permissions', () => {
  assert.ok(workflowFiles.length > 0, 'expected at least one GitHub workflow');

  for (const name of workflowFiles) {
    const { document } = loadWorkflow(name);
    assert.equal(typeof document, 'object', `${name} must parse as an object`);
    assert.ok(document.permissions, `${name} must declare top-level permissions`);
    assert.notEqual(document.permissions, 'write-all', `${name} must not use write-all`);

    visit(document.jobs, value => {
      if (!value || typeof value !== 'object' || !('permissions' in value)) return;
      assert.notEqual(value.permissions, 'write-all', `${name} job must not use write-all`);
    });
  }
});

test('every external GitHub Action is pinned to an immutable commit SHA', () => {
  const mutable = [];

  for (const name of workflowFiles) {
    const { document } = loadWorkflow(name);
    visit(document.jobs, value => {
      if (!value || typeof value !== 'object' || typeof value.uses !== 'string') return;
      if (value.uses.startsWith('./') || value.uses.startsWith('docker://')) return;
      if (!/^[^@\s]+@[a-f0-9]{40}$/u.test(value.uses)) {
        mutable.push(`${name}: ${value.uses}`);
      }
    });
  }

  assert.deepEqual(mutable, [], `mutable action references:\n${mutable.join('\n')}`);
});

test('every CI job has a finite timeout and checkout drops persisted credentials', () => {
  const violations = [];

  for (const name of workflowFiles) {
    const { document } = loadWorkflow(name);
    for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
      if (!Number.isFinite(job?.['timeout-minutes']) || job['timeout-minutes'] <= 0) {
        violations.push(`${name}:${jobName} has no positive timeout-minutes`);
      }
    }
    visit(document.jobs, value => {
      if (!value || typeof value !== 'object' || typeof value.uses !== 'string') return;
      if (!value.uses.startsWith('actions/checkout@')) return;
      if (value.with?.['persist-credentials'] !== false) {
        violations.push(`${name}: checkout must set persist-credentials: false`);
      }
    });
  }

  assert.deepEqual(violations, [], violations.join('\n'));
});

test('pull_request_target workflows never execute contributor-controlled code', () => {
  for (const name of workflowFiles) {
    const { document } = loadWorkflow(name);
    if (!document.on?.pull_request_target) continue;

    visit(document.jobs, value => {
      if (!value || typeof value !== 'object') return;
      assert.equal('run' in value, false, `${name} must not use run with pull_request_target`);
      if (typeof value.uses === 'string') {
        assert.equal(
          value.uses.startsWith('actions/checkout@'),
          false,
          `${name} must not check out code with pull_request_target`,
        );
      }
    });
  }
});

test('security checks cannot be silently downgraded and installs stay reproducible', () => {
  const violations = [];

  for (const name of workflowFiles) {
    const { document } = loadWorkflow(name);
    visit(document.jobs, value => {
      if (!value || typeof value !== 'object') return;
      if (value['continue-on-error'] === true) {
        violations.push(`${name}: continue-on-error`);
      }
      if (typeof value.run !== 'string') return;
      if (/\bnpm install\b/u.test(value.run)) {
        violations.push(`${name}: npm install (use npm ci)`);
      }
      if (/\bnpx\b/u.test(value.run)) {
        violations.push(`${name}: npx executes an unpinned package`);
      }
    });
  }

  assert.deepEqual(violations, [], violations.join('\n'));
});

test('CI package lockfiles exist and are explicitly versionable', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const relativePath of ['package-lock.json', 'ui/package-lock.json', 'web/package-lock.json']) {
    assert.equal(existsSync(join(ROOT, relativePath)), true, `${relativePath} must exist`);
    assert.match(
      gitignore,
      new RegExp(`^!${relativePath.replaceAll('.', '\\.')}\\s*$`, 'mu'),
      `${relativePath} must be unignored`,
    );
  }
});
