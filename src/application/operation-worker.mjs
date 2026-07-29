#!/usr/bin/env node

/**
 * Fixed backend owner for application operations.
 *
 * The supervising controller writes one validated request line and deliberately
 * keeps stdin open. Controller death closes that kernel pipe, which gives this
 * process an owner-death signal without persisting or later trusting a PID.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveApplicationOperation } from './operations.mjs';
import {
  shouldDetachProcessTree,
  signalProcessTree,
} from './process-tree.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;

export function runOperationWorker(options = {}) {
  const input = options.input ?? process.stdin;
  const spawn = options.spawn ?? nodeSpawn;
  const resolveOperation = options.resolveOperation ?? resolveApplicationOperation;
  const errorOutput = options.errorOutput ?? process.stderr;

  return new Promise((resolvePromise) => {
    let buffer = '';
    let launched = false;
    let child;
    let stopping = false;
    let settled = false;
    let forceTimer;

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      input.removeListener('data', onData);
      input.removeListener('end', ownerGone);
      input.removeListener('close', ownerGone);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', interrupted);
      input.pause?.();
      resolvePromise(Number.isInteger(code) ? code : 1);
    };

    const stop = () => {
      if (settled || stopping) return;
      stopping = true;
      if (!child) {
        finish(1);
        return;
      }
      signalProcessTree(child, 'SIGTERM', options);
      forceTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL', options);
        finish(1);
      }, options.terminationGraceMs ?? TERMINATION_GRACE_MS);
    };
    const ownerGone = () => stop();
    const interrupted = () => stop();

    const launch = (line) => {
      let request;
      try {
        request = JSON.parse(line);
        const spec = resolveOperation(request);
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: options.env ?? process.env,
          shell: false,
          windowsHide: true,
          detached: shouldDetachProcessTree(options.platform),
          stdio: ['ignore', 'inherit', 'inherit', 'inherit'],
        });
      } catch (error) {
        errorOutput.write(`${String(error?.message ?? error).replace(/[\0\r\n]+/gu, ' ').slice(0, 500)}\n`);
        finish(1);
        return;
      }
      launched = true;
      child.once('error', () => {
        if (!stopping) finish(1);
      });
      child.once('close', (code, signal) => {
        if (stopping) {
          // A direct backend can exit while one of its descendants ignores
          // SIGTERM. Keep the force timer armed against the original group.
        } else {
          finish(Number.isInteger(code) ? code : (signal ? 1 : 0));
        }
      });
    };

    function onData(chunk) {
      if (settled) return;
      const text = String(chunk);
      if (launched) {
        if (text.trim()) stop();
        return;
      }
      buffer += text;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        errorOutput.write('operation worker request is too large\n');
        finish(1);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      const trailing = buffer.slice(newline + 1);
      buffer = '';
      if (trailing.trim()) {
        errorOutput.write('operation worker accepts exactly one request\n');
        finish(1);
        return;
      }
      launch(line);
    }

    input.on('data', onData);
    input.once('end', ownerGone);
    input.once('close', ownerGone);
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
  });
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) process.exitCode = await runOperationWorker();
