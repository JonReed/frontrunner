import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import {
  installBrowserEgressGuard,
  navigateGuardedPage,
} from '../../src/security/browser-egress.mjs';

function routeFor(url, counters) {
  return {
    request: () => ({ url: () => url }),
    continue: async () => { counters.continued++; },
    abort: async () => { counters.aborted++; },
  };
}

test('destructive browser boundary blocks DNS rebinding on initial navigation', async () => {
  let gotoCalls = 0;
  const page = {
    route: async () => {},
    goto: async () => { gotoCalls++; },
    url: () => 'https://jobs.example/role',
  };
  await assert.rejects(
    navigateGuardedPage(page, 'https://jobs.example/role', {}, {
      resolveHostname: async () => ['127.0.0.1'],
    }),
    /restricted address/u,
  );
  assert.equal(gotoCalls, 0);
});

test('destructive browser boundary checks every subresource and redirect target', async () => {
  let handler;
  const target = {
    route: async (_pattern, callback) => { handler = callback; },
  };
  const counters = { continued: 0, aborted: 0 };
  await installBrowserEgressGuard(target, {
    resolveHostname: async hostname => (
      hostname === 'safe.example' ? ['8.8.8.8'] : ['127.0.0.1']
    ),
  });

  await handler(routeFor('https://safe.example/app.js', counters));
  await handler(routeFor('https://redirected.example/internal', counters));
  assert.deepEqual(counters, { continued: 1, aborted: 1 });
});

test('destructive browser boundary rejects a private final URL', async () => {
  let finalUrl = 'https://jobs.example/role';
  const page = {
    route: async () => {},
    goto: async () => { finalUrl = 'http://127.0.0.1/admin'; return {}; },
    url: () => finalUrl,
  };
  await assert.rejects(
    navigateGuardedPage(page, 'https://jobs.example/role', {}, {
      resolveHostname: async () => ['8.8.8.8'],
    }),
    /blocked host|loopback|restricted|HTTP\\(S\\)/u,
  );
});

/*
  The loopback model-transport test went with src/security/model-http.mjs. That
  module existed so a local Ollama or OpenAI-compatible server could be reached
  without opening a public-web hole; Frontrunner calls Claude through its CLI
  and has no local model endpoint to protect. The browser-egress and
  network-capability boundaries below are unaffected.
*/
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name) ? [path] : [];
  });
}

test('production network capabilities cannot grow outside the canonical boundaries', () => {
  const roots = [join(ROOT, 'src'), join(ROOT, 'providers'), join(ROOT, 'config')];
  const files = roots.flatMap(filesUnder);
  const sources = new Map(files.map(path => [
    relative(ROOT, path).split('\\').join('/'),
    readFileSync(path, 'utf8'),
  ]));

  const rawFetch = [...sources]
    .filter(([, source]) => /\bawait\s+(?:globalThis\.)?fetch\s*\(/u.test(source))
    .map(([path]) => path);
  assert.deepEqual(rawFetch, [], 'direct fetch() added outside the HTTP/model brokers');

  const nativeHttp = [...sources]
    .filter(([, source]) => /from\s+['"]node:https?['"]/u.test(source))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(nativeHttp, ['providers/_http.mjs']);

  const browserGoto = [...sources]
    .filter(([, source]) => /\.goto\s*\(/u.test(source))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(browserGoto, [
    'src/cv/generate-pdf.mjs', // fixed local file:// document only
    'src/security/browser-egress.mjs', // hostile remote navigation boundary
  ]);

  const browserRoutes = [...sources]
    .filter(([, source]) => /\.route\s*\(/u.test(source))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(browserRoutes, [
    'src/cv/generate-pdf.mjs', // local renderer blocks all remote resources
    'src/security/browser-egress.mjs',
  ]);
});


test('the self-loading updater has one fixed and bounded network exception', () => {
  const source = readFileSync(join(ROOT, 'update-system.mjs'), 'utf8');
  assert.match(source, /Furls-Digital\/frontrunner/u);
  assert.match(source, /assertOfficialUpdateSource\(CANONICAL_REPO\)/u);
  assert.match(source, /--max-filesize/u);
  assert.match(source, /maxBuffer:\s*UPDATE_CHECK_MAX_BYTES/u);
  assert.match(source, /release\.body\.slice\(0,\s*64\s*\*\s*1024\)/u);
  assert.doesNotMatch(source, /\bawait\s+(?:globalThis\.)?fetch\s*\(/u);
});
