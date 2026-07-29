import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { ROOT } from '#paths';
import {
  resolveApplicationAnswersReportPath,
  writeApplicationAnswers,
} from '../../src/evaluate/application-answers.mjs';
import { appendAssessmentRow } from '../../src/analysis/assessment-log.mjs';
import { appendCandidate } from '../../src/tracker/paste-reply.mjs';

const PASTE_CLI = join(ROOT, 'src', 'tracker', 'paste-reply.mjs');
const ASSESSMENT_CLI = join(ROOT, 'src', 'analysis', 'assessment-log.mjs');

function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function debris(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter(file => file.endsWith('.tmp') || file.includes('.lock'));
}

test('application-answer publication is atomic and contained under reports', async t => {
  const fx = fixture('frontrunner-answers-state-');
  t.after(fx.cleanup);
  const reportsDir = join(fx.dir, 'reports');
  const report = join(reportsDir, '001-acme.md');
  const outside = join(fx.dir, 'outside.md');
  mkdirSync(reportsDir);
  writeFileSync(report, '# Evaluation\n\nOriginal body.\n');
  writeFileSync(outside, '# Outside\n');

  const original = readFileSync(report, 'utf8');
  await assert.rejects(
    writeApplicationAnswers(report, {
      state: 'filled',
      freeText: [{ question: 'Why?', answer: 'Because.' }],
    }, {
      reportsDir,
      afterWrite() {
        throw new Error('injected report write interruption');
      },
    }),
    /injected report write interruption/u,
  );
  assert.equal(readFileSync(report, 'utf8'), original);
  assert.deepEqual(debris(fx.dir), []);

  await assert.rejects(
    writeApplicationAnswers(outside, { state: 'filled' }, { reportsDir }),
    /under reports/u,
  );
  const link = join(reportsDir, 'escape.md');
  symlinkSync(outside, link);
  assert.throws(
    () => resolveApplicationAnswersReportPath(link, reportsDir),
    /under reports/u,
  );
  assert.equal(readFileSync(outside, 'utf8'), '# Outside\n');

  const normalized = await writeApplicationAnswers(report, {
    state: 'submitted',
    freeText: [{ question: 'Why?', answer: 'Because.' }],
  }, { reportsDir });
  assert.equal(normalized.state, 'submitted');
  assert.match(readFileSync(report, 'utf8'), /## Application Answers/u);
  if (process.platform !== 'win32') {
    assert.equal(statSync(report).mode & 0o777, 0o600);
  }
});

test('concurrent pasted replies retain every bounded candidate exactly once', async t => {
  const fx = fixture('frontrunner-reply-state-');
  t.after(fx.cleanup);
  const candidates = join(fx.dir, 'reply-candidates.json');
  const count = 16;
  const runs = [];
  for (let index = 0; index < count; index += 1) {
    const email = join(fx.dir, `email-${index}.txt`);
    writeFileSync(email, `Subject: Reply ${index}\nFrom: hr${index}@example.com\n\nBody ${index}`);
    runs.push(run(process.execPath, [PASTE_CLI, '--file', email], {
      FRONTRUNNER_REPLY_CANDIDATES: candidates,
    }));
  }
  const results = await Promise.all(runs);
  assert.equal(results.every(result => result.code === 0), true);
  const stored = JSON.parse(readFileSync(candidates, 'utf8'));
  assert.equal(stored.length, count);
  assert.equal(new Set(stored.map(item => item.subject)).size, count);
  if (process.platform !== 'win32') {
    assert.equal(statSync(candidates).mode & 0o777, 0o600);
  }
  assert.deepEqual(debris(fx.dir), []);
});

test('reply publication rejects floods and preserves the original on write failure', async t => {
  const fx = fixture('frontrunner-reply-failure-');
  t.after(fx.cleanup);
  const candidates = join(fx.dir, 'reply-candidates.json');
  writeFileSync(candidates, '[]\n');
  const candidate = {
    message_id: 'pasted-safe-1',
    from: 'hr@example.com',
    subject: 'Interview',
    body_snippet: 'Please choose a time.',
    signal: null,
  };
  await assert.rejects(
    appendCandidate(candidate, candidates, {
      afterWrite() {
        throw new Error('injected candidate write interruption');
      },
    }),
    /injected candidate write interruption/u,
  );
  assert.equal(readFileSync(candidates, 'utf8'), '[]\n');
  assert.deepEqual(debris(fx.dir), []);

  await assert.rejects(
    appendCandidate({
      ...candidate,
      message_id: 'pasted-flood-1',
      body_snippet: 'x'.repeat(100_001),
    }, candidates),
    /safe size limit/u,
  );
  assert.equal(readFileSync(candidates, 'utf8'), '[]\n');
});

test('concurrent assessment events retain every row and one header', async t => {
  const fx = fixture('frontrunner-assessment-state-');
  t.after(fx.cleanup);
  const logPath = join(fx.dir, 'assessments.tsv');
  const count = 16;
  const runs = Array.from({ length: count }, (_, index) => run(
    process.execPath,
    [
      ASSESSMENT_CLI,
      'add',
      '--company', `Company ${index}`,
      '--platform', 'HackerRank',
      '--subject', `Exercise ${index}`,
    ],
    { FRONTRUNNER_ASSESSMENTS: logPath },
  ));
  const results = await Promise.all(runs);
  assert.equal(results.every(result => result.code === 0), true);
  const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n');
  assert.equal(lines.filter(line => line.startsWith('# assessments.tsv')).length, 1);
  assert.equal(lines.filter(line => !line.startsWith('#')).length, count);
  assert.equal(new Set(lines.filter(line => !line.startsWith('#'))).size, count);
  if (process.platform !== 'win32') {
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
  }
  assert.deepEqual(debris(fx.dir), []);
});

test('assessment interruption preserves the prior append-only log', async t => {
  const fx = fixture('frontrunner-assessment-failure-');
  t.after(fx.cleanup);
  const logPath = join(fx.dir, 'assessments.tsv');
  const original = '# existing\n2026-07-01\tAcme\t-\tTest\tSubject\t-\t-\t\n';
  writeFileSync(logPath, original);
  await assert.rejects(
    appendAssessmentRow(
      '2026-07-02\tGlobex\t-\tTest\tSubject\t-\t-\t',
      logPath,
      {
        afterWrite() {
          throw new Error('injected assessment write interruption');
        },
      },
    ),
    /injected assessment write interruption/u,
  );
  assert.equal(readFileSync(logPath, 'utf8'), original);
  assert.deepEqual(debris(fx.dir), []);
});
