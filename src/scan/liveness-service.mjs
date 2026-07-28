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
  let lastBrowserUrl = null;

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
      lastBrowserUrl = url;
      return { ...result, source: 'browser' };
    },
    async extract(url) {
      await ensureBrowser();
      if (lastBrowserUrl !== url) {
        const result = await checkUrlLivenessWithFallback(page, url, {
          getHeadedPage: headed ? () => headed.get() : undefined,
        });
        lastBrowserUrl = url;
        if (result.result === 'expired') return null;
      }
      const raw = await page.evaluate(() => {
        const title = (document.querySelector('h1')?.innerText || document.title || '').trim();
        const root = document.querySelector('main, [role="main"], article') || document.body;
        if (!root) return { title, text: '' };
        const clone = root.cloneNode(true);
        clone.querySelectorAll('script, style, nav, header, footer, noscript').forEach((element) => element.remove());
        return { title, text: clone.innerText || clone.textContent || '' };
      });
      const normalized = String(raw?.text ?? '').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      const text = normalized.length > 24_000 ? `${normalized.slice(0, 24_000)}…` : normalized;
      if (!text) return null;
      return {
        source: 'browser',
        finalUrl: page.url(),
        title: String(raw?.title ?? '').replace(/\s+/g, ' ').trim(),
        text,
      };
    },
    async close() {
      if (headed) await headed.close();
      if (browser) await browser.close();
      browser = undefined;
      page = undefined;
      headed = undefined;
      lastBrowserUrl = null;
    },
  };
}
