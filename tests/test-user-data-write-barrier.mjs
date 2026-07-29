/**
 * Process-wide filesystem barrier loaded by test-all and all of its Node
 * subprocesses. This catches inherited direct fs writes that have not yet
 * migrated to replaceFileAtomic().
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { assertTestUserDataWriteAllowed } from '../src/lib/test-user-data-policy.mjs';

const INSTALLED = Symbol.for('frontrunner.testUserDataWriteBarrier');

function pathValue(value) {
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  return value;
}

function guard(value) {
  assertTestUserDataWriteAllowed(pathValue(value));
}

function writingFlags(flags) {
  if (typeof flags === 'number') {
    const writeBits = fs.constants.O_WRONLY
      | fs.constants.O_RDWR
      | fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | fs.constants.O_TRUNC;
    return (flags & writeBits) !== 0;
  }
  return /[wax+]/u.test(String(flags ?? 'r'));
}

function wrap(target, name, indexes = [0]) {
  const original = target?.[name];
  if (typeof original !== 'function') return;
  target[name] = function guardedWrite(...args) {
    for (const index of indexes) guard(args[index]);
    return original.apply(this, args);
  };
}

function installOn(target) {
  for (const name of [
    'appendFile',
    'appendFileSync',
    'chmod',
    'chmodSync',
    'chown',
    'chownSync',
    'lchmod',
    'lchmodSync',
    'lchown',
    'lchownSync',
    'lutimes',
    'lutimesSync',
    'mkdir',
    'mkdirSync',
    'mkdtemp',
    'mkdtempSync',
    'rm',
    'rmSync',
    'rmdir',
    'rmdirSync',
    'truncate',
    'truncateSync',
    'unlink',
    'unlinkSync',
    'utimes',
    'utimesSync',
    'writeFile',
    'writeFileSync',
  ]) wrap(target, name);
  for (const name of ['rename', 'renameSync', 'link', 'linkSync']) {
    wrap(target, name, [0, 1]);
  }
  for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'symlink', 'symlinkSync']) {
    wrap(target, name, [1]);
  }
}

export function installTestUserDataWriteBarrier() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  installOn(fs);
  installOn(fs.promises);

  for (const name of ['open', 'openSync']) {
    const original = fs[name];
    fs[name] = function guardedOpen(path, flags, ...rest) {
      if (writingFlags(flags)) guard(path);
      return original.call(this, path, flags, ...rest);
    };
  }
  const originalCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function guardedCreateWriteStream(path, options) {
    guard(path);
    return originalCreateWriteStream.call(this, path, options);
  };
  syncBuiltinESMExports();
}

if (process.env.FRONTRUNNER_TEST_PROTECTED_ROOT) {
  installTestUserDataWriteBarrier();
}
