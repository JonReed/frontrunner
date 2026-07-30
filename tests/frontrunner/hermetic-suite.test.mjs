import assert from 'node:assert/strict';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import { check as checkForUpdate } from '../../update-system.mjs';

const HERMETIC = process.env.FRONTRUNNER_TEST_HERMETIC === '1';

test('full-suite process is rooted in a scrubbed disposable environment', {
  skip: !HERMETIC && 'only applies inside test-all.mjs',
}, () => {
  const rootPrefix = `${realpathSync(resolve(ROOT))}${sep}`;
  assert.ok(realpathSync(resolve(homedir())).startsWith(rootPrefix), `HOME escaped test root: ${homedir()}`);
  assert.ok(realpathSync(resolve(tmpdir())).startsWith(rootPrefix), `tmpdir escaped test root: ${tmpdir()}`);
  assert.equal(process.env.TZ, 'UTC');
  assert.equal(process.env.LC_ALL, 'C.UTF-8');
  for (const name of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'GITHUB_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
  ]) {
    assert.equal(process.env[name], undefined, `${name} leaked into the test process`);
  }
  assert.match(process.env.NODE_OPTIONS ?? '', /test-user-data-write-barrier/u);
  assert.match(process.env.NODE_OPTIONS ?? '', /test-hermetic-network-barrier/u);
});

test('destructive hermetic barrier rejects fetch, native HTTP and DNS', {
  skip: !HERMETIC && 'only applies inside test-all.mjs',
}, async () => {
  await assert.rejects(
    fetch('https://example.com/should-never-leave'),
    error => error?.code === 'FRONTRUNNER_TEST_NETWORK_DENIED',
  );
  assert.throws(
    () => http.request('http://example.com/should-never-leave'),
    error => error?.code === 'FRONTRUNNER_TEST_NETWORK_DENIED',
  );
  const dnsError = await new Promise(resolvePromise => {
    dns.lookup('example.com', error => resolvePromise(error));
  });
  assert.equal(dnsError?.code, 'FRONTRUNNER_TEST_NETWORK_DENIED');
  const resolverError = await new Promise(resolvePromise => {
    new dns.Resolver().resolve4('example.com', error => resolvePromise(error));
  });
  assert.equal(resolverError?.code, 'FRONTRUNNER_TEST_NETWORK_DENIED');
  await assert.rejects(
    new dnsPromises.Resolver().resolve4('example.com'),
    error => error?.code === 'FRONTRUNNER_TEST_NETWORK_DENIED',
  );
});

test('update check uses injected release fixtures without external I/O', async () => {
  const local = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim().split(/\s+/u)[0];
  const calls = [];
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(String(line));
  try {
    await checkForUpdate({
      async get(url) {
        calls.push(url);
        return url.includes('/VERSION')
          ? `${local}\n`
          : JSON.stringify({ tag_name: `frontrunner-v${local}`, body: 'fixture release' });
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(lines.at(-1)), {
    status: 'up-to-date',
    local,
    remote: local,
  });
});

test('test harness contains no live update, browser, or remote fetch path', () => {
  const source = readFileSync(join(ROOT, 'tests', 'runner.mjs'), 'utf8');
  const testSources = [
    join(ROOT, 'test-all.mjs'),
    ...readdirSync(join(ROOT, 'tests'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
      .map(entry => join(entry.parentPath, entry.name)),
  ];
  assert.doesNotMatch(source, /update-system\.mjs check/u);
  assert.doesNotMatch(source, /\bfetch\s*\(\s*['"`]https?:/u);
  for (const path of testSources) {
    const testSource = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      testSource,
      /\b(?:chromium|firefox|webkit)\.launch\s*\(/u,
      `${path} must inject a browser fixture instead of launching one`,
    );
    assert.doesNotMatch(
      testSource,
      /\b(?:spawnSync|spawn|execFileSync|execSync|run)\s*\(\s*['"`](?:curl|wget|nc)['"`]/u,
      `${path} must not escape the Node network barrier through a network CLI`,
    );
  }
  assert.match(source, /FRONTRUNNER_TEST_HERMETIC/u);
  assert.match(source, /test-hermetic-network-barrier/u);
  assert.doesNotMatch(
    source,
    /env:\s*\{\s*\.\.\.process\.env,\s*FRONTRUNNER_TEST_SANDBOX/u,
    'outer runner must not inherit the host environment wholesale',
  );
});
