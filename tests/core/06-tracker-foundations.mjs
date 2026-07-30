import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pass, fail, warn, run, fileExists, ROOT, NODE, getBash, toBashPath } from '../helpers.mjs';
import { readFile, normalizeEol, readTextLF } from './support.mjs';

console.log('\n12. Follow-up cadence logic');

try {
  const cadence = await import(pathToFileURL(join(ROOT, 'src/tracker/followup-cadence.mjs')).href);

  // CLI regression: the import.meta.url guard must still let the module run as a CLI.
  // Data-independent — default mode emits the result as JSON: a `metadata` object when
  // the tracker has applications, or an `{error}` object (exit 1) when it is empty.
  // Empty output would mean the guard wrongly suppressed main().
  let cliOut = '';
  try {
    cliOut = execFileSync(NODE, [join(ROOT, 'src/tracker/followup-cadence.mjs')], { cwd: ROOT, encoding: 'utf-8', timeout: 30000 });
  } catch (cliErr) {
    cliOut = `${cliErr.stdout || ''}`; // exit 1 on an empty tracker is expected; keep stdout
  }
  let cliJson = null;
  try { cliJson = JSON.parse(cliOut.trim()); } catch { /* leave null → fail below */ }
  if (cliJson && typeof cliJson === 'object' && ('metadata' in cliJson || 'error' in cliJson)) {
    pass('CLI still executes under the import.meta.url guard (emits result JSON)');
  } else {
    fail('CLI produced no structured JSON when run directly — import.meta.url guard may be broken');
  }

  // Date helpers
  if (cadence.addDays(cadence.parseDate('2026-05-01'), 7) === '2026-05-08') {
    pass('addDays advances a parsed date by N days (UTC)');
  } else {
    fail(`addDays produced ${cadence.addDays(cadence.parseDate('2026-05-01'), 7)}`);
  }
  if (cadence.daysBetween(cadence.parseDate('2026-05-01'), cadence.parseDate('2026-05-08')) === 7) {
    pass('daysBetween counts whole days between two dates');
  } else {
    fail('daysBetween miscounted');
  }
  if (cadence.parseDate('not-a-date') === null && cadence.parseDate('2026-05-01') instanceof Date) {
    pass('parseDate rejects malformed input and accepts ISO dates');
  } else {
    fail('parseDate validation wrong');
  }

  // parseAppliedDate — extracts the real submission date from notes (the
  // tracker `date` column is the evaluation date), case-insensitive.
  if (cadence.parseAppliedDate('Applied 2026-06-09 via Personio; raised part-time') === '2026-06-09') {
    pass('parseAppliedDate extracts "Applied YYYY-MM-DD" from notes');
  } else {
    fail(`parseAppliedDate got ${JSON.stringify(cadence.parseAppliedDate('Applied 2026-06-09 via Personio; raised part-time'))}`);
  }
  if (cadence.parseAppliedDate('APPLIED 2026-06-17 (German CV; jobId=104170)') === '2026-06-17') {
    pass('parseAppliedDate is case-insensitive (APPLIED)');
  } else {
    fail('parseAppliedDate should match uppercase APPLIED');
  }
  // First "Applied" date wins even when a later status date follows.
  if (cadence.parseAppliedDate('Applied 2026-06-09. No response; discarded 2026-06-18.') === '2026-06-09') {
    pass('parseAppliedDate takes the first applied date, not a later status date');
  } else {
    fail('parseAppliedDate should take the first applied date');
  }
  if (cadence.parseAppliedDate('On-archetype fit; no submission yet') === null && cadence.parseAppliedDate('') === null) {
    pass('parseAppliedDate returns null when notes carry no applied date');
  } else {
    fail('parseAppliedDate should return null without an applied date');
  }
  // "reapplied" must not be mistaken for an applied date (word boundary).
  if (cadence.parseAppliedDate('reapplied 2026-06-09 after rejection') === null) {
    pass('parseAppliedDate does not match inside "reapplied"');
  } else {
    fail('parseAppliedDate should not match the date inside "reapplied"');
  }

  // Status normalization (strips bold + trailing date, lowercases, maps aliases)
  if (cadence.normalizeStatus('**Applied** 2026-05-01') === 'applied') {
    pass('normalizeStatus strips bold + trailing date and lowercases');
  } else {
    fail(`normalizeStatus produced ${cadence.normalizeStatus('**Applied** 2026-05-01')}`);
  }

  const cadenceTmp = mkdtempSync(join(tmpdir(), 'co-cadence-'));
  const profilePath = join(cadenceTmp, 'profile.yml');
  writeFileSync(profilePath, [
    'followup_cadence:',
    '  applied_first_days: 11',
    '  applied_subsequent_days: 5',
    '  applied_max_followups: 4',
    '  responded_initial_days: 2',
    '  responded_subsequent_days: 6',
    '  interview_thankyou_days: 3',
  ].join('\n'));

  const profileCadence = cadence.resolveCadenceConfig({ profilePath });
  if (
    profileCadence.applied_first === 11 &&
    profileCadence.applied_subsequent === 5 &&
    profileCadence.applied_max_followups === 4 &&
    profileCadence.responded_initial === 2 &&
    profileCadence.responded_subsequent === 6 &&
    profileCadence.interview_thankyou === 3
  ) {
    pass('follow-up cadence reads profile.yml overrides');
  } else {
    fail(`profile cadence override failed: ${JSON.stringify(profileCadence)}`);
  }

  const cliCadence = cadence.resolveCadenceConfig({ profilePath, appliedDays: 9 });
  if (cliCadence.applied_first === 9 && cliCadence.applied_subsequent === 5) {
    pass('follow-up cadence CLI override wins over profile applied_first');
  } else {
    fail(`CLI cadence override failed: ${JSON.stringify(cliCadence)}`);
  }

  const malformedProfile = join(cadenceTmp, 'malformed.yml');
  writeFileSync(malformedProfile, 'followup_cadence: [');
  const fallbackCadence = cadence.resolveCadenceConfig({ profilePath: malformedProfile });
  if (fallbackCadence.applied_first === cadence.DEFAULT_CADENCE.applied_first) {
    pass('follow-up cadence ignores malformed optional profile config');
  } else {
    fail(`malformed profile did not fall back to defaults: ${JSON.stringify(fallbackCadence)}`);
  }

  rmSync(cadenceTmp, { recursive: true, force: true });

  // Urgency decision tree (CADENCE defaults: applied_first=7, max_followups=2, responded_initial=1, interview_thankyou=1)
  const urgencyCases = [
    [['applied', 7, null, 0], 'overdue', 'applied past applied_first → overdue'],
    [['applied', 3, null, 0], 'waiting', 'applied within window → waiting'],
    [['applied', 30, null, 2], 'cold', 'applied at max follow-ups → cold'],
    [['responded', 0, null, 0], 'urgent', 'responded before responded_initial → urgent'],
    [['interview', 1, null, 0], 'overdue', 'interview past thank-you window → overdue'],
  ];
  for (const [args, expected, label] of urgencyCases) {
    const got = cadence.computeUrgency(...args);
    if (got === expected) pass(`computeUrgency: ${label}`);
    else fail(`computeUrgency ${label}: expected ${expected}, got ${got}`);
  }

  // Next follow-up date scheduling
  const nextCases = [
    [['applied', '2026-05-01', null, 0], '2026-05-08', 'first applied follow-up = appDate + applied_first'],
    [['applied', '2026-05-01', null, 2], null, 'cold (max follow-ups) → null'],
    [['interview', '2026-05-01', null, 0], '2026-05-02', 'interview = appDate + interview_thankyou'],
  ];
  for (const [args, expected, label] of nextCases) {
    const got = cadence.computeNextFollowupDate(...args);
    if (got === expected) pass(`computeNextFollowupDate: ${label}`);
    else fail(`computeNextFollowupDate ${label}: expected ${expected}, got ${got}`);
  }
} catch (e) {
  fail(`follow-up cadence module crashed: ${e.message}`);
}

// ── 14b. ADD-ENTRY (/frontrunner add) ────────────────────────────────

console.log('\n14b. src/tracker/add-entry.mjs (dedup + insertion)');

