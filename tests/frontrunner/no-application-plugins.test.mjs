import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';

const REMOVED_PATHS = [
  'config/plugins.example.yml',
  'docs/PLUGINS.md',
  'docs/PLUGIN_REVIEW.md',
  'plugins',
  'plugins-registry',
  'src/plugins',
  '.github/ISSUE_TEMPLATE/plugin-registration.yml',
  '.github/PULL_REQUEST_TEMPLATE/plugin-registry.md',
  '.github/workflows/plugin-registry-validate.yml',
];

const PRODUCT_DOCS = [
  '.env.example',
  '.github/SECURITY.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'DATA_CONTRACT.md',
  'README.md',
  'providers/README.md',
];

const RUNTIME_FILES = [
  '.gitignore',
  'doctor.mjs',
  'src/scan/scan.mjs',
  'src/scan/validate-portals.mjs',
  'test-all.mjs',
  'update-system.mjs',
];

const RETIRED_SURFACE = [
  /config\/plugins/iu,
  /plugins\.local/iu,
  /plugins-registry/iu,
  /src\/plugins/iu,
  /plugin[- ](?:activation|audit|consent|engine|host|installation|registry|system)/iu,
  /(?:bundled|community|enabled|installed|job-producing|provider)[- ]plugins?/iu,
];

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

test('retired application plugin files and directories stay removed', () => {
  const present = REMOVED_PATHS.filter(path => existsSync(join(ROOT, path)));
  assert.deepEqual(present, []);
});

test('product documentation does not advertise the retired plugin system', () => {
  const files = [
    ...PRODUCT_DOCS.map(path => join(ROOT, path)),
    ...markdownFiles(join(ROOT, 'docs')),
  ];
  const matches = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of RETIRED_SURFACE) {
      if (pattern.test(source)) matches.push(`${file.slice(ROOT.length + 1)}: ${pattern}`);
    }
  }
  assert.deepEqual(matches, []);
});

test('runtime and updater manifests cannot revive the retired plugin system', () => {
  const matches = [];
  for (const path of RUNTIME_FILES) {
    const source = readFileSync(join(ROOT, path), 'utf8');
    for (const pattern of RETIRED_SURFACE) {
      if (pattern.test(source)) matches.push(`${path}: ${pattern}`);
    }
  }
  assert.deepEqual(matches, []);
});
