/**
 * Platform-aware process-tree termination for supervised application jobs.
 *
 * POSIX children are launched as process-group leaders, allowing one negative
 * PID signal to reach the backend and every descendant it has spawned. Windows
 * uses the fixed system taskkill executable with /T; no request data can affect
 * the executable or flags.
 */

import { spawnSync } from 'node:child_process';

export function shouldDetachProcessTree(platform = process.platform) {
  return platform !== 'win32';
}

function killWindowsTree(pid, force) {
  const result = spawnSync(
    'taskkill.exe',
    ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
    {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    },
  );
  return !result.error && result.status === 0;
}

/**
 * Signal the entire backend process tree, falling back to the direct child
 * when group/tree signalling is unavailable.
 */
export function signalProcessTree(child, signal, options = {}) {
  const pid = Number(child?.pid);
  const platform = options.platform ?? process.platform;
  const processKill = options.processKill ?? process.kill.bind(process);
  const windowsTreeKill = options.windowsTreeKill ?? killWindowsTree;

  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      if (platform === 'win32') {
        if (windowsTreeKill(pid, signal === 'SIGKILL')) return true;
      } else {
        processKill(-pid, signal);
        return true;
      }
    } catch {
      // Fall through to the direct child. It still gives the caller the
      // strongest termination available on a constrained host.
    }
  }

  try {
    return child?.kill(signal) !== false;
  } catch {
    return false;
  }
}
