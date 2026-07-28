// tests/providers/http-timeout.test.mjs — the abort timeout must cover the
// BODY read, not just the header phase. A server that sends headers and then
// stalls the body used to hang fetchJson forever, which could silently freeze
// a full-directory sweep partway through with no error output.
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from '../helpers.mjs';

console.log('\nProvider — _http timeout');

const { fetchJson, fetchText } = await import(pathToFileURL(join(ROOT, 'providers/_http.mjs')).href);

// Independent upper bound: if the mechanism under test regresses and the call
// never settles, this makes the test fail fast (hitting the elapsed assertion)
// instead of reintroducing the very silent hang this suite guards against.
// Set well above the 300ms request timeout but bounded far below a real hang.
function hardTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: hard test timeout after ${ms}ms — regression suspected`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));  // else the loser keeps the loop alive to `ms`
}

// Bounded allowance over the 300ms request timeout: loose enough for a slow CI
// runner, tight enough that a multi-second stalled-body regression still fails.
const MAX_ABORT_MS = 1_500;

const stalledFetch = async (_url, { signal }) => {
  const stall = () =>
    new Promise((_, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: stall,
    text: stall,
  };
};

const completedFetch = async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Headers(),
  async json() { return { ok: true }; },
  async text() { return '{"ok":true}'; },
});

// 1. Stalled body must abort within the timeout window, not hang.
{
  const t0 = Date.now();
  try {
    await hardTimeout(fetchJson('https://example.test/stall', { timeoutMs: 300, fetchImpl: stalledFetch }), 8_000, 'fetchJson /stall');
    fail('fetchJson resolved on a stalled body');
  } catch {
    const elapsed = Date.now() - t0;
    if (elapsed < MAX_ABORT_MS) pass(`fetchJson aborted stalled body read in ${elapsed}ms`);
    else fail(`fetchJson took ${elapsed}ms to abort a stalled body (timeout not covering body read)`);
  }
}

// 2. Same for fetchText.
{
  const t0 = Date.now();
  try {
    await hardTimeout(fetchText('https://example.test/stall', { timeoutMs: 300, fetchImpl: stalledFetch }), 8_000, 'fetchText /stall');
    fail('fetchText resolved on a stalled body');
  } catch {
    const elapsed = Date.now() - t0;
    if (elapsed < MAX_ABORT_MS) pass(`fetchText aborted stalled body read in ${elapsed}ms`);
    else fail(`fetchText took ${elapsed}ms to abort a stalled body`);
  }
}

// 3. Happy path still works after the refactor.
{
  const ok = await fetchJson('https://example.test/ok', { timeoutMs: 2_000, fetchImpl: completedFetch });
  if (ok && ok.ok === true) pass('fetchJson still parses a completed body');
  else fail(`fetchJson happy path broken: ${JSON.stringify(ok)}`);
}
