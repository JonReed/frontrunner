import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  setPendingUrlDismissed,
  validateInboxRequest,
} from '../../src/application/inbox-control.mjs';

test('inbox control accepts only one bounded uncredentialed web URL', () => {
  assert.deepEqual(
    validateInboxRequest({
      version: '1',
      action: 'remove',
      url: 'https://example.com/jobs/42',
    }),
    {
      version: '1',
      action: 'remove',
      url: 'https://example.com/jobs/42',
    },
  );

  for (const request of [
    null,
    [],
    { version: '1', action: 'remove', url: 'file:///tmp/jobs/42' },
    { version: '1', action: 'remove', url: 'https://user:pass@example.com/jobs/42' },
    { version: '1', action: 'remove', url: 'https://example.com', path: '/tmp/other' },
  ]) {
    assert.throws(() => validateInboxRequest(request));
  }
});

test('removing a pending role preserves the rest of pipeline.md', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-inbox-control-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pipeline = join(dir, 'pipeline.md');
  writeFileSync(
    pipeline,
    '# Pending\n\n- [ ] https://example.com/one | One | Engineer\n'
      + '- [ ] https://example.com/two | Two | Designer\n',
  );

  assert.deepEqual(
    await setPendingUrlDismissed(pipeline, 'https://example.com/one', true),
    { changed: true, found: true, matched: 1, state: 'dismissed' },
  );
  assert.equal(
    readFileSync(pipeline, 'utf8'),
    '# Pending\n\n- [x] https://example.com/one | One | Engineer\n'
      + '- [ ] https://example.com/two | Two | Designer\n',
  );
  assert.equal(
    (await setPendingUrlDismissed(pipeline, 'https://example.com/one', false)).changed,
    true,
  );
  assert.deepEqual(
    await setPendingUrlDismissed(pipeline, 'https://example.com/missing', true),
    { changed: false, found: false, matched: 0, state: 'dismissed' },
  );
  assert.deepEqual(
    await setPendingUrlDismissed(pipeline, 'https://example.com/two', false),
    { changed: false, found: true, matched: 1, state: 'pending' },
  );
});

test('concurrent inbox removals report one real change and one stale no-op', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-inbox-race-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pipeline = join(dir, 'pipeline.md');
  writeFileSync(pipeline, '- [ ] https://example.com/one | One | Engineer\n');

  const results = await Promise.all([
    setPendingUrlDismissed(pipeline, 'https://example.com/one', true),
    setPendingUrlDismissed(pipeline, 'https://example.com/one', true),
  ]);
  assert.deepEqual(
    results.map(result => result.changed).sort(),
    [false, true],
  );
  assert.equal(
    readFileSync(pipeline, 'utf8'),
    '- [x] https://example.com/one | One | Engineer\n',
  );
});
