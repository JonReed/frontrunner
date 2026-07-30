#!/usr/bin/env node

/**
 * Canonical launcher for the supported local UI.
 *
 * The UI is a separate package, so it cannot use the root package's `#paths`
 * import map. Passing the already-resolved root through a fixed environment
 * field removes the fragile `process.cwd()/..` assumption without bundling
 * backend modules into Next.js.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import {
  shouldDetachProcessTree,
  signalProcessTree,
} from './process-tree.mjs';

const UI_DIR = join(ROOT, 'ui');
const NEXT_CLI = join(UI_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
const COMMANDS = Object.freeze({
  // Turbopack cannot resolve the UI's intentional server-only imports from
  // the repository backend, and its CSS worker opens a loopback port during
  // production builds. Webpack supports that fixed boundary in both modes
  // and keeps local hooks usable inside hardened sandboxes.
  build: ['build', '--webpack'],
  dev: ['dev', '--webpack', '--hostname', '127.0.0.1', '-p', '3100'],
  start: ['start', '--hostname', '127.0.0.1', '-p', '3100'],
});

export function resolveUiLaunch(
  command,
  { dependencyExists = existsSync } = {},
) {
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error('UI command must be one of: dev, build, start');
  }
  if (!dependencyExists(NEXT_CLI)) {
    throw new Error('UI dependencies are missing. Run npm run ui:install first.');
  }
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([NEXT_CLI, ...COMMANDS[command]]),
    cwd: UI_DIR,
    env: Object.freeze({
      ...process.env,
      FRONTRUNNER_ROOT: ROOT,
    }),
  });
}

export async function main({ argv = process.argv.slice(2), spawn = nodeSpawn } = {}) {
  if (argv.length !== 1 || argv[0].startsWith('-')) {
    throw new Error('Usage: node src/application/ui-launch.mjs <dev|build|start>');
  }
  const spec = resolveUiLaunch(argv[0]);
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    windowsHide: true,
    detached: shouldDetachProcessTree(),
    stdio: 'inherit',
  });
  const onInterrupt = () => signalProcessTree(child, 'SIGINT');
  const onTerminate = () => signalProcessTree(child, 'SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    return await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => {
        process.exitCode = Number.isInteger(status) ? status : 1;
        resolveResult(Object.freeze({ status, signal }));
      });
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}