try {
  const addMod = await import(pathToFileURL(join(ROOT, 'src/tracker/add-entry.mjs')).href);
  const { normalizeKey, locateSection, cvHasEntry, insertIntoCvSection, articleDigestHasEntry, applyAdd } = addMod;

  if (normalizeKey('Fraud-Shield!') === 'fraudshield') pass('normalizeKey strips punctuation/case');
  else fail(`normalizeKey => ${normalizeKey('Fraud-Shield!')}`);

  const sampleCv = [
    '# CV -- Test',
    '',
    '## Work Experience',
    '',
    '### Acme -- Remote',
    '',
    '**Engineer**',
    '2020-2022',
    '',
    '- Did things',
    '',
    '## Projects',
    '',
    '- **Existing** (OSS) -- already here',
    '',
    '## Education',
    '',
    '- BS CS',
    '',
  ].join('\n');

  // locateSection isolates the right block
  const loc = locateSection(sampleCv, 'Projects');
  if (loc && loc.body.includes('Existing') && !loc.body.includes('BS CS')) pass('locateSection isolates the Projects block');
  else fail(`locateSection => ${JSON.stringify(loc && loc.body)}`);

  // insertion appends within section and preserves later sections
  const inserted = insertIntoCvSection(sampleCv, 'Projects', '- **FraudShield** (OSS) -- fraud detection');
  if (inserted.includes('- **Existing**') && inserted.includes('- **FraudShield**') &&
      inserted.indexOf('FraudShield') < inserted.indexOf('## Education') &&
      inserted.includes('## Education')) {
    pass('insertIntoCvSection appends under Projects and keeps Education intact');
  } else {
    fail('insertIntoCvSection placement wrong');
  }

  // missing section is created at EOF
  const withPubs = insertIntoCvSection(sampleCv, 'Publications', '- **A Paper** (2026) -- venue');
  if (withPubs.includes('## Publications') && withPubs.includes('- **A Paper**')) pass('insertIntoCvSection creates a missing section');
  else fail('insertIntoCvSection did not create missing section');

  // dedup detection is punctuation/case-insensitive
  if (cvHasEntry(sampleCv, 'Projects', 'existing') && !cvHasEntry(sampleCv, 'Projects', 'FraudShield')) {
    pass('cvHasEntry detects an existing entry and misses a new one');
  } else {
    fail('cvHasEntry dedup logic wrong');
  }

  // applyAdd: fresh add to cv + article-digest (article-digest absent → created)
  const added = applyAdd(
    {
      cv: { section: 'Projects', dedupKey: 'FraudShield', entry: '- **FraudShield** (OSS) -- fraud detection' },
      articleDigest: { dedupKey: 'FraudShield', entry: '## FraudShield -- Detection\n\n**Hero metrics:** 99.7%' },
    },
    { cvText: sampleCv, articleText: null },
  );
  if (added.result.cv.status === 'added' && added.result.articleDigest.status === 'created' &&
      added.cv.includes('FraudShield') && added.articleDigest.includes('## FraudShield')) {
    pass('applyAdd adds a new CV entry and creates workspace/profile/article-digest.md when absent');
  } else {
    fail(`applyAdd fresh-add => ${JSON.stringify(added.result)}`);
  }

  // applyAdd: idempotent — same payload against updated files is a no-op
  const again = applyAdd(
    {
      cv: { section: 'Projects', dedupKey: 'FraudShield', entry: '- **FraudShield** (OSS) -- fraud detection' },
      articleDigest: { dedupKey: 'FraudShield', entry: '## FraudShield -- Detection\n\n**Hero metrics:** 99.7%' },
    },
    { cvText: added.cv, articleText: added.articleDigest },
  );
  if (again.result.cv.status === 'duplicate' && again.result.articleDigest.status === 'duplicate') {
    pass('applyAdd is idempotent (duplicate/duplicate on re-run)');
  } else {
    fail(`applyAdd re-run => ${JSON.stringify(again.result)}`);
  }

  if (articleDigestHasEntry(added.articleDigest, 'fraud shield')) pass('articleDigestHasEntry matches normalized heading');
  else fail('articleDigestHasEntry failed to match');

  // guardrails: cv add against a missing workspace/profile/cv.md throws; empty payload throws
  let threwNoCv = false;
  try { applyAdd({ cv: { section: 'Projects', dedupKey: 'X', entry: '- x' } }, { cvText: null }); } catch { threwNoCv = true; }
  if (threwNoCv) pass('applyAdd refuses to add to a missing workspace/profile/cv.md');
  else fail('applyAdd should throw when workspace/profile/cv.md is absent');

  let threwEmpty = false;
  try { applyAdd({}, { cvText: sampleCv }); } catch { threwEmpty = true; }
  if (threwEmpty) pass('applyAdd rejects an empty payload');
  else fail('applyAdd should reject an empty payload');

  // dedupKey is required — idempotency depends on it, so a missing one fails fast.
  let threwNoKey = false;
  try { applyAdd({ cv: { section: 'Projects', entry: '- **X** -- y' } }, { cvText: sampleCv }); } catch { threwNoKey = true; }
  if (threwNoKey) pass('applyAdd requires a dedupKey for a cv target');
  else fail('applyAdd should throw when cv.dedupKey is missing');

  // Short-key dedup must NOT collide with unrelated substrings (e.g. "ai" in a
  // bullet that mentions "email"). Regression for the identifier-based matcher.
  const cvWithEmail = '# CV\n\n## Projects\n\n- **Mailer** (OSS) -- sends email digests\n';
  if (!cvHasEntry(cvWithEmail, 'Projects', 'AI')) pass('cvHasEntry does not false-match a short key against unrelated text');
  else fail('cvHasEntry should not match "AI" against "email"');
  if (cvHasEntry(cvWithEmail, 'Projects', 'Mailer')) pass('cvHasEntry still matches the real bold identifier');
  else fail('cvHasEntry should match the bold entry name');

  // Same collision guard for article-digest headings (name before the dash).
  const adWithMailer = '# Article Digest\n\n---\n\n## Mailer -- Email digests\n\n**Hero metrics:** x\n';
  if (!articleDigestHasEntry(adWithMailer, 'AI')) pass('articleDigestHasEntry does not false-match a short key against a heading');
  else fail('articleDigestHasEntry should not match "AI" against the "Mailer -- Email digests" heading');
  if (articleDigestHasEntry(adWithMailer, 'Mailer')) pass('articleDigestHasEntry matches the real heading name');
  else fail('articleDigestHasEntry should match the heading name before the dash');

  // CLI wiring: --dry-run reports without writing; a real run writes and is then
  // idempotent. Exercised against isolated fixture files via env overrides.
  const cliTmp = mkdtempSync(join(tmpdir(), 'frontrunner-add-cli-'));
  try {
    mkdirSync(join(cliTmp, 'workspace', 'profile'), { recursive: true });
    const cvPath = join(cliTmp, 'workspace/profile/cv.md');
    const adPath = join(cliTmp, 'workspace/profile/article-digest.md');
    writeFileSync(cvPath, '# CV\n\n## Projects\n\n- **Existing** (OSS) -- here\n');
    const payloadPath = join(cliTmp, 'p.json');
    writeFileSync(payloadPath, JSON.stringify({
      cv: { section: 'Projects', dedupKey: 'CliProj', entry: '- **CliProj** (OSS) -- desc' },
      articleDigest: { dedupKey: 'CliProj', entry: '## CliProj -- Tagline\n\n**Hero metrics:** x' },
    }));
    const env = { ...process.env, FRONTRUNNER_CV: cvPath, FRONTRUNNER_ARTICLE_DIGEST: adPath };

    execFileSync(NODE, [join(ROOT, 'src/tracker/add-entry.mjs'), payloadPath, '--dry-run'], { env, encoding: 'utf-8' });
    if (!readFileSync(cvPath, 'utf-8').includes('CliProj') && !existsSync(adPath)) pass('add-entry CLI --dry-run writes nothing');
    else fail('add-entry CLI --dry-run should not write');

    const realOut = JSON.parse(execFileSync(NODE, [join(ROOT, 'src/tracker/add-entry.mjs'), payloadPath], { env, encoding: 'utf-8' }));
    if (realOut.cv.status === 'added' && realOut.articleDigest.status === 'created' &&
        readFileSync(cvPath, 'utf-8').includes('- **CliProj**') && readFileSync(adPath, 'utf-8').includes('## CliProj')) {
      pass('add-entry CLI real run writes workspace/profile/cv.md + creates workspace/profile/article-digest.md');
    } else {
      fail(`add-entry CLI real run => ${JSON.stringify(realOut)}`);
    }

    const rerun = JSON.parse(execFileSync(NODE, [join(ROOT, 'src/tracker/add-entry.mjs'), payloadPath], { env, encoding: 'utf-8' }));
    if (rerun.cv.status === 'duplicate' && rerun.articleDigest.status === 'duplicate') pass('add-entry CLI re-run is idempotent');
    else fail(`add-entry CLI re-run => ${JSON.stringify(rerun)}`);
  } finally {
    rmSync(cliTmp, { recursive: true, force: true });
  }

} catch (e) {
  fail(`add-entry tests crashed: ${e.message}`);
}

// ── 12. TRACKER REPORT LINK NORMALIZATION (#760) ────────────────

console.log('\n12. Tracker report-link normalization');

