import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { ROOT } from '../../src/paths.mjs';
import {
  OPENROUTER_API_URL,
  OPENROUTER_MODELS_URL,
  fetchOpenRouterModels,
  requestOpenRouterCompletion,
} from '../../src/evaluate/openrouter-client.mjs';
import {
  addModelsToBlacklist,
  readModelBlacklist,
} from '../../src/evaluate/model-blacklist.mjs';

const worker = fileURLToPath(new URL('../fixtures/model-blacklist-worker.mjs', import.meta.url));

function fixture(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runWorker(file, index) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [worker, file, String(index)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stderr }));
  });
}

test('OpenRouter model discovery uses the fixed bounded broker contract', async () => {
  let request;
  const models = await fetchOpenRouterModels({
    apiKey: 'test-key',
    transport: async (url, options) => {
      request = { url, options };
      return {
        data: [
          { id: 'provider/free-model:free', pricing: { prompt: '0', completion: '0' } },
          { id: 'provider/paid', pricing: { prompt: '0.1', completion: '0' } },
          { id: '../invalid', pricing: { prompt: '0', completion: '0' } },
          null,
        ],
      };
    },
  });
  assert.deepEqual(models, ['provider/free-model:free']);
  assert.equal(request.url, OPENROUTER_MODELS_URL);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.maxResponseBytes, 2 * 1024 * 1024);
  assert.equal(request.options.headers['http-referer'], 'https://github.com/Furls-Digital/frontrunner');
  assert.equal(request.options.headers['x-title'], 'Frontrunner');
});

test('OpenRouter completion exposes only bounded content and usage', async () => {
  let request;
  const result = await requestOpenRouterCompletion({
    apiKey: 'test-key',
    model: 'provider/model:free',
    systemMessage: { role: 'system', content: 'contract' },
    userMessage: 'untrusted job document',
    transport: async (url, options) => {
      request = { url, options };
      return {
        id: 'must-not-cross',
        choices: [{ message: { content: '{"score":4}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        unknown: 'must-not-cross',
      };
    },
  });
  assert.deepEqual(result, {
    content: '{"score":4}',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 0,
      cached_tokens: 0,
    },
  });
  assert.equal(request.url, OPENROUTER_API_URL);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body).messages, [
    { role: 'system', content: 'contract' },
    { role: 'user', content: 'untrusted job document' },
  ]);

  await assert.rejects(
    requestOpenRouterCompletion({
      apiKey: 'test-key',
      model: 'provider/model',
      systemMessage: { role: 'system', content: 'contract' },
      userMessage: 'job',
      transport: async () => ({
        choices: [{ message: { content: 'x'.repeat((512 * 1024) + 1) } }],
      }),
    }),
    /content exceeds 524288 bytes/,
  );
  await assert.rejects(
    requestOpenRouterCompletion({
      apiKey: 'test-key',
      model: 'provider/model',
      systemMessage: { role: 'system', content: 'x'.repeat(2 * 1024 * 1024) },
      userMessage: 'job',
      transport: async () => assert.fail('oversized prompt reached transport'),
    }),
    /prompt exceeds 2097152 bytes/,
  );
  await assert.rejects(
    requestOpenRouterCompletion({
      apiKey: 'test-key',
      model: 'provider/model',
      systemMessage: { role: 'assistant', content: 'authority confusion' },
      userMessage: 'job',
      transport: async () => assert.fail('invalid system message reached transport'),
    }),
    /must have role system/,
  );
  await assert.rejects(
    requestOpenRouterCompletion({
      apiKey: 'test-key',
      model: 'provider/model',
      systemMessage: { role: 'system', content: 'contract' },
      userMessage: 'job',
      timeoutMs: 1234,
      transport: async () => {
        const error = new Error('broker-specific abort text');
        error.name = 'AbortError';
        throw error;
      },
    }),
    /Timeout after 1234ms/,
  );
});

test('destructive concurrent blacklist writers retain every model', async t => {
  const file = join(fixture(t, 'frontrunner-model-blacklist-race-'), 'model-blacklist.json');
  const count = 20;
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) => runWorker(file, index)),
  );
  assert.deepEqual(
    results.map(result => result.code),
    Array(count).fill(0),
    results.map(result => result.stderr).join('\n'),
  );
  const models = readModelBlacklist(file);
  assert.equal(models.size, count);
  for (let index = 0; index < count; index++) {
    assert.equal(models.has(`provider/model-${index}:free`), true);
  }
  assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true);
});

test('blacklist interruption and poisoned paths fail closed', async t => {
  const dir = fixture(t, 'frontrunner-model-blacklist-failure-');
  const file = join(dir, 'model-blacklist.json');
  await addModelsToBlacklist(file, ['provider/stable']);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(
    addModelsToBlacklist(file, ['provider/new'], {
      afterWrite: () => { throw new Error('injected blacklist interruption'); },
    }),
    /injected blacklist interruption/,
  );
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(
    existsSync(`${file}.lock`),
    false,
  );

  writeFileSync(join(dir, 'outside.json'), '[]\n');
  rmSync(file);
  symlinkSync(join(dir, 'outside.json'), file);
  assert.throws(() => readModelBlacklist(file), /must be a regular file/);
  await assert.rejects(
    addModelsToBlacklist(file, ['provider/rejected']),
    /must be a regular file/,
  );
  assert.equal(readFileSync(join(dir, 'outside.json'), 'utf8'), '[]\n');
});

test('OpenRouter runner cannot regress to direct HTTP, raw state writes, or upstream branding', () => {
  const source = readFileSync(join(ROOT, 'src', 'evaluate', 'openrouter-runner.mjs'), 'utf8');
  assert.doesNotMatch(source, /\b(?:globalThis\.)?fetch\s*\(/u);
  assert.doesNotMatch(source, /\bwriteFileSync\b/u);
  assert.doesNotMatch(source, /github\.com\/santifer\/frontrunner|X-Title['"]?\s*:\s*['"]frontrunner/iu);
  assert.match(source, /requestOpenRouterCompletion/);
  assert.match(source, /addModelsToBlacklist/);
  assert.match(source, /src\/scan\/scan\.mjs/);
});
