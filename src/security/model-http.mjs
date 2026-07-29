/**
 * Bounded JSON transport for model APIs.
 *
 * Public endpoints use the DNS-pinned remote broker. Loopback endpoints are a
 * separate explicit capability for local Ollama/OpenAI-compatible servers:
 * they never redirect and cannot be confused with public-web access.
 */

import { fetchJson, readBodyLimited } from '../../providers/_http.mjs';

const NATIVE_FETCH = globalThis.fetch;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackModelUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function fetchLoopbackJson(url, {
  timeoutMs,
  maxResponseBytes,
  fetchImpl,
  ...options
}) {
  if (!isLoopbackModelUrl(url)) throw new Error('local model transport requires a loopback URL');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
    });
    const text = await readBodyLimited(
      response,
      response.ok ? maxResponseBytes : Math.min(maxResponseBytes, 64 * 1024),
    );
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('HTTP response is not valid JSON');
    }
  } catch (error) {
    if (controller.signal.aborted && error?.name === 'AbortError') {
      const timeoutError = new Error(`HTTP request timed out after ${timeoutMs}ms`);
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function requestModelJson(url, {
  timeoutMs = 300_000,
  maxResponseBytes = 2 * 1024 * 1024,
  fetchImpl = NATIVE_FETCH,
  ...options
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('model HTTP timeout must be a positive integer');
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error('model HTTP response limit must be a positive integer');
  }
  if (isLoopbackModelUrl(url)) {
    return fetchLoopbackJson(url, {
      ...options,
      timeoutMs,
      maxResponseBytes,
      fetchImpl,
    });
  }
  return fetchJson(url, {
    ...options,
    timeoutMs,
    maxResponseBytes,
    fetchImpl,
    redirect: 'error',
  });
}
