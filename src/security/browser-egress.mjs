/**
 * Canonical Playwright egress boundary for hostile public web content.
 *
 * Every remote navigation must validate the initial URL, every redirect and
 * every subresource against the same DNS-aware policy. Callers may observe a
 * block, but cannot weaken the policy.
 */

import {
  assertSafeRemoteUrl,
  resolvePublicAddresses,
} from './remote-target-policy.mjs';

const INSTALLED = Symbol('frontrunner.browserEgressInstalled');

export function createRemoteHostnameResolver() {
  const cache = new Map();
  return hostname => {
    if (!cache.has(hostname)) cache.set(hostname, resolvePublicAddresses(hostname));
    return cache.get(hostname);
  };
}

export async function installBrowserEgressGuard(target, {
  resolveHostname = createRemoteHostnameResolver(),
  onBlocked,
} = {}) {
  if (!target || typeof target.route !== 'function') {
    throw new TypeError('browser egress target must provide route()');
  }
  if (target[INSTALLED]) return target[INSTALLED];

  const state = { blocked: null, resolveHostname };
  Object.defineProperty(target, INSTALLED, { value: state });
  await target.route('**/*', async (route) => {
    const url = route.request().url();
    try {
      await assertSafeRemoteUrl(url, { resolveHostname });
      return route.continue();
    } catch (error) {
      const blocked = {
        url,
        code: error?.code ?? 'blocked_host',
        reason: error?.message ?? 'remote target blocked',
      };
      state.blocked = blocked;
      await onBlocked?.(blocked);
      return route.abort('blockedbyclient');
    }
  });
  return state;
}

export async function createGuardedBrowserContext(browser, {
  contextOptions = {},
  resolveHostname = createRemoteHostnameResolver(),
  onBlocked,
} = {}) {
  const context = await browser.newContext(contextOptions);
  await installBrowserEgressGuard(context, { resolveHostname, onBlocked });
  return context;
}

export async function navigateGuardedPage(page, url, gotoOptions = {}, {
  resolveHostname = createRemoteHostnameResolver(),
  onBlocked,
} = {}) {
  try {
    await assertSafeRemoteUrl(url, { resolveHostname });
  } catch (error) {
    await onBlocked?.({
      url,
      code: error?.code ?? 'blocked_host',
      reason: error?.message ?? 'remote target blocked',
    });
    throw error;
  }
  const state = await installBrowserEgressGuard(page, { resolveHostname, onBlocked });
  state.blocked = null;
  const response = await page.goto(url, gotoOptions);
  if (state.blocked) {
    const error = new Error(`browser egress blocked ${state.blocked.url}: ${state.blocked.reason}`);
    error.code = state.blocked.code;
    throw error;
  }
  const finalUrl = typeof page.url === 'function' ? page.url() : url;
  await assertSafeRemoteUrl(finalUrl, { resolveHostname });
  return response;
}
