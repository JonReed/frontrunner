import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';

import { ROOT } from '#paths';
import {
  readLock,
  writeLockEntry,
} from '../../plugins/_lock.mjs';
import { lockGate } from '../../plugins/_engine.mjs';
import { setPluginEnabled } from '../../src/plugins/plugins.mjs';

const WORKER = join(ROOT, 'tests', 'fixtures', 'plugin-consent-worker.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'frontrunner-plugin-consent-'));
  return { root, config: join(root, 'config', 'plugins.yml'), lock: join(root, 'plugins.lock') };
}

function runWorker(root, id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, root, id], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stderr }));
  });
}

function debris(root) {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter(file => file.endsWith('.tmp') || file.includes('.lock/'));
}

test('concurrent plugin enables retain every activation and consent pin', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const ids = Array.from({ length: 20 }, (_, index) => `plugin-${index}`);

  const results = await Promise.all(ids.map(id => runWorker(fx.root, id)));
  assert.equal(results.every(result => result.code === 0), true);

  const config = yaml.load(readFileSync(fx.config, 'utf8'));
  const lock = readLock(fx.root);
  assert.deepEqual(Object.keys(config.plugins).sort(), [...ids].sort());
  assert.deepEqual(Object.keys(lock.plugins).sort(), [...ids].sort());
  for (const id of ids) {
    assert.equal(config.plugins[id].enabled, true);
    assert.equal(config.plugins[id].label, `Settings for ${id}`);
    assert.equal(lock.plugins[id].consent.allowedHosts[0], `${id}.example.com`);
  }
  assert.equal(statSync(fx.config).mode & 0o777, 0o600);
  assert.equal(statSync(fx.lock).mode & 0o777, 0o600);
  assert.deepEqual(debris(fx.root), []);
});

test('injected activation and lock failures preserve prior consent state', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  mkdirSync(join(fx.root, 'config'), { recursive: true });
  const configBefore = 'plugins:\n  existing:\n    enabled: true\n';
  const lockBefore = '{"lockfileVersion":1,"plugins":{"existing":{"source":"bundled"}}}\n';
  writeFileSync(fx.config, configBefore);
  writeFileSync(fx.lock, lockBefore);

  await assert.rejects(
    setPluginEnabled(fx.root, 'new-plugin', true, undefined, {
      afterWrite() {
        throw new Error('injected activation interruption');
      },
    }),
    /injected activation interruption/u,
  );
  await assert.rejects(
    writeLockEntry(fx.root, 'new-plugin', { source: 'local' }, {
      afterWrite() {
        throw new Error('injected lock interruption');
      },
    }),
    /injected lock interruption/u,
  );
  assert.equal(readFileSync(fx.config, 'utf8'), configBefore);
  assert.equal(readFileSync(fx.lock, 'utf8'), lockBefore);
  assert.deepEqual(debris(fx.root), []);
});

test('malformed activation and consent files fail closed without replacement', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  mkdirSync(join(fx.root, 'config'), { recursive: true });
  const badConfig = 'plugins:\n  broken: [\n';
  const badLock = '{"lockfileVersion":1,"plugins":';
  writeFileSync(fx.config, badConfig);
  writeFileSync(fx.lock, badLock);

  await assert.rejects(
    setPluginEnabled(fx.root, 'new-plugin', true),
    /could not be parsed/u,
  );
  await assert.rejects(
    writeLockEntry(fx.root, 'new-plugin', { source: 'local' }),
    /not valid JSON/u,
  );
  assert.throws(() => readLock(fx.root), /not valid JSON/u);

  const pluginDir = join(fx.root, 'plugins.local', 'new-plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'index.mjs'), 'export default {};');
  const gate = await lockGate({
    id: 'new-plugin',
    dir: pluginDir,
    version: '1.0.0',
    hooks: ['ingest'],
    requiredEnv: [],
    allowedHosts: [],
    allowsLocalhost: false,
    skill: null,
  }, fx.root);
  assert.equal(gate.load, false);
  assert.equal(readFileSync(fx.config, 'utf8'), badConfig);
  assert.equal(readFileSync(fx.lock, 'utf8'), badLock);
  assert.deepEqual(debris(fx.root), []);
});

test('activation preserves unrelated settings and rejects unsafe identifiers', async t => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  mkdirSync(join(fx.root, 'config'), { recursive: true });
  writeFileSync(fx.config, [
    'custom_top_level: keep-me',
    'plugins:',
    '  demo:',
    '    enabled: false',
    '    endpoint: https://api.example.com',
    '',
  ].join('\n'));

  await setPluginEnabled(fx.root, 'demo', true, { label: 'Demo' });
  const config = yaml.load(readFileSync(fx.config, 'utf8'));
  assert.equal(config.custom_top_level, 'keep-me');
  assert.equal(config.plugins.demo.endpoint, 'https://api.example.com');
  assert.equal(config.plugins.demo.label, 'Demo');
  assert.equal(config.plugins.demo.enabled, true);
  await assert.rejects(
    setPluginEnabled(fx.root, '../escape', true),
    /plugin id is invalid/u,
  );
});
