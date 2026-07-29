import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { publishPipelineFile } from '../../src/pipeline/pipeline-files.mjs';
import { markPipelineOutcomes } from '../../src/pipeline/run.mjs';

test('failed pipeline outcome publication preserves the inbox and releases its lock', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-outcome-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pipeline = join(dir, 'pipeline.md');
  const original = '# Pipeline\r\n\r\n- [ ] https://jobs.example/1 | Acme | Engineer\r\n';
  writeFileSync(pipeline, original);

  await assert.rejects(
    markPipelineOutcomes(
      pipeline,
      new Map([['https://jobs.example/1', 'evaluated']]),
      {
        writeOptions: {
          afterWrite() {
            throw new Error('injected pipeline outcome interruption');
          },
        },
      },
    ),
    /injected pipeline outcome interruption/,
  );
  assert.equal(readFileSync(pipeline, 'utf8'), original);
  assert.deepEqual(readdirSync(dir), ['pipeline.md']);

  assert.equal(
    await markPipelineOutcomes(
      pipeline,
      new Map([['https://jobs.example/1', 'evaluated']]),
    ),
    1,
  );
  assert.match(readFileSync(pipeline, 'utf8'), /\[x\].*result: evaluated/u);
  assert.deepEqual(readdirSync(dir), ['pipeline.md']);
});

test('pipeline publisher enforces protected user data without a preload hook', (t) => {
  const protectedRoot = mkdtempSync(join(tmpdir(), 'frontrunner-protected-pipeline-'));
  t.after(() => rmSync(protectedRoot, { recursive: true, force: true }));
  const data = join(protectedRoot, 'data');
  const pipeline = join(data, 'pipeline.md');
  const previousRoot = process.env.FRONTRUNNER_TEST_PROTECTED_ROOT;
  mkdirSync(data, { recursive: true });
  writeFileSync(pipeline, 'must survive\n');
  process.env.FRONTRUNNER_TEST_PROTECTED_ROOT = protectedRoot;
  try {
    assert.throws(
      () => publishPipelineFile(pipeline, 'stale test destroyed the inbox\n'),
      error => error?.code === 'TEST_USER_DATA_WRITE_BLOCKED',
    );
    assert.equal(readFileSync(pipeline, 'utf8'), 'must survive\n');
    assert.deepEqual(readdirSync(data), ['pipeline.md']);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.FRONTRUNNER_TEST_PROTECTED_ROOT;
    } else {
      process.env.FRONTRUNNER_TEST_PROTECTED_ROOT = previousRoot;
    }
  }
});
