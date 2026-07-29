/**
 * liveness-browser.mjs — Playwright-driven liveness check for a single URL.
 *
 * Shared by check-liveness.mjs (CLI tool) and scan.mjs (--verify flag).
 * Returns the same shape as classifyLiveness: { result, reason }.
 */

import { classifyLiveness } from './liveness-core.mjs';
import {
  inspectRemoteUrl,
  resolvePublicAddresses,
} from '../security/remote-target-policy.mjs';
import { navigateGuardedPage } from '../security/browser-egress.mjs';

const NAVIGATE_TIMEOUT_MS = 15_000;
const HYDRATION_WAIT_MS = 2_000;

// The default Playwright headless UA contains "HeadlessChrome", which Cloudflare
// and similar WAFs flag — portals like pracuj.pl then serve a 403 challenge page
// instead of the posting. Presenting a normal desktop Chrome UA clears the wall
// headlessly (the scan parser scripts/parsers/pracuj-jobs.mjs relies on the same
// trick), so the common case never needs the slower headed-browser fallback.
export const LIVENESS_CONTEXT_OPTIONS = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'en-US',
};

// Open a page in a context that already presents a realistic UA. Both callers use
// this instead of browser.newPage() so headless checks aren't instantly bot-walled.
export async function newLivenessPage(browser) {
  const context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
  return context.newPage();
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throttle delay with jitter: a value in [baseMs, 2*baseMs). Spacing requests out
// (and randomizing the gap) keeps a bulk run under rate-based WAF thresholds —
// pracuj.pl's Cloudflare flags the session after ~2 rapid hits, after which even
// headed retries are blocked. A randomized gap also avoids a fixed-cadence
// fingerprint. Returns 0 for a non-positive base (throttling disabled).
export function jitteredDelayMs(baseMs) {
  if (!baseMs || baseMs <= 0) return 0;
  return baseMs + Math.floor(Math.random() * baseMs);
}

// Defensive guards: URLs come from ATS feeds (mostly trusted) but a misconfigured
// portals.yml entry or a hijacked feed shouldn't be able to point Playwright at
// internal infrastructure. Only allow http(s) and reject loopback/private/link-local.
//
// The hostname coming out of `new URL(...)` needs normalization before the regex
// pass, because the WHATWG URL parser surfaces several encodings that bypass a
// naive match against `parsed.hostname`:
//   1. IPv6 hosts are serialized with brackets — `new URL('http://[::1]/').hostname`
//      is `'[::1]'`, so a regex like `/^::1$/` never fires unless brackets are stripped.
//   2. FQDN trailing dot is preserved — `localhost.` reaches the network as
//      localhost, but `/^localhost$/` doesn't match it.
//   3. IPv4-mapped IPv6 (`::ffff:127.0.0.1` or the hex form `::ffff:7f00:1`)
//      routes to the embedded IPv4 in Chromium, so the embedded address must
//      also be matched against the IPv4 block list.
// `0.0.0.0` and the all-zeros IPv6 `::` both reach loopback on Linux and need
// explicit entries; the original list omitted them.
// Returns null when the URL is safe to fetch, otherwise a structured guard
// result with a stable `code` (used for routing in scan.mjs) plus a human
// `reason`. Stable codes — not regex on reason strings — drive downstream
// dispatch so the wording can change freely without breaking callers.
//
// Exported for unit tests; the main entry point is checkUrlLiveness.
export function rejectPrivateOrInvalid(url) {
  return inspectRemoteUrl(url);
}

const dnsCache = new Map();
async function resolveDnsCached(hostname) {
  if (!dnsCache.has(hostname)) dnsCache.set(hostname, resolvePublicAddresses(hostname));
  return dnsCache.get(hostname);
}

export async function checkUrlLiveness(
  page,
  url,
  { extraSettleMs = 0, resolveHostname = resolveDnsCached } = {},
) {
  const guardError = rejectPrivateOrInvalid(url);
  if (guardError) {
    return { result: 'uncertain', code: guardError.code, reason: guardError.reason };
  }
  if (page) {
    page._blockedByGuard = null;
  }
  try {
    const response = await navigateGuardedPage(
      page,
      url,
      { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS },
      {
        resolveHostname,
        onBlocked(blocked) {
          console.warn(`Blocked request to restricted destination: ${blocked.url} - ${blocked.reason}`);
          page._blockedByGuard = {
            // Liveness exposes one stable public outcome for all egress-policy
            // failures; the detailed broker reason still distinguishes a
            // literal host block from a DNS-resolved private address.
            code: 'blocked_host',
            reason: blocked.reason,
          };
        },
      },
    );
    const status = response?.status() ?? 0;

    // Give SPAs (Ashby, Lever, Workday) time to hydrate. extraSettleMs adds slack
    // for the headed retry, where a JS anti-bot interstitial needs a moment to clear.
    await page.waitForTimeout(HYDRATION_WAIT_MS + extraSettleMs);

    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const applyControls = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]')
      );

      return candidates
        .filter((element) => {
          if (element.closest('nav, header, footer')) return false;
          if (element.closest('[aria-hidden="true"]')) return false;

          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (!element.getClientRects().length) return false;

          return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
        })
        .map((element) => {
          const label = [
            element.innerText,
            element.value,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
          ]
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          return label;
        })
        .filter(Boolean);
    });

    if (page && page._blockedByGuard) {
      return { result: 'uncertain', code: page._blockedByGuard.code, reason: page._blockedByGuard.reason };
    }

    return classifyLiveness({ status, requestedUrl: url, finalUrl, bodyText, applyControls });
  } catch (err) {
    if (page && page._blockedByGuard) {
      return { result: 'uncertain', code: page._blockedByGuard.code, reason: page._blockedByGuard.reason };
    }
    // Transient failures (timeout, DNS, TLS, 5xx) shouldn't be treated as expired —
    // doing so would cause scan --verify to drop the URL and write it to scan-history,
    // permanently filtering it out on subsequent scans.
    return {
      result: 'uncertain',
      code: 'navigation_error',
      reason: `navigation error: ${err.message.split('\n')[0]}`,
    };
  }
}

