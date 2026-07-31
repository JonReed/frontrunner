/**
 * browser-health.mjs — is the PDF renderer actually able to run?
 *
 * Building a tailored CV ends in Playwright rendering HTML to a PDF, and the
 * browser that does it is a separate ~150 MB download that `npm install` does
 * not perform. So the one action in the product that spends the user's AI
 * allowance had an unchecked dependency: the model call succeeded, the money
 * was gone, and the run then failed at the last step with a stack trace.
 *
 * Two functions, mirroring the sign-in pair in health-control.mjs, and for the
 * same reason. Checking is cheap enough to do before offering the button;
 * installing is slow enough that it has to be started and polled rather than
 * awaited.
 *
 * INSTALLING IS A BUTTON, NOT AN INSTRUCTION. Telling this product's user to
 * run `npm run browser:install` is telling them to open a terminal, which the
 * project's own constraints rule out. The command is fixed here, takes nothing
 * from the request, and is the same one the documentation would have named.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';
import { shouldDetachProcessTree } from './process-tree.mjs';

const PLAYWRIGHT_CLI = join(ROOT, 'node_modules', 'playwright', 'cli.js');
const LAUNCH_TIMEOUT_MS = 20_000;

/**
 * Whether a browser can actually be launched.
 *
 * Launching rather than checking `executablePath()` for the reason doctor.mjs
 * already documents: the path points at Chrome for Testing while `launch()`
 * may use the headless shell, which installs separately. A stub install —
 * directory present, no binary — passes a path check and fails a launch, and
 * the failure is what the CV build would hit.
 */
export async function readBrowserStatus({ importPlaywright = () => import('playwright') } = {}) {
  let chromium;
  try {
    ({ chromium } = await importPlaywright());
  } catch {
    return { installed: false, reason: 'missing-package' };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS });
    return { installed: true, reason: null };
  } catch {
    return { installed: false, reason: 'missing-browser' };
  } finally {
    try {
      await browser?.close();
    } catch {
      // A browser that will not close cleanly has already answered the
      // question this function exists to ask.
    }
  }
}

/**
 * Start the browser download and return immediately.
 *
 * Detached and unref'd, like the sign-in flow: it takes minutes on a slow
 * connection, and neither closing the tab nor Next.js reloading the module
 * should leave a half-finished install behind. The UI polls the status above
 * until it flips.
 */
export function startBrowserInstall({ spawn = nodeSpawn, platform } = {}) {
  if (!existsSync(PLAYWRIGHT_CLI)) return { started: false };
  try {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, 'install', 'chromium'], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      detached: shouldDetachProcessTree(platform),
      stdio: 'ignore',
    });
    child.unref?.();
    return { started: true };
  } catch {
    return { started: false };
  }
}
