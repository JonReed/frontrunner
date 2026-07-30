import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';

const TOP_LEVEL = [
  'AGENTS.md',
  'CONTRIBUTING.md',
  'DATA_CONTRACT.md',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
];

const DOC_TREES = [
  'batch',
  'config/seeds',
  'cv-versions',
  'docs',
  'workspace/interviews/sessions',
  'providers',
  'templates',
  'tests',
  'writing-samples',
];

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function linkTarget(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    const close = trimmed.indexOf('>');
    return close === -1 ? trimmed : trimmed.slice(1, close);
  }
  return trimmed.split(/\s+["']/u, 1)[0];
}

const maintainedDocs = () => [
  ...TOP_LEVEL.map(path => join(ROOT, path)),
  ...DOC_TREES.flatMap(path => markdownFiles(join(ROOT, path))),
];

test('maintained Markdown links resolve to files inside the repository', () => {
  const files = maintainedDocs();
  const failures = [];
  const rootPrefix = `${resolve(ROOT)}${sep}`;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/gu)) {
      const rawTarget = linkTarget(match[1]);
      if (
        !rawTarget
        || rawTarget.startsWith('#')
        || /^[a-z][a-z0-9+.-]*:/iu.test(rawTarget)
        || rawTarget.includes('{')
        || /(?:\.\.\.|…)/u.test(rawTarget)
      ) {
        continue;
      }
      let decoded;
      try {
        decoded = decodeURIComponent(rawTarget.split(/[?#]/u, 1)[0]);
      } catch {
        failures.push(`${file.slice(ROOT.length + 1)}: malformed link ${rawTarget}`);
        continue;
      }
      const destination = decoded.startsWith('/')
        ? resolve(ROOT, `.${decoded}`)
        : resolve(dirname(file), decoded);
      if (
        destination !== resolve(ROOT)
        && !destination.startsWith(rootPrefix)
      ) {
        failures.push(`${file.slice(ROOT.length + 1)}: link escapes repository: ${rawTarget}`);
      } else if (!existsSync(destination)) {
        failures.push(`${file.slice(ROOT.length + 1)}: missing ${rawTarget}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('documented Node paths and npm scripts exist', () => {
  const failures = [];
  const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  for (const file of maintainedDocs()) {
    const relative = file.slice(ROOT.length + 1);
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(/\bnode\s+([a-z0-9_./-]+\.mjs)\b/giu)) {
      if (!existsSync(join(ROOT, match[1]))) {
        failures.push(`${relative}: missing Node entry point ${match[1]}`);
      }
    }
    for (const match of source.matchAll(/\bnpm\s+run\s+([a-z0-9:_-]+)/giu)) {
      if (!rootPackage.scripts?.[match[1]]) {
        failures.push(`${relative}: missing npm script ${match[1]}`);
      }
    }
    for (const match of source.matchAll(
      /\bnpm\s+(?:-C|--prefix)\s+([a-z0-9_./-]+)\s+run\s+([a-z0-9:_-]+)/giu,
    )) {
      const packagePath = join(ROOT, match[1], 'package.json');
      if (!existsSync(packagePath)) {
        failures.push(`${relative}: missing package ${match[1]}/package.json`);
        continue;
      }
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (!pkg.scripts?.[match[2]]) {
        failures.push(`${relative}: ${match[1]} has no npm script ${match[2]}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});
