/**
 * Canonical liveness service: provider API first, Playwright only when the API
 * cannot decide. A checker instance reuses its browser across a pipeline run.
 */

import { checkLivenessViaApi } from './liveness-api.mjs';
import {
  checkUrlLivenessWithFallback,
  createHeadedPageProvider,
  newLivenessPage,
} from './liveness-browser.mjs';

export function createLivenessChecker({
  apiCheck = checkLivenessViaApi,
  loadChromium = async () => (await import('playwright')).chromium,
  allowHeadedFallback = false,
} = {}) {
  let browser;
  let page;
  let headed;

  async function ensureBrowser() {
    if (page) return;
    const chromium = await loadChromium();
    browser = await chromium.launch({ headless: true });
    page = await newLivenessPage(browser);
    headed = allowHeadedFallback ? createHeadedPageProvider(chromium) : null;
  }

  return {
    async check(url) {
      const api = await apiCheck(url);
      if (api) return { ...api, source: 'api' };
      await ensureBrowser();
      const result = await checkUrlLivenessWithFallback(page, url, {
        getHeadedPage: headed ? () => headed.get() : undefined,
      });
      return { ...result, source: 'browser' };
    },
    async close() {
      if (headed) await headed.close();
      if (browser) await browser.close();
      browser = undefined;
      page = undefined;
      headed = undefined;
    },
  };
}