try {
  const { normalizeReportLink } = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker-links.mjs')).href);
  const repo = '/repo';
  const dataDir = join(repo, 'workspace', 'applications');

  // data/ layout: root-relative TSV link → ../reports/evaluations/...
  const fromTsv = normalizeReportLink('[12](workspace/reports/evaluations/012-acme-2026-01-04.md)', dataDir, repo);
  if (fromTsv === '[12](../reports/evaluations/012-acme-2026-01-04.md)') {
    pass('data/ layout: root-relative link rewritten to ../reports/evaluations/...');
  } else {
    fail(`data/ layout normalization wrong: ${fromTsv}`);
  }

  // Idempotent: re-running on an already-normalized link must not double-prefix
  const twice = normalizeReportLink(fromTsv, dataDir, repo);
  if (twice === fromTsv) {
    pass('normalization is idempotent (no double-prefix on re-run)');
  } else {
    fail(`normalization not idempotent: ${twice}`);
  }

  // Root layout: tracker at repo root → link stays workspace/reports/evaluations/...
  const atRoot = normalizeReportLink('[12](workspace/reports/evaluations/012-acme-2026-01-04.md)', repo, repo);
  if (atRoot === '[12](workspace/reports/evaluations/012-acme-2026-01-04.md)') {
    pass('root layout: link stays root-relative workspace/reports/evaluations/...');
  } else {
    fail(`root layout normalization wrong: ${atRoot}`);
  }

  // Non-report links are left untouched — including external URLs that happen
  // to contain an embedded "/workspace/reports/evaluations/" segment (must not be rewritten).
  const other = normalizeReportLink('[site](https://example.com/workspace/reports/evaluations/foo.md)', dataDir, repo);
  if (other === '[site](https://example.com/workspace/reports/evaluations/foo.md)') {
    pass('non-report links (incl. URLs with embedded /workspace/reports/evaluations/) are left untouched');
  } else {
    fail(`non-report link altered: ${other}`);
  }

  const pipelineProcessed = normalizeReportLink('[12](workspace/reports/evaluations/012-acme-2026-01-04.md)', join(repo, 'workspace', 'search'), repo);
  if (pipelineProcessed === '[12](../reports/evaluations/012-acme-2026-01-04.md)') {
    pass('pipeline processed links are relative to workspace/search/pipeline.md (#1126)');
  } else {
    fail(`pipeline processed link normalization wrong (#1126): ${pipelineProcessed}`);
  }

  // End-to-end migration against a fictional fixture tracker (no personal data)
  const tmpDir = mkdtempSync(join(tmpdir(), 'frontrunner-migrate-'));
  try {
    mkdirSync(join(tmpDir, 'workspace', 'applications'), { recursive: true });
    mkdirSync(join(tmpDir, 'workspace', 'reports', 'evaluations'), { recursive: true });
    writeFileSync(join(tmpDir, 'workspace', 'reports', 'evaluations', '012-acme-2026-01-04.md'), '# fixture\n');
    const tracker = join(tmpDir, 'workspace', 'applications', 'tracker.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 12 | 2026-01-04 | Acme | Engineer | 4.2/5 | Evaluated | ✅ | [12](workspace/reports/evaluations/012-acme-2026-01-04.md) | ok |\n');

    // Migrate by pointing the script at the fixture tracker via env override.
    run(NODE, ['src/tracker/merge-tracker.mjs', '--migrate'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker } });
    const after = readFileSync(tracker, 'utf-8');
    if (after.includes('[12](../reports/evaluations/012-acme-2026-01-04.md)')) {
      pass('migration rewrites fixture tracker links to ../reports/evaluations/...');
    } else {
      fail('migration did not rewrite fixture tracker link');
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const { resolveReportPath } = await import(pathToFileURL(join(ROOT, 'src/tracker/followup-cadence.mjs')).href);
  const followupTmp = mkdtempSync(join(tmpdir(), 'frontrunner-followup-link-'));
  try {
    mkdirSync(join(followupTmp, 'workspace', 'applications'), { recursive: true });
    mkdirSync(join(followupTmp, 'workspace', 'reports', 'evaluations'), { recursive: true });
    const reportFile = join(followupTmp, 'workspace', 'reports', 'evaluations', '012-acme-2026-01-04.md');
    writeFileSync(reportFile, '# fixture\n');
    const appsFile = join(followupTmp, 'workspace', 'applications', 'tracker.md');
    const resolved = resolveReportPath('[12](../reports/evaluations/012-acme-2026-01-04.md)', appsFile, followupTmp);
    if (resolved === 'workspace/reports/evaluations/012-acme-2026-01-04.md') {
      pass('follow-up reportPath is repo-root relative for data/ tracker links (#1126)');
    } else {
      fail(`follow-up reportPath wrong (#1126): ${resolved}`);
    }
    const escaped = resolveReportPath('[99](../../outside.md)', appsFile, followupTmp);
    if (escaped === null) {
      pass('follow-up reportPath rejects links outside workspace/reports/evaluations/ (#1126)');
    } else {
      fail(`follow-up reportPath allowed escaped link (#1126): ${escaped}`);
    }
  } finally {
    rmSync(followupTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`tracker-link normalization tests crashed: ${e.message}`);
}

// ── RESERVE-REPORT-NUM RANGE RESERVATION (#1426) ────────────────
// Manual multi-agent fan-outs need N report numbers up front. --count N
// reserves a contiguous range (per-slot atomic sentinels); tests run against
// a temp dir via the FRONTRUNNER_REPORTS_DIR override.
console.log('\n🧪 Testing reserve-report-num env override and range reservation...');
try {
  const RESERVE = join(ROOT, 'src/tracker/reserve-report-num.mjs');
  const reserveRun = (args, dir, tracker = join(dir, 'applications.md')) => execFileSync(NODE, [RESERVE, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, FRONTRUNNER_REPORTS_DIR: dir, FRONTRUNNER_TRACKER: tracker },
  }).trim();

  // Importing the module must expose the same allocator used by the CLI,
  // without running the CLI as an import side effect.
  const apiTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-api-'));
  const apiTracker = join(apiTmp, 'applications.md');
  const apiProbe = execFileSync(NODE, ['--input-type=module', '--eval', `
    const api = await import(${JSON.stringify(pathToFileURL(RESERVE).href)});
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const nums = await api.reserveReportNumbers(1, {
      reportsDir: process.env.FRONTRUNNER_REPORTS_DIR,
      trackerPath: process.env.FRONTRUNNER_TRACKER,
    });
    const sentinel = join(process.env.FRONTRUNNER_REPORTS_DIR, '001-RESERVED.md');
    let firstToken = null;
    try { firstToken = JSON.parse(readFileSync(sentinel, 'utf-8')).token; } catch {}
    await api.releaseReportNumbers(nums, {
      reportsDir: process.env.FRONTRUNNER_REPORTS_DIR,
      trackerPath: process.env.FRONTRUNNER_TRACKER,
    });
    const replacement = await api.reserveReportNumbers(1, {
      reportsDir: process.env.FRONTRUNNER_REPORTS_DIR,
      trackerPath: process.env.FRONTRUNNER_TRACKER,
    });
    let replacementToken = null;
    try { replacementToken = JSON.parse(readFileSync(sentinel, 'utf-8')).token; } catch {}
    await api.releaseReportNumbers(nums, {
      reportsDir: process.env.FRONTRUNNER_REPORTS_DIR,
      trackerPath: process.env.FRONTRUNNER_TRACKER,
    });
    const replacementPreserved = existsSync(sentinel);
    await api.releaseReportNumbers(replacement, {
      reportsDir: process.env.FRONTRUNNER_REPORTS_DIR,
      trackerPath: process.env.FRONTRUNNER_TRACKER,
    });
    console.log(JSON.stringify({
      nums,
      formatted: api.formatReportNumber(nums[0]),
      firstToken,
      replacementToken,
      replacementPreserved,
      replacementCleaned: !existsSync(sentinel),
    }));
  `], {
    encoding: 'utf-8',
    env: { ...process.env, FRONTRUNNER_REPORTS_DIR: apiTmp, FRONTRUNNER_TRACKER: apiTracker },
  }).trim();
  let apiResult = null;
  try { apiResult = JSON.parse(apiProbe); } catch {}
  if (apiResult?.nums?.[0] === 1 && apiResult.formatted === '001'
      && apiResult.firstToken && apiResult.replacementToken
      && apiResult.firstToken !== apiResult.replacementToken
      && apiResult.replacementPreserved && apiResult.replacementCleaned) {
    pass('reserve-report-num token ownership prevents stale cleanup from deleting a replacement claim');
  } else {
    fail(`reserve-report-num import API failed: ${apiProbe}`);
  }
  rmSync(apiTmp, { recursive: true, force: true });

  const trackerParseApi = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker-parse.mjs')).href);
  const complexLinkNums = trackerParseApi.extractTrackerReportNumbers(
    '[22](../reports/evaluations/021-acme_(us)-2026-07-15.md "US role")',
  );
  const angleLinkNums = trackerParseApi.extractTrackerReportNumbers(
    '[23](<../reports/evaluations/023-acme role-(eu)-2026-07-15.md> \'EU role\')',
  );
  if (complexLinkNums.join(',') === '22,21' && angleLinkNums.join(',') === '23') {
    pass('tracker report-link parsing supports balanced parentheses, spaces, and optional titles');
  } else {
    fail(`complex tracker report links parsed incorrectly: ${complexLinkNums} / ${angleLinkNums}`);
  }

  const reserveTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-'));
  const single = reserveRun([], reserveTmp);
  if (single === '001' && existsSync(join(reserveTmp, '001-RESERVED.md'))) {
    pass('FRONTRUNNER_REPORTS_DIR override redirects sentinel to temp dir');
  } else {
    fail(`env override failed: stdout=${single}, sentinel in tmp=${existsSync(join(reserveTmp, '001-RESERVED.md'))}`);
  }
  rmSync(reserveTmp, { recursive: true, force: true });

  // Tracker IDs and linked report IDs are occupied even when their report
  // files are missing (for example after a partial sync or manual archive).
  const trackerTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-tracker-'));
  const trackerFile = join(trackerTmp, 'applications.md');
  writeFileSync(trackerFile,
    '# Applications Tracker\n\n' +
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    '| 7 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [12](../reports/evaluations/012-acme-2026-01-01.md) | fixture |\n');
  const afterTracker = reserveRun([], join(trackerTmp, 'reports'), trackerFile);
  if (afterTracker === '013') {
    pass('reservation accounts for tracker row IDs and linked report IDs');
  } else {
    fail(`tracker-aware reservation produced ${afterTracker}, expected 013`);
  }
  rmSync(trackerTmp, { recursive: true, force: true });

  // Formatting is a minimum width, not a three-digit ceiling.
  const fourDigitTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-4digit-'));
  const fourDigitTracker = join(fourDigitTmp, 'applications.md');
  writeFileSync(fourDigitTracker,
    '# Applications Tracker\n\n' +
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    '| 1000 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | fixture |\n');
  const fourDigit = reserveRun([], join(fourDigitTmp, 'reports'), fourDigitTracker);
  if (fourDigit === '1001' && existsSync(join(fourDigitTmp, 'reports', '1001-RESERVED.md'))) {
    pass('reservation continues beyond 999 without truncation or reset');
  } else {
    fail(`four-digit reservation produced ${fourDigit}, expected 1001`);
  }
  rmSync(fourDigitTmp, { recursive: true, force: true });

  const unsafeRangeTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-unsafe-range-'));
  const unsafeRangeReports = join(unsafeRangeTmp, 'reports');
  const unsafeRangeTracker = join(unsafeRangeTmp, 'applications.md');
  mkdirSync(unsafeRangeReports);
  writeFileSync(
    join(unsafeRangeReports, `${Number.MAX_SAFE_INTEGER - 1}-existing.md`),
    '# fixture',
  );
  const allocatorApi = await import(`${pathToFileURL(RESERVE).href}?unsafe-range=${Date.now()}`);
  let unsafeRangeError = null;
  try {
    await allocatorApi.reserveReportNumbers(2, {
      reportsDir: unsafeRangeReports,
      trackerPath: unsafeRangeTracker,
    });
  } catch (err) {
    unsafeRangeError = err;
  }
  const unsafeRangeLeaked = readdirSync(unsafeRangeReports)
    .some(name => name.endsWith('-RESERVED.md'));
  if (unsafeRangeError instanceof RangeError && !unsafeRangeLeaked) {
    pass('unsafe report-number ranges fail before creating a partial sentinel');
  } else {
    fail(`unsafe range guard failed: error=${unsafeRangeError?.message}, leaked=${unsafeRangeLeaked}`);
  }
  rmSync(unsafeRangeTmp, { recursive: true, force: true });

  const evaluatorSources = ['src\/evaluate\/ollama-eval.mjs', 'src\/evaluate\/openai-eval.mjs', 'src\/evaluate\/gemini-eval.mjs', 'src\/evaluate\/openrouter-runner.mjs']
    .map(name => [name, readFile(name)]);
  const unmigratedEvaluators = evaluatorSources
    .filter(([, source]) => !/saveEvaluation\s*\(/.test(source)
      || /reserveReportNumbers\s*\(/.test(source)
      || /writeFileSync\s*\([^)]*report/i.test(source)
      || /function\s+nextReport(?:Number|Num)\s*\(/.test(source))
    .map(([name]) => name);
  if (unmigratedEvaluators.length === 0) {
    pass('all headless evaluators use the shared transactional publisher');
  } else {
    fail(`headless evaluators bypass the shared transactional publisher: ${unmigratedEvaluators.join(', ')}`);
  }

  // --count N: contiguous range from an empty dir.
  const rangeTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-range-'));
  const range = reserveRun(['--count', '3'], rangeTmp);
  const rangeSentinels = ['001', '002', '003']
    .every(n => existsSync(join(rangeTmp, `${n}-RESERVED.md`)));
  if (range === '001-003' && rangeSentinels) {
    pass('--count 3 reserves contiguous range and prints START-END');
  } else {
    fail(`--count 3 produced stdout=${range}, all sentinels=${rangeSentinels}`);
  }

  // --count N continues after existing reports.
  writeFileSync(join(rangeTmp, '007-acme-2026-07-02.md'), '# stub');
  const afterExisting = reserveRun(['--count', '2'], rangeTmp);
  if (afterExisting === '008-009') {
    pass('--count starts range after highest existing slot');
  } else {
    fail(`--count after existing report produced ${afterExisting}, expected 008-009`);
  }

  // --count 1 keeps the single-number output format (backwards compatible).
  const countOne = reserveRun(['--count', '1'], rangeTmp);
  if (countOne === '010') {
    pass('--count 1 prints single number without dash');
  } else {
    fail(`--count 1 produced ${countOne}, expected 010`);
  }
  rmSync(rangeTmp, { recursive: true, force: true });

  // Collision mid-range: pre-place a sentinel at 007 with existing max 005.
  // maxSlot() counts RESERVED sentinels as occupied, so a foreign sentinel at
  // 007 bases the range past it (008-) — no slot below is ever attempted.
  // (The rollback path is exercised by the next test, not this one.)
  const collideTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-collide-'));
  writeFileSync(join(collideTmp, '005-acme-2026-07-02.md'), '# stub');
  writeFileSync(join(collideTmp, '007-RESERVED.md'), '');
  const collided = reserveRun(['--count', '3'], collideTmp);
  const leaked006 = existsSync(join(collideTmp, '006-RESERVED.md'));
  const foreign007 = existsSync(join(collideTmp, '007-RESERVED.md'));
  if (collided === '008-010' && !leaked006 && foreign007) {
    pass('--count treats a foreign sentinel as occupied and bases the range past it');
  } else {
    fail(`sentinel-as-occupied: stdout=${collided} (want 008-010), 006 sentinel=${leaked006}, foreign 007 kept=${foreign007}`);
  }
  rmSync(collideTmp, { recursive: true, force: true });

  // Existing four-digit report names participate in the same occupancy scan.
  const highRangeTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-high-range-'));
  writeFileSync(join(highRangeTmp, '999-acme-2026-07-02.md'), '# stub');
  writeFileSync(join(highRangeTmp, '1001-taken.md'), '# stub');
  const highRange = reserveRun(['--count', '3'], highRangeTmp);
  const skipped1000 = !existsSync(join(highRangeTmp, '1000-RESERVED.md'));
  const blocker1001 = existsSync(join(highRangeTmp, '1001-taken.md'));
  const reservedHighRange = ['1002', '1003', '1004']
    .every(n => existsSync(join(highRangeTmp, `${n}-RESERVED.md`)));
  if (highRange === '1002-1004' && skipped1000 && blocker1001 && reservedHighRange) {
    pass('four-digit report files advance a contiguous range without truncation');
  } else {
    fail(`four-digit range: stdout=${highRange} (want 1002-1004), 1000 skipped=${skipped1000}, blocker kept=${blocker1001}, sentinels=${reservedHighRange}`);
  }
  rmSync(highRangeTmp, { recursive: true, force: true });

  // Range-vs-range: two concurrent --count 4 reservations must not overlap.
  // Terminates by construction: each restart strictly advances the base.
  let reserveRetries = 1;
  while (reserveRetries >= 0) {
    const concTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-conc-'));
    try {
      const spawnReserve = () => new Promise(resolve => {
        const child = spawn(NODE, [RESERVE, '--count', '4'], {
          env: { ...process.env, FRONTRUNNER_REPORTS_DIR: concTmp },
        });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('close', () => resolve(stdout.trim()));
      });
      const [rangeX, rangeY] = await Promise.all([spawnReserve(), spawnReserve()]);
      const toNums = r => {
        const [s, e] = r.split('-').map(Number);
        return Array.from({ length: e - s + 1 }, (_, i) => s + i);
      };
      const overlap = toNums(rangeX).filter(n => toNums(rangeY).includes(n));
      if (rangeX && rangeY && overlap.length === 0) {
        pass(`concurrent --count 4 reservations are disjoint (${rangeX} vs ${rangeY})`);
      } else {
        throw new Error(`concurrent ranges overlap: ${rangeX} vs ${rangeY} share [${overlap}]`);
      }
      break;
    } catch (e) {
      if (reserveRetries > 0) {
        warn(`concurrent reservation test flaked (${e.message}). Retrying once...`);
        reserveRetries -= 1;
      } else {
        fail(`concurrent reservation test failed: ${e.message}`);
        break;
      }
    } finally {
      rmSync(concTmp, { recursive: true, force: true });
    }
  }

  // --release with a range deletes every sentinel in it.
  const reserveRunFail = (args, dir) => {
    try {
      execFileSync(NODE, [RESERVE, ...args], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FRONTRUNNER_REPORTS_DIR: dir, FRONTRUNNER_TRACKER: join(dir, 'applications.md') },
      });
      return null;
    } catch (err) {
      return err.status;
    }
  };
  const relTmp = mkdtempSync(join(tmpdir(), 'frontrunner-reserve-release-'));
  reserveRun(['--count', '4'], relTmp); // reserves 001-004
  reserveRun(['--release', '001-004'], relTmp);
  const anyLeft = ['001', '002', '003', '004']
    .some(n => existsSync(join(relTmp, `${n}-RESERVED.md`)));
  if (!anyLeft) {
    pass('--release NNN-MMM deletes all sentinels in range');
  } else {
    fail('--release range left sentinels behind');
  }

  // Invalid inputs exit non-zero.
  const badCount = reserveRunFail(['--count', '0'], relTmp);
  const hugeCount = reserveRunFail(['--count', '999'], relTmp);
  const badRelease = reserveRunFail(['--release', '009-004'], relTmp);
  const hugeRelease = reserveRunFail(['--release', '1-9007199254740992'], relTmp);
  const wideRelease = reserveRunFail(['--release', '1-51'], relTmp);
  if (badCount === 1 && hugeCount === 1 && badRelease === 1
      && hugeRelease === 1 && wideRelease === 1) {
    pass('invalid counts and unsafe, inverted, or oversized release ranges exit 1');
  } else {
    fail(`validation exits: count0=${badCount}, count999=${hugeCount}, inverted=${badRelease}, unsafe=${hugeRelease}, wide=${wideRelease}`);
  }
  rmSync(relTmp, { recursive: true, force: true });
} catch (e) {
  fail(`reserve-report-num tests crashed: ${e.message}`);
}

// ── VERIFY-PIPELINE REPORT CHECKS (#1425) ───────────────────────
// Parallel evaluators can write two reports for the same company+role, and
// tracker dedup can leave a report file with no tracker row. verify-pipeline
// must surface both as warnings (not errors — re-evaluations are legitimate).
console.log('\n🧪 Testing verify-pipeline duplicate/orphan report checks...');
try {
  const vpTmp = mkdtempSync(join(tmpdir(), 'frontrunner-verify-reports-'));
  try {
    const vpReports = join(vpTmp, 'workspace', 'reports', 'evaluations');
    mkdirSync(vpReports, { recursive: true });
    const vpTracker = join(vpTmp, 'workspace', 'applications', 'tracker.md');
    mkdirSync(dirname(vpTracker), { recursive: true });
    const vpEnv = { ...process.env, FRONTRUNNER_TRACKER: vpTracker, FRONTRUNNER_REPORTS: vpReports };

    const report = (company, role) =>
      `# Evaluación: ${company} — ${role}\n\n## Machine Summary\n\n\`\`\`yaml\ncompany: "${company}"\nrole: "${role}"\nscore: 4.2\n\`\`\`\n`;

    // #1 and #3 are the same role at Acme written by two concurrent workers;
    // #2 is a different Acme role (must NOT be flagged as duplicate);
    // #3 also has no tracker row (orphan — tracker dedup kept #1).
    writeFileSync(join(vpReports, '001-acme-2026-01-04.md'), report('Acme', 'Staff AI Engineer'));
    writeFileSync(join(vpReports, '002-acme-2026-01-05.md'), report('Acme', 'Platform Engineer'));
    writeFileSync(join(vpReports, '003-acme-2026-01-05.md'), report('Acme', 'Staff AI Engineer'));

    writeFileSync(vpTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | Acme | Staff AI Engineer | 4.2/5 | Evaluated | ❌ | [1](../reports/evaluations/001-acme-2026-01-04.md) | ok |\n' +
      '| 2 | 2026-01-05 | Acme | Platform Engineer | 4.0/5 | Evaluated | ❌ | [2](../reports/evaluations/002-acme-2026-01-05.md) | ok |\n');

    const vpOut = run(NODE, ['src/tracker/verify-pipeline.mjs'], { env: vpEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (vpOut === null) {
      fail('verify-pipeline crashed on duplicate/orphan report fixture');
    } else {
      if (vpOut.includes('Duplicate reports for same company+role') &&
          vpOut.includes('001-acme-2026-01-04.md') && vpOut.includes('003-acme-2026-01-05.md')) {
        pass('duplicate reports for the same company+role are flagged (#1425)');
      } else {
        fail('duplicate company+role reports not flagged');
      }
      if (vpOut.includes('002-acme-2026-01-05.md') && /Duplicate reports[^\n]*002-acme/.test(vpOut)) {
        fail('different role at the same company falsely flagged as duplicate report');
      } else {
        pass('different role at the same company is not flagged as duplicate');
      }
      if (/Orphan report[^\n]*#3[^\n]*003-acme-2026-01-05\.md/.test(vpOut)) {
        pass('orphan report with no tracker row is flagged (#1425)');
      } else {
        fail('orphan report not flagged');
      }
      if (/Orphan report[^\n]*(001|002)-acme/.test(vpOut)) {
        fail('referenced report falsely flagged as orphan');
      } else {
        pass('referenced reports are not flagged as orphans');
      }
      // run() returns non-null only on exit 0 — warnings must not fail the check.
      pass('duplicate/orphan report findings stay warning-level (exit 0)');
    }

    // Clean fixture: one row, one report — both checks must pass green.
    rmSync(join(vpReports, '003-acme-2026-01-05.md'));
    const vpClean = run(NODE, ['src/tracker/verify-pipeline.mjs'], { env: vpEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    if (vpClean !== null &&
        vpClean.includes('No duplicate reports for the same company+role') &&
        vpClean.includes('No orphan reports')) {
      pass('clean tracker+reports fixture passes both report checks');
    } else {
      fail('clean fixture did not pass duplicate/orphan report checks');
    }
  } finally {
    rmSync(vpTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`verify-pipeline report checks crashed: ${e.message}`);
}

// ── VERIFY-PIPELINE DUPLICATE TRACKER NUMBER (#1704) ────────────
// A tracker # must be a unique row id. Two rows sharing a # is never
// legitimate (unlike Check 2's company+role dedup, which can false-positive
// on a genuine re-application) — verify-pipeline must flag it as an error.
console.log('\n🧪 Testing verify-pipeline duplicate tracker # check (#1704)...');
try {
  const dupNumTmp = mkdtempSync(join(tmpdir(), 'frontrunner-verify-dupnum-'));
  try {
    const dupNumTracker = join(dupNumTmp, 'applications.md');
    const dupNumEnv = { ...process.env, FRONTRUNNER_TRACKER: dupNumTracker };

    writeFileSync(dupNumTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 698 | 2026-05-29 | University of Alberta | Curriculum Coordinator | 3.8/5 | Evaluated | ❌ | — | — |\n' +
      '| 698 | 2026-06-03 | Esri Canada | Manager Talent and Organizational Development | 4.1/5 | Evaluated | ❌ | — | — |\n' +
      '| 700 | 2026-06-10 | Shopify | Staff Engineer | 4.5/5 | Evaluated | ❌ | — | — |\n');

    let dupNumOut;
    try {
      dupNumOut = execFileSync(NODE, ['src/tracker/verify-pipeline.mjs'], { cwd: ROOT, env: dupNumEnv, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      fail('verify-pipeline should exit non-zero on a duplicate tracker number');
    } catch (e) {
      dupNumOut = (e.stdout || '').toString();
      if (e.status === 1) {
        pass('verify-pipeline exits 1 on a duplicate tracker number');
      } else {
        fail(`verify-pipeline: expected exit 1, got ${e.status}`);
      }
    }
    if (dupNumOut.includes('Duplicate tracker number #698')
        && dupNumOut.includes('University of Alberta') && dupNumOut.includes('Esri Canada')) {
      pass('duplicate tracker number #698 flagged with both colliding rows named');
    } else {
      fail(`duplicate tracker number not flagged with both rows\n${dupNumOut}`);
    }
    if (/Duplicate tracker number #700/.test(dupNumOut)) {
      fail('unique #700 row falsely flagged as a duplicate tracker number');
    } else {
      pass('unique tracker number not falsely flagged');
    }
  } finally {
    rmSync(dupNumTmp, { recursive: true, force: true });
  }

  // Clean fixture: no duplicate numbers — must pass green.
  const cleanTmp = mkdtempSync(join(tmpdir(), 'frontrunner-verify-dupnum-clean-'));
  try {
    const cleanTracker = join(cleanTmp, 'applications.md');
    writeFileSync(cleanTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | — | — |\n' +
      '| 2 | 2026-01-02 | Globex | Analyst | 3.9/5 | Evaluated | ❌ | — | — |\n');
    const cleanOut = run(NODE, ['src/tracker/verify-pipeline.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: cleanTracker }, stdio: ['pipe', 'pipe', 'pipe'] });
    if (cleanOut !== null && cleanOut.includes('No duplicate tracker numbers')) {
      pass('clean tracker with unique numbers passes the duplicate-number check');
    } else {
      fail('clean fixture did not pass the duplicate tracker number check');
    }
  } finally {
    rmSync(cleanTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`verify-pipeline duplicate tracker number test crashed: ${e.message}`);
}

// ── SHARED ROLE MATCHER + DEDUP-TRACKER SAFETY (#947) ───────────
// src\/tracker\/dedup-tracker.mjs used to ship an older fuzzy role matcher than
// src\/tracker\/merge-tracker.mjs. That weaker matcher collapsed sibling roles at the same
// company when they shared generic title words such as "Full Stack Engineer",
// and could delete an already-Applied row because workspace/applications/tracker.md is
// normally gitignored. The matcher is now shared, and dedup protects advanced
// application states from fuzzy-only deletion.
console.log('\n🧪 Testing shared role matcher and dedup-tracker safety...');
try {
  const { roleFuzzyMatch, roleTokens } = await import(pathToFileURL(join(ROOT, 'src/tracker/role-matcher.mjs')).href);

  if (!roleFuzzyMatch('Full Stack Engineer, Foundation', 'Full Stack Engineer, Guarded Releases')) {
    pass('role matcher keeps Full Stack Engineer sibling teams distinct (#947)');
  } else {
    fail('role matcher still collapses distinct Full Stack Engineer sibling teams');
  }

  if (!roleFuzzyMatch('Staff Software Engineer, API', 'Staff Software Engineer, SDK')) {
    pass('role matcher keeps short-acronym sibling teams distinct');
  } else {
    fail('role matcher collapsed API and SDK sibling teams');
  }

  if (roleFuzzyMatch('Staff Software Engineer, API', 'Staff Software Engineer, API Platform')) {
    pass('role matcher still uses short specialty acronyms for true overlaps');
  } else {
    fail('role matcher ignored a real short-acronym overlap');
  }

  // 'product' is a baseline token: "ai" is dropped by the tokenizer (2-letter,
  // not in SHORT_SPECIALTY), so without this these titles collapse to
  // [product, manager] and merge-tracker skips one as a false duplicate.
  if (!roleFuzzyMatch('Product Manager - Marketplace', 'Product Manager - AI')) {
    pass('role matcher keeps Product Manager sibling specialties distinct');
  } else {
    fail('role matcher collapsed Product Manager - Marketplace into Product Manager - AI');
  }

  if (roleFuzzyMatch('Product Manager - Marketplace', 'Product Manager - Marketplace')) {
    pass('role matcher still matches identical Product Manager titles');
  } else {
    fail('role matcher rejected an identical Product Manager title');
  }

  // A generic base title (no suffix of its own) shares every one of its tokens
  // with a specialized sibling, so the shared tokens alone used to cross the
  // Jaccard threshold — even though the sibling's extra word is exactly the
  // signal that these are two different, separately-postable openings.
  if (!roleFuzzyMatch('Senior Analytics Engineer', 'Senior Analytics Engineer, People Analytics')) {
    pass('role matcher keeps a base title distinct from its specialized-suffix sibling (#1881)');
  } else {
    fail('role matcher collapsed a base title into its specialized-suffix sibling');
  }

  // A true repost of the same base title must still match.
  if (roleFuzzyMatch('Senior Analytics Engineer', 'Senior Analytics Engineer')) {
    pass('role matcher still matches an exact-title repost');
  } else {
    fail('role matcher rejected an exact-title repost');
  }

  // Seniority omitted on one side is not a specialization suffix — still a repost.
  if (roleFuzzyMatch('Data Engineer', 'Senior Data Engineer')) {
    pass('role matcher still matches when seniority is only stated on one side');
  } else {
    fail('role matcher rejected a repost that only adds a seniority word');
  }

  // A sub-baseline qualifier on ONE side is a level disagreement, not a loose
  // rewrite: the tokenizer drops seniority words as stopwords, so these pairs
  // otherwise tokenize identically and scored a perfect Jaccard ratio, silently
  // collapsing two genuinely different requisitions (#2009).
  for (const [lower, bare] of [
    ['Associate Product Manager, TeamName', 'Product Manager, TeamName'],
    ['Junior Product Manager, TeamName', 'Product Manager, TeamName'],
    ['Entry Level Data Engineer', 'Data Engineer'],
  ]) {
    if (!roleFuzzyMatch(lower, bare)) {
      pass(`role matcher keeps "${lower}" distinct from the bare title (#2009)`);
    } else {
      fail(`role matcher collapsed "${lower}" into the bare title "${bare}"`);
    }
  }

  // Direction must not matter — the lone qualifier can be on either side.
  if (!roleFuzzyMatch('Product Manager, TeamName', 'Associate Product Manager, TeamName')) {
    pass('role matcher applies the sub-baseline gate in both argument orders (#2009)');
  } else {
    fail('role matcher only applied the sub-baseline gate in one argument order');
  }

  // Both sides sub-baseline at the same level is still the same opening.
  if (roleFuzzyMatch('Associate Product Manager, TeamName', 'Associate Product Manager, TeamName')) {
    pass('role matcher still matches two same-level Associate reposts (#2009)');
  } else {
    fail('role matcher rejected a genuine Associate-level repost');
  }

  // A repost annotation is tracking metadata, not a specialization — must still match.
  if (roleFuzzyMatch('Learning Development Designer III', 'Learning Development Designer III (Repost)')) {
    pass('role matcher does not treat a "(Repost)" annotation as a specialization marker');
  } else {
    fail('role matcher wrongly treated a "(Repost)" annotation as a distinct sibling role');
  }

  // "Member of Technical Staff" is a boilerplate level-prefix used by several
  // companies for senior IC titles. Without stripping it, "member" and
  // "technical" leaked through as apparently-discriminating tokens and made two
  // genuinely different roles register as a fuzzy-match false positive.
  if (!roleFuzzyMatch('Member of Technical Staff, Connector Platform', 'Member of Technical Staff, Backend Platform')) {
    pass('role matcher keeps distinct "Member of Technical Staff" sibling roles apart');
  } else {
    fail('role matcher collapsed distinct "Member of Technical Staff" sibling roles');
  }

  if (roleFuzzyMatch('Member of Technical Staff, Connector Platform', 'Member of Technical Staff, Connector Platform')) {
    pass('role matcher still matches an exact "Member of Technical Staff" repost');
  } else {
    fail('role matcher rejected an exact "Member of Technical Staff" repost');
  }

  // The MTS fix strips the literal "member of technical staff" phrase, not a
  // blanket stopword on "member"/"technical" — those words must keep their
  // normal discriminating role in titles where the phrase isn't present.
  if (!roleFuzzyMatch('Technical Writer, API Docs', 'Technical Writer, Onboarding Guides')) {
    pass('role matcher still treats "technical" as discriminating outside the MTS phrase');
  } else {
    fail('role matcher over-stripped "technical" outside the MTS phrase');
  }

  // A blanket "technical" stopword would also break real reposts: stripped from
  // both sides here, only "recruiter" is left, which alone can't clear the
  // 2-token overlap minimum. Phrase-aware stripping keeps "technical" as a
  // normal contributing token outside the MTS phrase, so the repost still matches.
  if (roleFuzzyMatch('Senior Technical Recruiter, EMEA', 'Technical Recruiter, EMEA')) {
    pass('role matcher still matches a real repost that happens to contain "technical"');
  } else {
    fail('role matcher rejected a real repost because "technical" was over-stripped');
  }

  // Stripping the MTS phrase can leave 0-1 tokens for a bare or short-suffix
  // title, which would otherwise fall short of the 2-token overlap minimum —
  // even for an exact repost of itself. The exact-match fast path in
  // roleFuzzyMatch guards this regardless of tokenization.
  if (roleFuzzyMatch('Member of Technical Staff', 'Member of Technical Staff')) {
    pass('role matcher matches a bare "Member of Technical Staff" exact repost');
  } else {
    fail('role matcher rejected a bare "Member of Technical Staff" exact repost');
  }

  if (roleFuzzyMatch('Member of Technical Staff, Backend', 'Member of Technical Staff, Backend')) {
    pass('role matcher matches an exact repost of a short-suffix MTS title');
  } else {
    fail('role matcher rejected an exact repost of a short-suffix MTS title');
  }

  // A non-identical repost (different punctuation) with a genuinely
  // discriminating one-word suffix still needs 2+ tokens to clear the
  // overlap minimum — the "engineer" filler (a BASELINE_TOKENS entry) pads
  // that count without ever being the sole reason two titles match.
  if (roleFuzzyMatch('Member of Technical Staff, Connector', 'Member of Technical Staff - Connector')) {
    pass('role matcher matches a punctuation-variant repost of a short-suffix MTS title');
  } else {
    fail('role matcher rejected a punctuation-variant repost of a short-suffix MTS title');
  }

  if (roleFuzzyMatch('Member of Technical Staff, Connector', 'Member of Technical Staff, Backend')) {
    fail('role matcher collapsed distinct one-word-suffix MTS roles via the "engineer" filler');
  } else {
    pass('role matcher keeps distinct one-word-suffix MTS roles apart despite the "engineer" filler');
  }

  // Slashed short acronyms used to vanish in tokenization ("(CI/CD)" → "ci cd"
  // → both dropped by the length filter), so a sibling req whose ONLY
  // distinguishing qualifier is a slashed acronym tokenized identically to the
  // bare title — the #1881 subset guard never saw an extra token — and
  // merge-tracker overwrote the Applied row's title/score/report (#2165).
  if (!roleFuzzyMatch(
    'Senior Software Engineer, Infrastructure',
    'Senior Software Engineer, Infrastructure (CI/CD)'
  )) {
    pass('role matcher keeps a slash-acronym-qualified sibling req distinct (#2165)');
  } else {
    fail('role matcher still collapses sibling reqs whose only qualifier is a slashed acronym');
  }

  if (roleFuzzyMatch(
    'Senior Software Engineer, Infrastructure (CI/CD)',
    'Senior Software Engineer, Infrastructure CI/CD'
  )) {
    pass('role matcher still matches the same slash-acronym role across punctuation variants');
  } else {
    fail('role matcher stopped matching identical slash-acronym roles');
  }

  // Accented Latin titles used to split at the accent instead of folding it, so
  // "Sênior" tokenized to ["s", "nior"]: "s" fell to the length filter and
  // "nior" survived as a phantom token that is in no stopword list. Every
  // downstream rule then misfired at once (#2207).
  // Assert the whole token list, not just the absence of "nior": a fix that
  // merely deleted non-ASCII would still leave a phantom ("snior") and pass a
  // negative check.
  const accentTokens = roleTokens('Software Engineer Node.js Sênior');
  const plainTokens = roleTokens('Software Engineer Node.js Senior');
  if (JSON.stringify(accentTokens) === JSON.stringify(plainTokens)) {
    pass('role tokenizer folds accents onto the plain-ASCII token list (#2207)');
  } else {
    fail(`accented title tokenized differently from its plain spelling: ${JSON.stringify(accentTokens)} vs ${JSON.stringify(plainTokens)}`);
  }

  // Folding must delete combining marks only. Standalone characters such as
  // "·" are separators in a title; deleting them would glue two words into a
  // single token and turn a real repost into a duplicate row.
  const separatorTokens = roleTokens('Backend Engineer·Payments');
  if (separatorTokens.includes('payments') && !separatorTokens.some(w => w.includes('engineerpayments'))) {
    pass('accent folding leaves standalone separator characters splitting words (#2207)');
  } else {
    fail(`accent folding swallowed a separator character: ${JSON.stringify(separatorTokens)}`);
  }

  // The phantom token is shared by every accented title, so it acted as a
  // discriminating overlap and pushed two unrelated roles past the Jaccard
  // threshold — exactly what the baseline-token guard exists to prevent.
  if (!roleFuzzyMatch('Software Engineer Node.js Sênior', 'Software Engineer Flutter Sênior')) {
    pass('role matcher keeps accented sibling roles distinct (#2207)');
  } else {
    fail('role matcher collapsed two accented sibling roles via the phantom accent token');
  }

  // Worse than a generic collision: "Sênior" and "Júnior" both reduce to the
  // same "nior" phantom, so opposite seniority levels matched each other while
  // the seniority-disagreement gate saw no seniority token at all.
  if (!roleFuzzyMatch('Engenheiro de Dados Sênior', 'Engenheiro de Dados Júnior')) {
    pass('role matcher keeps accented Sênior and Júnior requisitions distinct (#2207)');
  } else {
    fail('role matcher merged an accented Sênior req into an accented Júnior req');
  }

  // The same defect also caused false negatives: a genuine repost written once
  // with the accent and once without tokenized differently and never matched.
  if (roleFuzzyMatch('Engenheiro de Software Sênior, Pagamentos', 'Engenheiro de Software Senior, Pagamentos')) {
    pass('role matcher matches a repost across accented and unaccented spellings (#2207)');
  } else {
    fail('role matcher missed a repost that differs only by an accent');
  }

  // Folding must not over-merge: accented specialty words have to survive as
  // their own distinct tokens, not collapse into one another.
  if (!roleFuzzyMatch('Ingeniero de Software Sênior, Búsqueda', 'Ingeniero de Software Sênior, Pagos')) {
    pass('role matcher keeps accented specialty suffixes distinct after folding (#2207)');
  } else {
    fail('accent folding collapsed two distinct accented specialty suffixes');
  }

  // Folding is what lets the seniority gate see an accented qualifier at all.
  // Before it, "Sênior"/"Júnior" both reduced to the same "nior" phantom, which
  // survived as a non-baseline token on the qualified side only — so the
  // specialization-marker rule (strict subset + extra non-baseline word) fired
  // and returned false for BOTH. The gate itself never ran: extractSeniorities
  // saw no seniority token either way. That produced a right answer for the
  // wrong reason on "Júnior" and a plain false negative on "Sênior".
  //
  // After folding, the two cases separate on their actual meaning (#2009's
  // SUB_BASELINE_SENIORITY rule): "senior" is routinely added or dropped
  // between reposts of one req, while "junior" marks a genuinely lower-level
  // req with its own scope and req ID.
  if (roleFuzzyMatch('Sênior Product Manager, Marketplace', 'Product Manager, Marketplace')) {
    pass('accent folding lets a lone accented "Sênior" be read as the same req (#2207)');
  } else {
    fail('accented "Sênior" still blocked a repost of the same requisition');
  }

  if (!roleFuzzyMatch('Júnior Product Manager, Marketplace', 'Product Manager, Marketplace')) {
    pass('accent folding routes a lone accented "Júnior" through the sub-baseline gate (#2207)');
  } else {
    fail('accented "Júnior" collapsed a sub-baseline req into the bare title');
  }

  const dedupTmp = mkdtempSync(join(tmpdir(), 'frontrunner-dedup-'));
  try {
    mkdirSync(join(dedupTmp, 'data'));
    const tracker = join(dedupTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 21 | 2026-01-08 | Acme | Full Stack Engineer, Foundation | 3.9/5 | Applied | ❌ | [21](../reports/evaluations/021-foundation.md) | applied sibling |\n' +
      '| 22 | 2026-01-08 | Acme | Full Stack Engineer, Guarded Releases | 4.3/5 | Evaluated | ❌ | [22](../reports/evaluations/022-guarded.md) | evaluated sibling |\n' +
      '| 23 | 2026-01-08 | Acme | Staff Software Engineer, API | 4.0/5 | Evaluated | ❌ | [23](../reports/evaluations/023-api.md) | acronym sibling |\n' +
      '| 24 | 2026-01-08 | Acme | Staff Software Engineer, SDK | 4.2/5 | Evaluated | ❌ | [24](../reports/evaluations/024-sdk.md) | acronym sibling |\n' +
      '| 25 | 2026-01-08 | Acme | Product Engineer, Growth | 3.8/5 | Evaluated | ❌ | [25](../reports/evaluations/025-growth-old.md) | duplicate old |\n' +
      '| 26 | 2026-01-09 | Acme | Product Engineer, Growth | 4.0/5 | Evaluated | ❌ | [26](../reports/evaluations/026-growth-new.md) | duplicate new |\n' +
      '| 27 | 2026-01-08 | Acme | Solutions Engineer, Revenue | 3.0/5 | Applied | ❌ | [27](../reports/evaluations/027-revenue-applied.md) | applied exact-title row |\n' +
      '| 28 | 2026-01-09 | Acme | Solutions Engineer, Revenue | 4.6/5 | Evaluated | ❌ | [28](../reports/evaluations/028-revenue-eval.md) | evaluated exact-title row |\n' +
      '| 29 | 2026-01-08 | Acme | Data Engineer, Search | 3.1/5 | Applied | ❌ | [29](../reports/evaluations/029-search-old.md) | malformed duplicate-number old row |\n' +
      '| 29 | 2026-01-09 | Acme | Data Engineer, Search | 4.1/5 | Evaluated | ❌ | [30](../reports/evaluations/030-search-new.md) | malformed duplicate-number new row |\n' +
      // Distinct sibling roles at one company that the old fuzzy matcher
      // false-merged (shared [software, engineer, infrastructure] → Jaccard 0.6).
      // Exact company+title matching must keep both openings.
      '| 31 | 2026-01-10 | Cohere | Software Engineer, Data Infrastructure | 3.4/5 | Evaluated | ❌ | [31](../reports/evaluations/013-cohere-data-infra.md) | distinct role — must survive |\n' +
      '| 32 | 2026-01-10 | Cohere | Senior Software Engineer, Agent Infrastructure | 4.0/5 | Evaluated | ❌ | [32](../reports/evaluations/014-cohere-agent-infra.md) | distinct role — higher score |\n' +
      // Exact company+role duplicate of #32 (same title, both Evaluated) — must
      // collapse to one, keeping the higher score.
      '| 33 | 2026-01-11 | Cohere | Senior Software Engineer, Agent Infrastructure | 3.7/5 | Evaluated | ❌ | [33](../reports/evaluations/033-cohere-agent-dup.md) | exact-title duplicate |\n');

    const dedupResult = run(NODE, ['src/tracker/dedup-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker } });
    if (dedupResult === null) {
      fail('src/tracker/dedup-tracker.mjs crashed during shared role matcher safety test');
    } else {
      const deduped = readFileSync(tracker, 'utf-8');

      if (deduped.includes('Full Stack Engineer, Foundation') && deduped.includes('Full Stack Engineer, Guarded Releases')) {
        pass('dedup-tracker preserves distinct Full Stack Engineer sibling rows');
      } else {
        fail('dedup-tracker removed a distinct Full Stack Engineer sibling row');
      }

      if (deduped.includes('Staff Software Engineer, API') && deduped.includes('Staff Software Engineer, SDK')) {
        pass('dedup-tracker preserves short-acronym sibling rows');
      } else {
        fail('dedup-tracker removed a short-acronym sibling row');
      }

      const growthRows = deduped.split('\n').filter(l => l.includes('Product Engineer, Growth'));
      if (growthRows.length === 1 && growthRows[0].includes('4.0/5')) {
        pass('dedup-tracker still removes a real duplicate evaluated row');
      } else {
        fail(`dedup-tracker duplicate handling broken: ${growthRows.length} Growth rows`);
      }

      const revenueRows = deduped.split('\n').filter(l => l.includes('Solutions Engineer, Revenue'));
      if (revenueRows.length === 2 && revenueRows.some(l => l.includes('Applied'))) {
        pass('dedup-tracker never removes Applied+ rows by fuzzy title match');
      } else {
        fail('dedup-tracker removed an Applied+ row by fuzzy title match');
      }

      const searchRows = deduped.split('\n').filter(l => l.includes('Data Engineer, Search'));
      if (searchRows.length === 1 && searchRows[0].includes('4.1/5') && searchRows[0].includes('Applied')) {
        pass('dedup-tracker handles duplicate tracker numbers using row-local line indexes');
      } else {
        fail(`dedup-tracker duplicate-number handling broken: ${searchRows.length} Search rows`);
      }

      // Regression: the old fuzzy matcher scored "Software Engineer, Data
      // Infrastructure" and "Senior Software Engineer, Agent Infrastructure" at
      // Jaccard 0.6 and deleted the lower-scored distinct role. Exact
      // company+title matching must keep both openings.
      const cohereDataInfra = deduped.split('\n').filter(l => l.includes('| Software Engineer, Data Infrastructure |'));
      if (cohereDataInfra.length === 1) {
        pass('dedup-tracker keeps distinct same-company Cohere role (Data Infrastructure) — no fuzzy false-merge');
      } else {
        fail(`dedup-tracker false-merged the distinct Cohere Data Infrastructure role: ${cohereDataInfra.length} rows`);
      }

      const cohereAgentInfra = deduped.split('\n').filter(l => l.includes('| Senior Software Engineer, Agent Infrastructure |'));
      if (cohereAgentInfra.length === 1 && cohereAgentInfra[0].includes('4.0/5')) {
        pass('dedup-tracker merges an exact company+role duplicate to one (keeps highest score)');
      } else {
        fail(`dedup-tracker exact-duplicate handling broken: ${cohereAgentInfra.length} Cohere Agent Infrastructure rows`);
      }
    }
  } finally {
    rmSync(dedupTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`shared role matcher / dedup safety tests crashed: ${e.message}`);
}

// dedup-tracker / normalize-statuses rebuilt promoted rows with
// `parts.slice(1, -1)`, which assumes the closing `|` produced a trailing empty
// cell. A valid row written WITHOUT a trailing pipe keeps its real last cell
// (the notes) at the end, so the old reconstruction silently dropped the notes
// when promoting a keeper's status during dedup. rebuildRow() now preserves it.
console.log('\n🧪 Testing dedup row rebuild preserves notes on no-trailing-pipe rows...');
try {
  const rebuildTmp = mkdtempSync(join(tmpdir(), 'frontrunner-rebuild-'));
  try {
    mkdirSync(join(rebuildTmp, 'data'));
    const tracker = join(rebuildTmp, 'data', 'applications.md');
    // Keeper row #50 has the higher score AND no trailing pipe; dup #51 carries a
    // more-advanced status (both below Applied, so the advanced-status safety
    // guard doesn't block the collapse), so dedup promotes #50's status and
    // rewrites the row — exercising rebuildRow() on a no-trailing-pipe row.
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 50 | 2026-02-01 | Globex | Widget Engineer | 4.5/5 | Rejected | ❌ | [50](../reports/evaluations/050-widget.md) | KEEPER_NOTE_SENTINEL\n' +
      '| 51 | 2026-02-02 | Globex | Widget Engineer | 3.0/5 | Evaluated | ❌ | [51](../reports/evaluations/051-widget.md) | dup row |\n');

    const r = run(NODE, ['src/tracker/dedup-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker } });
    if (r === null) {
      fail('src/tracker/dedup-tracker.mjs crashed during notes-preservation test');
    } else {
      const out = readFileSync(tracker, 'utf-8');
      const keeperRow = out.split('\n').find(l => l.includes('| 50 |'));
      if (keeperRow && keeperRow.includes('KEEPER_NOTE_SENTINEL') && keeperRow.includes('Evaluated')) {
        pass('dedup row rebuild preserves the notes column on rows without a trailing pipe');
      } else {
        fail(`dedup row rebuild dropped notes / status on no-trailing-pipe row: "${keeperRow}"`);
      }
    }
  } finally {
    rmSync(rebuildTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup row-rebuild notes test crashed: ${e.message}`);
}

// rebuildRow() is now shared from src\/tracker\/tracker-utils.mjs (extracted from the two
// copies introduced in #1004). Unit-test the helper contract directly.
console.log('\n🧪 Testing shared tracker-utils rebuildRow()...');
try {
  const { rebuildRow } = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker-utils.mjs')).href);
  const cellsOf = (line) => line.split('|').map(s => s.trim());

  // Trailing-pipe row → unchanged round-trip.
  const withPipe = '| 5 | 2026-02-01 | Acme | Eng | 4.0/5 | Applied | ❌ | [5](r.md) | note |';
  if (rebuildRow(cellsOf(withPipe)) === withPipe) {
    pass('rebuildRow round-trips a row that already has a trailing pipe');
  } else {
    fail(`rebuildRow changed a trailing-pipe row: "${rebuildRow(cellsOf(withPipe))}"`);
  }

  // No-trailing-pipe row → last cell (notes) preserved, trailing pipe added.
  const noPipe = '| 5 | 2026-02-01 | Acme | Eng | 4.0/5 | Applied | ❌ | [5](r.md) | keepme';
  const rebuilt = rebuildRow(cellsOf(noPipe));
  if (rebuilt.includes('keepme') && rebuilt.endsWith('|')) {
    pass('rebuildRow preserves the notes cell on a row without a trailing pipe');
  } else {
    fail(`rebuildRow dropped notes on no-trailing-pipe row: "${rebuilt}"`);
  }

  // Extra column (e.g. a custom Location) → every cell preserved.
  const extra = '| 5 | 2026-02-01 | Acme | Eng | Berlin | 4.0/5 | Applied | ❌ | [5](r.md) | note |';
  const rebuiltExtra = rebuildRow(cellsOf(extra));
  if (rebuiltExtra === extra && rebuiltExtra.includes('Berlin')) {
    pass('rebuildRow preserves extra columns (custom Location)');
  } else {
    fail(`rebuildRow mangled an extra-column row: "${rebuiltExtra}"`);
  }
} catch (e) {
  fail(`tracker-utils rebuildRow unit test crashed: ${e.message}`);
}

// #946/#954 header-name column mapping lived only in merge-tracker; followup-cadence,
// analyze-patterns and dedup-tracker still parsed by fixed index, so an inserted
// Location column mis-parsed (Location read as Score, etc.). The logic is now shared
// in src\/tracker\/tracker-parse.mjs and all four readers use it.
console.log('\n🧪 Testing shared tracker-parse column mapping...');
try {
  const { resolveColumns, parseTrackerRow, LEGACY_COLMAP } = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker-parse.mjs')).href);

  const withLocation = [
    '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|----------|-------|--------|-----|--------|-------|',
    '| 7 | 2026-06-28 | Acme | Eng | Berlin | 4.5/5 | Applied | ✅ | [7](r.md) | keep |',
  ];
  const cmLoc = resolveColumns(withLocation);
  const rowLoc = parseTrackerRow(withLocation[2], cmLoc);
  if (rowLoc && rowLoc.score === '4.5/5' && rowLoc.status === 'Applied' && rowLoc.location === 'Berlin') {
    pass('tracker-parse maps columns by header — inserted Location column does not shift Score/Status');
  } else {
    fail(`tracker-parse mis-parsed a Location-column row: ${JSON.stringify(rowLoc)}`);
  }

  const legacy = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 8 | 2026-06-28 | Beta | PM | 3.0/5 | Evaluated | ❌ | [8](r.md) | n |',
  ];
  const rowLeg = parseTrackerRow(legacy[2], resolveColumns(legacy));
  if (rowLeg && rowLeg.score === '3.0/5' && rowLeg.status === 'Evaluated' && rowLeg.location === undefined) {
    pass('tracker-parse still parses the legacy fixed layout correctly');
  } else {
    fail(`tracker-parse broke the legacy layout: ${JSON.stringify(rowLeg)}`);
  }

  // No header row → falls back to legacy map; header/separator/stray rows → null.
  if (resolveColumns(['| 9 | … |']) === LEGACY_COLMAP &&
      parseTrackerRow(legacy[0], LEGACY_COLMAP) === null &&
      parseTrackerRow(legacy[1], LEGACY_COLMAP) === null &&
      parseTrackerRow('not a table row', LEGACY_COLMAP) === null) {
    pass('tracker-parse falls back to legacy map and rejects header/separator/non-rows');
  } else {
    fail('tracker-parse fallback / non-row rejection wrong');
  }
} catch (e) {
  fail(`tracker-parse unit test crashed: ${e.message}`);
}

// #1431 "Apply to #13" is ambiguous: report numbers and tracker row numbers
// diverge, and mapping company ↔ report# ↔ tracker# ↔ PDF used to require
// opening three files. find.mjs resolves a report#, tracker#, or company/role
// fragment to the full pipeline identity in one read-only lookup.
console.log('\n🧪 Testing find.mjs pipeline identity lookup...');
try {
  const { parseTrackerRows, parsePdfIndex, findMatches } = await import(pathToFileURL(join(ROOT, 'find.mjs')).href);

  // Tracker# and report# intentionally diverge: row 3 carries report 12, and a
  // different row is numbered 12 — the exact friction the tool exists to solve.
  const rows = parseTrackerRows([
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 3 | 2026-06-01 | Acme Labs | Platform Engineer | 4.2/5 | **Applied** (2026-06-02) | ✅ | [12](workspace/reports/evaluations/012-acme-labs-2026-06-01.md) | strong fit |',
    '| 12 | 2026-06-10 | Globex | Data Engineer | 3.8/5 | Evaluated | ❌ | [15](workspace/reports/evaluations/015-globex-2026-06-10.md) | — |',
  ].join('\n'));
  const pdfIndex = parsePdfIndex(
    '# report\tpdf\thtml\tformat\tdate — written by src/cv/generate-pdf.mjs, do not edit\n' +
    '012\tworkspace/documents/cv-acme-labs.pdf\tworkspace/documents/cv-acme-labs.html\tats\t2026-06-01\n');

  const byTracker = findMatches(rows, '3', pdfIndex);
  if (byTracker.length === 1 && byTracker[0].company === 'Acme Labs' &&
      byTracker[0].trackerNum === 3 && byTracker[0].reportNum === '12' &&
      byTracker[0].reportPath === 'workspace/reports/evaluations/012-acme-labs-2026-06-01.md' &&
      byTracker[0].status === 'Applied' &&
      byTracker[0].pdfPath === 'workspace/documents/cv-acme-labs.pdf') {
    pass('find.mjs resolves a tracker# to company, report#, canonical status, and PDF path');
  } else {
    fail(`find.mjs tracker# lookup wrong: ${JSON.stringify(byTracker)}`);
  }

  // "12" is both Acme's report# and Globex's tracker# — both rows must surface
  // (with the zero-padded "012" report-link form treated as the same number).
  const ambiguous = findMatches(rows, '012', pdfIndex);
  const companies = ambiguous.map(m => m.company).sort();
  if (ambiguous.length === 2 && companies[0] === 'Acme Labs' && companies[1] === 'Globex') {
    pass('find.mjs surfaces report#/tracker# collisions as multiple matches (zero-pad normalized)');
  } else {
    fail(`find.mjs numeric collision lookup wrong: ${JSON.stringify(ambiguous)}`);
  }

  const byFragment = findMatches(rows, 'acme', pdfIndex);
  if (byFragment.length === 1 && byFragment[0].company === 'Acme Labs') {
    pass('find.mjs matches a case-insensitive company fragment');
  } else {
    fail(`find.mjs company fragment lookup wrong: ${JSON.stringify(byFragment)}`);
  }

  // Fuzzy multi-word lookup reuses src\/tracker\/role-matcher.mjs (stopwords like "remote"
  // dropped) instead of reinventing matching.
  const byFuzzy = findMatches(rows, 'remote data engineer', pdfIndex);
  if (byFuzzy.length === 1 && byFuzzy[0].company === 'Globex' && byFuzzy[0].pdfPath === null) {
    pass('find.mjs fuzzy-matches a role phrase via role-matcher and reports a missing PDF');
  } else {
    fail(`find.mjs fuzzy role lookup wrong: ${JSON.stringify(byFuzzy)}`);
  }

  if (findMatches(rows, 'no-such-company', pdfIndex).length === 0) {
    pass('find.mjs returns zero matches cleanly for an unknown query');
  } else {
    fail('find.mjs matched a query that exists nowhere in the tracker');
  }
} catch (e) {
  fail(`find.mjs unit test crashed: ${e.message}`);
}

// dedup-tracker reads AND writes by column; with a Location column its status
// promotion must target the Status cell, not fixed parts[6].
