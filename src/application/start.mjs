#!/usr/bin/env node

/**
 * start.mjs — open Frontrunner, the way someone opens it on day two.
 *
 * The documented way to run this product was `npm run ui`, which is
 * `next dev` in a terminal window the user has to keep open and know how to
 * reopen tomorrow. For the person this is built for that is not a startup
 * command, it is a reason to stop using it — and the project's own constraints
 * say anything that needs a command line is unfinished.
 *
 * What this does, in order, saying so as it goes:
 *
 *   1. Check the interface's dependencies are installed.
 *   2. Build it if it has never been built, or if the source has moved on.
 *   3. Start the production server on loopback.
 *   4. Wait for it to accept a connection, then open the browser.
 *
 * PRODUCTION, NOT DEV. `next dev` recompiles every page on first visit, which
 * makes an already-slow first impression slower, and ships a development
 * overlay to someone who will read it as an error. `next start` serves a build
 * — the build is the cost, and it is paid once per update rather than once per
 * page.
 *
 * The server is a child of this process and is stopped with it, so closing the
 * launcher closes Frontrunner. Leaving a loopback server running after someone
 * thinks they have quit is the kind of thing that is only ever discovered by
 * accident.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { resolveUiLaunch } from './ui-launch.mjs';
import { shouldDetachProcessTree, signalProcessTree } from './process-tree.mjs';

const UI_DIR = join(ROOT, 'ui');
const BUILD_ID = join(UI_DIR, '.next', 'BUILD_ID');
const HOST = '127.0.0.1';
const PORT = 3100;
const URL = `http://${HOST}:${String(PORT)}`;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 300;

/**
 * Which browser command opens a URL here.
 *
 * Fixed per platform and passed a single argument that this process built, so
 * nothing the user or a job advert supplies can reach it. `cmd /c start` needs
 * the empty string first — otherwise Windows treats the URL as a window title.
 */
function browserCommand(platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [URL] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', URL] };
  return { command: 'xdg-open', args: [URL] };
}

/**
 * Whether the existing build is older than the source it was built from.
 *
 * A cheap newest-mtime comparison rather than a content hash. Getting this
 * wrong in the safe direction costs a rebuild; getting it wrong in the other
 * direction serves someone yesterday's interface after an update, which is the
 * failure that would be blamed on the update rather than on this.
 */
function newestSourceTime(dir, deadline = Date.now() + 2_000) {
  let newest = 0;
  let complete = true;
  const walk = (current) => {
    if (Date.now() > deadline) {
      // Abandoning the walk leaves `newest` as a partial maximum, which reads
      // as "older than the build" — exactly the wrong answer. Say the walk did
      // not finish so the caller can fail the safe way instead.
      complete = false;
      return;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      try {
        const { mtimeMs } = statSync(path);
        if (mtimeMs > newest) newest = mtimeMs;
      } catch {
        // A file that vanished mid-walk cannot be the newest one that matters.
      }
    }
  };
  walk(dir);
  return complete ? newest : Infinity;
}

export function buildIsStale({
  buildId = BUILD_ID,
  sourceDir = join(UI_DIR, 'src'),
} = {}) {
  if (!existsSync(buildId)) return true;
  try {
    // Every uncertain answer resolves to "stale". Being wrong that way costs a
    // rebuild; being wrong the other way serves someone yesterday's interface
    // after an update, and the update gets the blame.
    return newestSourceTime(sourceDir) > statSync(buildId).mtimeMs;
  } catch {
    return true;
  }
}

/** Resolve once the server accepts a connection, or reject on the deadline. */
export function waitForServer({
  host = HOST,
  port = PORT,
  timeoutMs = READY_TIMEOUT_MS,
  pollMs = READY_POLL_MS,
  now = () => Date.now(),
  connectTo = connect,
} = {}) {
  const deadline = now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connectTo({ host, port });
      const retry = () => {
        socket.destroy();
        if (now() > deadline) {
          reject(new Error('Frontrunner did not finish starting in time.'));
          return;
        }
        setTimeout(attempt, pollMs);
      };
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', retry);
    };
    attempt();
  });
}

function run(spec, { spawn = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`Preparing Frontrunner failed (exit ${String(code)}).`));
    });
  });
}

export async function main({ spawn = nodeSpawn, log = console.log } = {}) {
  // resolveUiLaunch fails with the exact remedy when dependencies are absent,
  // so let it be the one place that knows about them.
  const startSpec = resolveUiLaunch('start');

  if (buildIsStale()) {
    log('Preparing Frontrunner. This happens after an update and takes a minute…');
    await run(resolveUiLaunch('build'), { spawn });
  }

  log('Starting Frontrunner…');
  const server = spawn(startSpec.command, [...startSpec.args], {
    cwd: startSpec.cwd,
    env: startSpec.env,
    shell: false,
    windowsHide: true,
    detached: shouldDetachProcessTree(),
    stdio: 'inherit',
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    signalProcessTree(server, 'SIGTERM');
    // The server owns a port. If it will not go quietly, take it down rather
    // than leave a loopback listener behind a window the user has closed.
    setTimeout(() => signalProcessTree(server, 'SIGKILL'), 3_000).unref?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('close', (code) => {
    process.exitCode = code ?? 0;
  });

  try {
    await waitForServer();
  } catch (error) {
    stop();
    throw error;
  }

  log(`Frontrunner is ready at ${URL}`);
  try {
    const opener = browserCommand();
    spawn(opener.command, opener.args, {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    }).unref?.();
  } catch {
    // No browser could be launched — the address is already printed above,
    // which is all the user needs to open one themselves.
  }
  log('Leave this window open while you use Frontrunner. Close it to quit.');
  return server;
}

const direct = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