// Anti-bot results that a headed browser may be able to get past. A real (headed)
// Chromium clears the JS/Cloudflare challenge that headless trips on (e.g. pracuj.pl).
const CHALLENGE_CODES = new Set(['bot_challenge', 'access_blocked']);

export function isChallengeResult(result) {
  return result?.result === 'uncertain' && CHALLENGE_CODES.has(result.code);
}

// Lazily owns a single headed browser/page, created only on first use and reused
// across URLs. Headed Chromium needs a display, so launch can fail in headless/CI
// environments — in that case get() returns null and callers degrade to the
// headless result (challenge stays uncertain, never falsely expired).
export function createHeadedPageProvider(chromium) {
  let browser = null;
  let page = null;
  let launchFailed = false;
  return {
    async get() {
      if (page) return page;
      if (launchFailed) return null;
      try {
        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
        page = await context.newPage();
        return page;
      } catch {
        launchFailed = true;
        browser = null;
        page = null;
        return null;
      }
    },
    async close() {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // best-effort teardown
        }
      }
      browser = null;
      page = null;
    },
  };
}

// Runs the headless check, then retries once in a headed browser if the page was
// blocked by an anti-bot wall. The headed result wins when it actually sees the
// page; if the retry is still blocked (or no headed page is available) the
// original uncertain result is kept — we never upgrade a block to expired.
export async function checkUrlLivenessWithFallback(
  page,
  url,
  { getHeadedPage, resolveHostname } = {},
) {
  const first = await checkUrlLiveness(page, url, { resolveHostname });
  if (!getHeadedPage || !isChallengeResult(first)) {
    return first;
  }
  const headedPage = await getHeadedPage();
  if (!headedPage) {
    return first;
  }
  const second = await checkUrlLiveness(headedPage, url, {
    extraSettleMs: 3_000,
    resolveHostname,
  });
  if (isChallengeResult(second)) {
    return { ...second, reason: `${second.reason} (headed retry also blocked)` };
  }
  return second;
}
