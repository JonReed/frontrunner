import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

import { ROOT } from '#paths';

import { runPrefilter } from '../../src/scan/prefilter.mjs';

test('destructive batch boundary: missing prefilter fails closed before launching a worker', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-batch-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const batch = join(dir, 'batch');
  const fakeBin = join(dir, 'bin');
  mkdirSync(batch, { recursive: true });
  mkdirSync(fakeBin);
  mkdirSync(join(dir, 'reports'));
  mkdirSync(join(dir, 'data'));
  copyFileSync(join(ROOT, 'batch', 'batch-runner.sh'), join(batch, 'batch-runner.sh'));
  chmodSync(join(batch, 'batch-runner.sh'), 0o755);
  writeFileSync(join(batch, 'batch-prompt.md'), 'fixture\n');
  writeFileSync(join(batch, 'batch-input.tsv'), 'id\turl\tsource\tnotes\n1\thttps://example.com/job\tfixture\tAcme — Director\n');
  const launched = join(dir, 'worker-launched');
  writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\nprintf launched > "${launched}"\n`);
  chmodSync(join(fakeBin, 'claude'), 0o755);

  const command = process.platform === 'win32' ? 'bash' : join(batch, 'batch-runner.sh');
  const args = process.platform === 'win32'
    ? ['batch/batch-runner.sh', '--dry-run']
    : ['--dry-run'];
  const result = spawnSync(command, args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mandatory prefilter module missing/);
  assert.equal(existsSync(launched), false);
});

test('destructive batch boundary: filtering preserves original TSV identities', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'frontrunner-batch-ids-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'input.tsv');
  const output = join(dir, 'filtered.tsv');
  const rejects = join(dir, 'rejects.tsv');
  const jds = join(dir, 'jds');
  mkdirSync(jds);
  writeFileSync(input, [
    'id\turl\tsource\tnotes',
    '17\thttps://example.com/marketing\tmanual\tAcme — Head of Marketing',
    '42\thttps://example.com/platform\tcurated\tBeta — Director of Platform',
    '',
  ].join('\n'));
  const rules = {
    keep: [/\bdirector\b/i],
    ic: [],
    wrong: [/\bmarketing\b/i],
    junior: [],
    blockers: [],
    comp: { enabled: false, margin: 0.8 },
  };

  runPrefilter({
    input,
    jdsDir: jds,
    out: output,
    rejects,
    profile: { minComp: 0, currency: 'GBP' },
    rules,
  });

  const filtered = readFileSync(output, 'utf8');
  assert.match(filtered, /^42\thttps:\/\/example\.com\/platform\tcurated\t/m);
  assert.doesNotMatch(filtered, /^1\thttps:\/\/example\.com\/platform\t/m);
  assert.match(readFileSync(rejects, 'utf8'), /Head of Marketing\twrong_function/);
});
