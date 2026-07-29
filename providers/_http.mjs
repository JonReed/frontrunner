// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by src/scan/scan.mjs.

// Keep the process-wide cache for legacy/direct Node fetch users. Brokered
// provider requests below use their own validated, connection-pinned lookup.
import './_dns-cache.mjs';
import http from 'node:http';
import https from 'node:https';
import { STATUS_CODES } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import {
  assertSafeRemoteUrl,
  inspectRemoteUrl,
  resolveSafeRemoteTarget,
} from '../src/security/remote-target-policy.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.3)';
const NATIVE_FETCH = globalThis.fetch;

function pinnedLookup(addresses) {
  const records = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    const opts = typeof options === 'number' ? { family: options } : (options ?? {});
    const matching = opts.family ? records.filter((record) => record.family === opts.family) : records;
    if (!matching.length) {
      const error = new Error(`validated DNS addresses do not include IPv${opts.family}`);
      error.code = 'ENOTFOUND';
      process.nextTick(callback, error);
    } else if (opts.all) {
      process.nextTick(callback, null, matching);
    } else {
      process.nextTick(callback, null, matching[0].address, matching[0].family);
    }
  };
}

function requestPinned(url, { method, headers, body, signal }, addresses) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method,
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        'accept-encoding': 'identity',
        ...headers,
      },
      lookup: pinnedLookup(addresses),
      signal,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value != null) {
          responseHeaders.set(name, value);
        }
      }
      resolve({
        ok: (incoming.statusCode ?? 0) >= 200 && (incoming.statusCode ?? 0) < 300,
        status: incoming.statusCode ?? 0,
        statusText: STATUS_CODES[incoming.statusCode ?? 0] ?? '',
        headers: responseHeaders,
        body: Readable.toWeb(incoming),
      });
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

/**
 * Browser-like User-Agent for providers that must clear WAF/CDN bot
 * management blocking the default career-ops UA outright (seen live:
 * Glints' firewall, Geico's Cloudflare-gated Workday tenant). Shared so
 * every provider working around such a block bumps one constant instead
 * of drifting Chrome versions independently per file.
 */
export const BROWSER_LIKE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchWithTimeout(
  url,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    method = 'GET',
    body = null,
    redirect = 'error',
    fetchImpl = globalThis.fetch,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    resolveHostname,
  } = {},
  consume,
) {
  const rejected = inspectRemoteUrl(url);
  if (rejected) throw new Error(`Egress denied: ${rejected.reason}`);
  const usePinnedTransport = fetchImpl === NATIVE_FETCH && !resolveHostname;
  let safeTarget = usePinnedTransport
    ? await resolveSafeRemoteTarget(url)
    : null;
  if (!usePinnedTransport && (fetchImpl === NATIVE_FETCH || resolveHostname)) {
    await assertSafeRemoteUrl(url, { ...(resolveHostname ? { resolveHostname } : {}) });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = String(url);
    let res;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = usePinnedTransport
        ? await requestPinned(safeTarget.url, {
          method,
          headers,
          body,
          signal: controller.signal,
        }, safeTarget.addresses)
        : await fetchImpl(currentUrl, {
          method,
          headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
          body,
          redirect: redirect === 'follow' ? 'manual' : redirect,
          signal: controller.signal,
        });
      if (redirect !== 'follow' || ![301, 302, 303, 307, 308].includes(res.status)) break;
      if (hop === MAX_REDIRECTS) throw new Error(`HTTP redirect limit exceeded (${MAX_REDIRECTS})`);
      const location = res.headers.get('location');
      if (!location) throw new Error(`HTTP ${res.status} redirect without Location`);
      await res.body?.cancel?.('following redirect').catch(() => {});
      currentUrl = new URL(location, currentUrl).href;
      const redirectRejected = inspectRemoteUrl(currentUrl);
      if (redirectRejected) throw new Error(`Egress denied on redirect: ${redirectRejected.reason}`);
      if (usePinnedTransport) {
        safeTarget = await resolveSafeRemoteTarget(currentUrl);
      } else if (fetchImpl === NATIVE_FETCH || resolveHostname) {
        await assertSafeRemoteUrl(currentUrl, { ...(resolveHostname ? { resolveHostname } : {}) });
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = null;
      }
    }
    if (!res.ok) {
      const responseText = await readBodyLimited(res, Math.min(maxResponseBytes, 64 * 1024)).catch(() => '');
      // WAF/CDN challenge pages (seen live: Workday 429s) carry no actionable
      // text — HTML markup or a generic interstitial message, not worth
      // parsing or displaying. The status code and its standard reason
      // phrase are what a log line needs; the raw body is still attached as
      // err.body for callers that want to inspect it.
      const err = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
      err.status = res.status;
      err.body = responseText;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    // Body consumption must stay inside the timer window: a server that sends
    // headers and then stalls the body otherwise hangs the caller forever
    // (this froze full-directory sweeps silently — 20 workers all stuck on
    // stalled reads with the abort timer already cleared).
    return await consume(res, maxResponseBytes);
  } finally {
    clearTimeout(timer);
  }
}

export async function readBodyLimited(res, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxResponseBytes must be a positive integer');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`HTTP response exceeds ${maxBytes} byte limit`);
  }
  if (!res.body?.getReader) {
    if (typeof res.arrayBuffer === 'function') {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} byte limit`);
      return new TextDecoder().decode(bytes);
    }
    // Small provider test doubles and a few alternate fetch implementations
    // expose only text()/json(). Keep them compatible while still enforcing
    // the limit after decoding; real Node Response bodies use the streaming
    // branch above and are stopped before excess bytes are buffered.
    if (typeof res.text === 'function') {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} byte limit`);
      return text;
    }
    throw new Error('HTTP response body is not readable');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('response too large').catch(() => {});
      throw new Error(`HTTP response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchJson(url, opts = {}) {
  return fetchWithTimeout(url, opts, async (res, maxBytes) => {
    const text = await readBodyLimited(res, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('HTTP response is not valid JSON');
    }
  });
}

export async function fetchText(url, opts = {}) {
  return fetchWithTimeout(url, opts, (res, maxBytes) => readBodyLimited(res, maxBytes));
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
