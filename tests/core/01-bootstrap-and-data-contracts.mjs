import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pass, fail, warn, run, formatRunFailure, fileExists, ROOT, NODE, getBash, toBashPath } from '../helpers.mjs';
import { readFile, normalizeEol, readTextLF } from './support.mjs';

// ── 1. SYNTAX CHECKS ────────────────────────────────────────────

console.log('1. Syntax checks');

const mjsFiles = readdirSync(ROOT).filter(f => f.endsWith('.mjs'));
for (const f of mjsFiles) {
  const result = run(NODE, ['--check', f]);
  if (result !== null) {
    pass(`${f} syntax OK`);
  } else {
    fail(`${f} has syntax errors`);
  }
}

// ── 2. SCRIPT EXECUTION ─────────────────────────────────────────

console.log('\n2. Script execution (graceful on empty data)');

const scripts = [
  { name: 'src/cv/cv-sync-check.mjs', expectExit: 1, allowFail: true }, // fails without workspace/profile/cv.md (normal in repo)
  { name: 'src/tracker/verify-pipeline.mjs', expectExit: 0 },
  // --dry-run: these scripts resolve ROOT from import.meta.url and write
  // workspace/applications/tracker.md (or workspace/search/pipeline.md) in place. On a provisioned working
  // copy with a real tracker present, running them without --dry-run mutates user
  // data. Harmless in this repo (no tracker shipped), risky for end users who run
  // tests inside their active frontrunner workspace.
  { name: 'src/tracker/normalize-statuses.mjs --dry-run', expectExit: 0 },
  { name: 'src/tracker/dedup-tracker.mjs --dry-run', expectExit: 0 },
  { name: 'src/tracker/merge-tracker.mjs --dry-run', expectExit: 0 },
  { name: 'src/tracker/reconcile-pipeline.mjs --dry-run', expectExit: 0 },
  { name: 'src/analysis/analyze-patterns.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/upskill.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/detect-reposts.mjs --self-test', expectExit: 0 },
  { name: 'src/scan/discover-ats.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/process-quality.mjs --self-test', expectExit: 0 },
  { name: 'src/scan/company-history.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/salary-gap.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/funnel-velocity.mjs --self-test', expectExit: 0 },
  { name: 'src/cv/img-to-pdf.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/assessment-log.mjs --self-test', expectExit: 0 },
  { name: 'src/cv/build-cv-html.mjs --test', expectExit: 0 },
  { name: 'src/analysis/jd-skill-gap.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/check-table-freshness.mjs --self-test', expectExit: 0 },
  { name: 'src/analysis/weekly-interview-digest.mjs --self-test', expectExit: 0 },
  { name: 'src/cv/verify-cv-facts.mjs --self-test', expectExit: 0 },
  { name: 'tests/updater-migration-tests.mjs', expectExit: 0 },
  { name: 'tests/tracker-columns-tests.mjs', expectExit: 0 },
  { name: 'tests/agent-inbox-tests.mjs', expectExit: 0 },
  { name: 'tests/followup-seed-tests.mjs', expectExit: 0 },
  { name: 'tests/paste-reply-tests.mjs', expectExit: 0 },
  { name: 'tests/set-status-tests.mjs', expectExit: 0 },
  { name: 'tests/tracker-writer-lock-tests.mjs', expectExit: 0 },
  // Root-level standalone suites shipped in SYSTEM_PATHS but previously never
  // executed by CI (issue #1624). All are fast (<0.5s each), so they run in
  // both quick and full mode like their siblings above.
  { name: 'tests/trust-validator-tests.mjs', expectExit: 0 },
  { name: 'tests/salary-filter-tests.mjs', expectExit: 0 },
  { name: 'src/analysis/detect-reposts.test.mjs', expectExit: 0 },
  { name: 'src/scan/discover-ats.test.mjs', expectExit: 0 },
  { name: 'tests/followup-cadence-tests.mjs', expectExit: 0 },
  { name: 'src/analysis/process-quality.test.mjs', expectExit: 0 },
  { name: 'src/scan/company-history.test.mjs', expectExit: 0 },
  { name: 'tests/reply-matcher.test.mjs', expectExit: 0 },
  { name: 'src/scan/validate-portals.mjs --file templates/portals.example.yml', expectExit: 0 },
  { name: 'validate-system-paths-coverage.mjs --self-test', expectExit: 0 },
  // The bare coverage run is NOT here on purpose: this section executes each
  // script from a throwaway copy of the repo, and the coverage check needs
  // `git ls-files` on the REAL tree. Running it here validated nothing and
  // exited 0 no matter what, which is how five unregistered files shipped.
  // It now runs from ROOT in section 5.
  // Missing-file run: must exit 0 gracefully and hit no network. Do not use the
  // default workspace/search/portals.yml because end-user workspaces often have a real user-layer
  // portals file that would trigger a live remote sweep during tests.
  { name: 'src/scan/verify-portals.mjs --file .tmp-test-missing-portals.yml', expectExit: 0 },
  { name: 'src/scan/archive-posting.mjs --help', expectExit: 0 },
];

const scriptTmp = mkdtempSync(join(ROOT, '.tmp-script-test-'));
try {
  const copyDirSync = (src, dest, exclude = []) => {
    const name = src.split(/[\\/]/).pop();
    if (exclude.includes(name)) return;
    const stat = statSync(src);
    if (stat.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      for (const entry of readdirSync(src)) {
        copyDirSync(join(src, entry), join(dest, entry), exclude);
      }
    } else {
      copyFileSync(src, dest);
    }
  };

  const excludeDirs = [
    'node_modules',
    '.git',
    'data',
    'reports',
    '.frontrunner-web',
    '.playwright-mcp',
    '.agents',
    'cdp-diff.patch',
    'cdp-diff-focused.patch',
    'test_diff.patch',
    'test_diff_utf8.patch',
    basename(scriptTmp),
  ];
  copyDirSync(ROOT, scriptTmp, excludeDirs);

  mkdirSync(join(scriptTmp, 'data'), { recursive: true });
  mkdirSync(join(scriptTmp, 'reports'), { recursive: true });
  writeFileSync(
    join(scriptTmp, 'data', 'applications.md'),
    '# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n',
    'utf-8'
  );

  for (const { name, allowFail } of scripts) {
    const parts = name.split(' ');
    const scriptFile = parts[0];
    const args = parts.slice(1);
    const result = run(NODE, [join(scriptTmp, scriptFile), ...args], {
      cwd: scriptTmp,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result !== null) {
      pass(`${name} runs OK`);
    } else if (allowFail) {
      pass(`${name} exits safely without user data`);
    } else {
      fail(`${name} crashed${formatRunFailure()}`);
    }
  }
} finally {
  rmSync(scriptTmp, { recursive: true, force: true });
}

try {
  const tmp = mkdtempSync(join(tmpdir(), 'frontrunner-cv-facts-'));
  const hiddenScriptMetric = join(tmp, 'hidden-script-metric.html');
  const visibleMetric = join(tmp, 'visible-metric.html');
  writeFileSync(
    hiddenScriptMetric,
    '<html><body><script>const claim = "500 users";</script\t\n bar><p>Generated CV</p></body></html>'
  );
  writeFileSync(
    visibleMetric,
    '<html><body><p>Improved onboarding for 500 users.</p></body></html>'
  );

  const hiddenResult = run(NODE, ['src/cv/verify-cv-facts.mjs', hiddenScriptMetric], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (hiddenResult !== null) {
    pass('verify-cv-facts strips script tags with irregular closing tags');
  } else {
    fail('verify-cv-facts treated script contents as visible CV facts');
  }

  const visibleResult = run(NODE, ['src/cv/verify-cv-facts.mjs', visibleMetric], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (visibleResult === null) {
    pass('verify-cv-facts still flags visible unsupported metrics');
  } else {
    fail('verify-cv-facts missed a visible unsupported metric');
  }

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  fail(`verify-cv-facts regression tests crashed: ${e.message}`);
}

// ── 3. LIVENESS CLASSIFICATION ──────────────────────────────────

console.log('\n3. Liveness classification');

try {
  const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'src/scan/liveness-core.mjs')).href);

  const expiredChromeApply = classifyLiveness({
    finalUrl: 'https://example.com/jobs/closed-role',
    bodyText: 'Company Careers\nApply\nThe job you are looking for is no longer open.',
    applyControls: [],
  });
  if (expiredChromeApply.result === 'expired') {
    pass('Expired pages are not revived by nav/footer "Apply" text');
  } else {
    fail(`Expired page misclassified as ${expiredChromeApply.result}`);
  }

  const activeWorkdayPage = classifyLiveness({
    finalUrl: 'https://example.workday.com/job/123',
    bodyText: [
      '663 JOBS FOUND',
      'Senior AI Engineer',
      'Join our applied AI team to ship production systems, partner with customers, and own delivery across evaluation, deployment, and reliability.',
    ].join('\n'),
    applyControls: ['Apply for this Job'],
  });
  if (activeWorkdayPage.result === 'active') {
    pass('Visible apply controls still keep real job pages active');
  } else {
    fail(`Active job page misclassified as ${activeWorkdayPage.result}`);
  }

  const closedMycareersfuture = classifyLiveness({
    finalUrl: 'https://www.mycareersfuture.gov.sg/job/engineering/senior-staff-embedded-software-engineer',
    bodyText: [
      'Senior Staff Embedded Software Engineer',
      'MaxLinear Asia Singapore Private Limited',
      '9 applications    Posted 27 Oct 2025    Closed on 26 Nov 2025',
      'Applications have closed for this job',
      'Log in to Apply',
      "You'll need to log in with Singpass to verify your identity.",
      'Roles & Responsibilities: design, develop and maintain embedded firmware for broadband communications ICs.',
    ].join('\n'),
    applyControls: ['Log in to Apply'],
  });
  if (closedMycareersfuture.result === 'expired') {
    pass('Closed postings with "Applications have closed" banner are detected');
  } else {
    fail(`Closed mycareersfuture posting misclassified as ${closedMycareersfuture.result}`);
  }

  // Welcome to the Jungle renders its closure banner with a typographic
  // apostrophe (U+2019), not the ASCII one the pattern was spelled with, so the
  // banner never matched and a closed posting came back "uncertain".
  const closedWttjTypographicApostrophe = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.welcometothejungle.com/fr/companies/acme/jobs/graphiste_paris',
    bodyText: [
      'Cette offre n’est plus disponible.',
      'ACME',
      'Graphiste & Motion Designer',
      'CDI    Paris    Télétravail fréquent',
      'Descriptif du poste : conception d’identités visuelles et d’animations pour les campagnes de la marque.',
      'Profil recherché : 3 ans d’expérience minimum, maîtrise de la suite Adobe et d’After Effects.',
    ].join('\n'),
    applyControls: [],
  });
  if (closedWttjTypographicApostrophe.result === 'expired') {
    pass('Closure banners written with a typographic apostrophe are detected');
  } else {
    fail(`WTTJ closed posting misclassified as ${closedWttjTypographicApostrophe.result}`);
  }

  // Same normalization, accent side: the pattern is spelled "pourvu" but the
  // page says "pourvue"/"déjà" with diacritics.
  const closedAccentedBanner = classifyLiveness({
    status: 200,
    finalUrl: 'https://example.fr/offres/directeur-artistique',
    bodyText: [
      'Offre déjà pourvue',
      'Directeur artistique',
      'Cette annonce est conservée à titre d’archive.',
      'Missions : direction de création, suivi de production, relation client sur les campagnes annuelles.',
    ].join('\n'),
    applyControls: [],
  });
  if (closedAccentedBanner.result === 'expired') {
    pass('Accented French closure banners are detected');
  } else {
    fail(`Accented French banner misclassified as ${closedAccentedBanner.result}`);
  }

  const cloudflareChallenge = classifyLiveness({
    status: 403,
    finalUrl: 'https://www.pracuj.pl/praca/sap-consultant,oferta,1004870954',
    bodyText: 'www.pracuj.pl\nJust a moment...\nPerforming security verification\nThis website uses a security service to protect against malicious bots.\nRay ID: a06489bab8bc4cd7\nPerformance and Security by Cloudflare',
    applyControls: [],
  });
  if (cloudflareChallenge.result === 'uncertain' && cloudflareChallenge.code === 'bot_challenge') {
    pass('Cloudflare anti-bot challenge pages are uncertain, not expired');
  } else {
    fail(`Cloudflare challenge misclassified as ${cloudflareChallenge.result} (${cloudflareChallenge.code})`);
  }

  const blocked403 = classifyLiveness({
    status: 403,
    finalUrl: 'https://www.pracuj.pl/praca/sap-consultant,oferta,1004870954',
    bodyText: 'Access denied',
    applyControls: [],
  });
  if (blocked403.result === 'uncertain' && blocked403.code === 'access_blocked') {
    pass('HTTP 403 is treated as access-blocked (uncertain), not expired');
  } else {
    fail(`HTTP 403 misclassified as ${blocked403.result} (${blocked403.code})`);
  }

  const activePolishPosting = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.pracuj.pl/praca/administrator-sap-utilities-warszawa,oferta,1004870954',
    bodyText: 'Administrator SAP Utilities. Connectis_. Siedziba firmy: Chmielna 71, Warszawa. '.repeat(6),
    applyControls: ['Aplikuj Aplikuj na ogłoszenie'],
  });
  if (activePolishPosting.result === 'active') {
    pass('Polish "Aplikuj" apply control marks a loaded posting active');
  } else {
    fail(`Polish apply control not recognized: ${activePolishPosting.result} (${activePolishPosting.code})`);
  }

  const redirectedOffPosting = classifyLiveness({
    status: 200,
    requestedUrl: 'https://jobs.careers.microsoft.com/professionals/us/en/job/1399802/Intune-Support-Engineer',
    finalUrl: 'https://apply.careers.microsoft.com/careers?start=0&sort_by=timestamp',
    bodyText: 'Search jobs. Partner Marketing Manager. Software Engineer II. Browse all open positions at Microsoft. '.repeat(6),
    applyControls: ['Apply now', 'Apply now', 'Apply now'],
  });
  if (redirectedOffPosting.result === 'uncertain' && redirectedOffPosting.code === 'redirected_off_posting') {
    pass('Dead permalink 301 to a generic listing is uncertain, not revived by other jobs\' Apply buttons');
  } else {
    fail(`Off-posting redirect misclassified as ${redirectedOffPosting.result} (${redirectedOffPosting.code})`);
  }

  const redirectKeepingJobId = classifyLiveness({
    status: 200,
    requestedUrl: 'https://boards.greenhouse.io/acme/jobs/4567890',
    finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/4567890',
    bodyText: 'Senior AI Engineer. Own delivery across evaluation, deployment, and reliability at Acme. '.repeat(6),
    applyControls: ['Apply for this Job'],
  });
  if (redirectKeepingJobId.result === 'active') {
    pass('Redirect that keeps the job id (board migration) still classifies active');
  } else {
    fail(`Same-job redirect misclassified as ${redirectKeepingJobId.result} (${redirectKeepingJobId.code})`);
  }

  // Liveness API rung (src\/scan\/liveness-api.mjs) — the zero-token ATS first rung. We test the
  // pure URL→API resolution + SSRF guard; the network fetch is conservative by
  // construction (only 404/410→expired, 200→active, else null→Playwright fallback).
  const { resolveAtsApi, classifyAshbyBoard, checkLivenessViaApi } = await import(pathToFileURL(join(ROOT, 'src/scan/liveness-api.mjs')).href);
  const ghApi = resolveAtsApi('https://boards.greenhouse.io/acme/jobs/4567890');
  if (ghApi?.ats === 'greenhouse' && ghApi.apiUrl === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4567890') {
    pass('resolveAtsApi maps a Greenhouse posting to its per-job API URL');
  } else {
    fail(`Greenhouse API URL wrong: ${JSON.stringify(ghApi)}`);
  }
  const lvApi = resolveAtsApi('https://jobs.lever.co/acme/abc-123-def');
  if (lvApi?.ats === 'lever' && lvApi.apiUrl === 'https://api.lever.co/v0/postings/acme/abc-123-def') {
    pass('resolveAtsApi maps a Lever posting to its per-job API URL');
  } else {
    fail(`Lever API URL wrong: ${JSON.stringify(lvApi)}`);
  }
  const lvEuApi = resolveAtsApi('https://jobs.eu.lever.co/acme-eu/abc-123-def');
  if (lvEuApi?.ats === 'lever' && lvEuApi.apiUrl === 'https://api.eu.lever.co/v0/postings/acme-eu/abc-123-def') {
    pass('resolveAtsApi maps an EU Lever posting to api.eu.lever.co');
  } else {
    fail(`Lever EU API URL wrong: ${JSON.stringify(lvEuApi)}`);
  }
  if (resolveAtsApi('https://example.com/jobs/123') === null) {
    pass('resolveAtsApi returns null for non-ATS URLs (→ Playwright fallback)');
  } else {
    fail('resolveAtsApi should return null for an unknown host');
  }
  if (resolveAtsApi('https://boards.greenhouse.io/acme/jobs/not-a-number') === null
      && resolveAtsApi('http://boards.greenhouse.io/acme/jobs/123') === null) {
    pass('resolveAtsApi rejects non-numeric Greenhouse ids and non-https (SSRF guard)');
  } else {
    fail('resolveAtsApi guard failed (bad id or http accepted)');
  }
  // Workday: per-job CXS endpoint. Job path is genuinely multi-segment (a location
  // slug + a title slug), which is why resolveAtsApi's SSRF guard uses isSafeValue
  // (component-by-component) instead of the single-segment SAFE_SEGMENT check.
  const wdApi = resolveAtsApi('https://acme.wd1.myworkdayjobs.com/en-US/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125');
  if (wdApi?.ats === 'workday'
      && wdApi.apiUrl === 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125'
      && wdApi.parts?.jobPath === 'Toronto-ON-CAN/Agentic-AI-Engineer_R260010125') {
    pass('resolveAtsApi maps a Workday posting (with locale prefix) to its per-job CXS API URL');
  } else {
    fail(`Workday API URL wrong: ${JSON.stringify(wdApi)}`);
  }
  // Same tenant, no locale prefix in the URL.
  const wdApiNoLocale = resolveAtsApi('https://acme.wd5.myworkdayjobs.com/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125');
  if (wdApiNoLocale?.ats === 'workday'
      && wdApiNoLocale.apiUrl === 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125') {
    pass('resolveAtsApi maps a Workday posting without a locale prefix');
  } else {
    fail(`Workday (no locale) API URL wrong: ${JSON.stringify(wdApiNoLocale)}`);
  }
  // Directory traversal embedded inside one segment (not a bare ".." dot-segment,
  // which the URL parser itself would normalize away before we ever see it) must
  // still be rejected by isSafeValue's per-segment "..": ownership check.
  if (resolveAtsApi('https://acme.wd1.myworkdayjobs.com/External/job/Toronto-ON-CAN/Role..R1') === null) {
    pass('resolveAtsApi rejects ".." embedded in a Workday jobPath segment (SSRF guard)');
  } else {
    fail('resolveAtsApi should reject ".." embedded in a Workday jobPath segment');
  }
  if (resolveAtsApi('https://acme.notworkdayjobs.com/External/job/Toronto-ON-CAN/Role_R1') === null) {
    pass('resolveAtsApi returns null for a myworkdayjobs.com lookalike host');
  } else {
    fail('resolveAtsApi should not match a lookalike Workday host');
  }

  // Ashby: org-level board endpoint. Ashby pages are JS-rendered, so the browser/
  // static rung sees only nav/footer and false-reports live postings as expired —
  // the API rung must resolve the org board and confirm the specific job id.
  const AS_UUID = '00fd8024-7804-4278-a38b-c9d60d929dbb';
  const asApi = resolveAtsApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
  if (asApi?.ats === 'ashby'
      && asApi.apiUrl === 'https://api.ashbyhq.com/posting-api/job-board/deepgram'
      && asApi.parts?.jobId === AS_UUID
      && typeof asApi.interpret === 'function') {
    pass('resolveAtsApi maps an Ashby posting to its org job-board API URL');
  } else {
    fail(`Ashby API URL wrong: ${JSON.stringify(asApi)}`);
  }
  // The /application apply-link variant must resolve to the same org + job id.
  const asApply = resolveAtsApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}/application`);
  if (asApply?.ats === 'ashby' && asApply.parts?.org === 'deepgram' && asApply.parts?.jobId === AS_UUID) {
    pass('resolveAtsApi handles the Ashby /application apply-link variant');
  } else {
    fail(`Ashby /application variant not resolved: ${JSON.stringify(asApply)}`);
  }
  // A bare board root (no job id) isn't a specific posting → null → Playwright.
  if (resolveAtsApi('https://jobs.ashbyhq.com/deepgram') === null) {
    pass('resolveAtsApi returns null for an Ashby board root (no job id)');
  } else {
    fail('resolveAtsApi should not treat an Ashby board root as a posting');
  }
  // classifyAshbyBoard — pure per-job liveness from the board payload.
  const asListed = classifyAshbyBoard({ jobs: [{ id: AS_UUID, isListed: true }] }, AS_UUID);
  const asAbsent = classifyAshbyBoard({ jobs: [{ id: 'other-id', isListed: true }] }, AS_UUID);
  const asUnlisted = classifyAshbyBoard({ jobs: [{ id: AS_UUID, isListed: false }] }, AS_UUID);
  const asBadShape = classifyAshbyBoard({ notJobs: [] }, AS_UUID);
  if (asListed?.result === 'active'
      && asAbsent?.result === 'expired'
      && asUnlisted?.result === 'expired'
      && asBadShape === null) {
    pass('classifyAshbyBoard: listed→active, absent/unlisted→expired, bad shape→null');
  } else {
    fail(`classifyAshbyBoard wrong: listed=${JSON.stringify(asListed)} absent=${JSON.stringify(asAbsent)} unlisted=${JSON.stringify(asUnlisted)} badShape=${JSON.stringify(asBadShape)}`);
  }
  // checkLivenessViaApi — the fetch/Response orchestration around the pure helpers:
  // a 200 with an org-level `interpret` (Ashby) is awaited and parsed, a per-job 200
  // (Greenhouse) is live as-is, 404 is expired, and a rejected fetch (network error,
  // or an aborted timeout — same code path) is inconclusive → null. Mock global.fetch
  // so no network is hit; restore it in finally.
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ jobs: [{ id: AS_UUID, isListed: true }] }), { status: 200 });
    const cvAshbyLive = await checkLivenessViaApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
    globalThis.fetch = async () => new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    const cvAshbyGone = await checkLivenessViaApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
    // 200 but a malformed board (no `jobs` array): interpret returns null, so the
    // orchestration must fall through to null (→ Playwright), not a false verdict.
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const cvAshbyMalformed = await checkLivenessViaApi(`https://jobs.ashbyhq.com/deepgram/${AS_UUID}`);
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const cvGhLive = await checkLivenessViaApi('https://boards.greenhouse.io/acme/jobs/4567890');
    globalThis.fetch = async () => new Response('{}', { status: 404 });
    const cvGone = await checkLivenessViaApi('https://boards.greenhouse.io/acme/jobs/4567890');
    globalThis.fetch = async () => { throw new Error('network down'); };
    const cvErr = await checkLivenessViaApi('https://boards.greenhouse.io/acme/jobs/4567890');
    const wdUrl = 'https://acme.wd1.myworkdayjobs.com/External/job/Toronto-ON-CAN/Agentic-AI-Engineer_R260010125';
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    const cvWdLive = await checkLivenessViaApi(wdUrl);
    globalThis.fetch = async () => new Response('{}', { status: 404 });
    const cvWdGone = await checkLivenessViaApi(wdUrl);
    if (cvAshbyLive?.result === 'active' && cvAshbyLive?.code === 'ashby_api_ok'
        && cvAshbyGone?.result === 'expired' && cvAshbyGone?.code === 'ashby_api_unlisted'
        && cvAshbyMalformed === null
        && cvGhLive?.result === 'active'
        && cvGone?.result === 'expired'
        && cvErr === null
        && cvWdLive?.result === 'active' && cvWdLive?.code === 'workday_api_ok'
        && cvWdGone?.result === 'expired' && cvWdGone?.code === 'workday_api_gone') {
      pass('checkLivenessViaApi: 200→interpret (Ashby), malformed→null, greenhouse/workday 200→active, 404→expired, fetch error→null');
    } else {
      fail(`checkLivenessViaApi wrong: ashbyLive=${JSON.stringify(cvAshbyLive)} ashbyGone=${JSON.stringify(cvAshbyGone)} malformed=${JSON.stringify(cvAshbyMalformed)} ghLive=${JSON.stringify(cvGhLive)} gone=${JSON.stringify(cvGone)} err=${JSON.stringify(cvErr)} wdLive=${JSON.stringify(cvWdLive)} wdGone=${JSON.stringify(cvWdGone)}`);
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  // Headed-fallback-on-challenge path (src\/scan\/liveness-browser.mjs). Fake Playwright
  // pages script the goto/evaluate calls so we can exercise the wrapper without
  // launching a browser. checkUrlLiveness reads body text first, apply controls
  // second — the fake returns them in that order.
  const { checkUrlLiveness, checkUrlLivenessWithFallback, isChallengeResult, jitteredDelayMs } =
    await import(pathToFileURL(join(ROOT, 'src/scan/liveness-browser.mjs')).href);

  const disabled = jitteredDelayMs(0) === 0 && jitteredDelayMs(-1) === 0;
  let inRange = true;
  for (let i = 0; i < 200; i += 1) {
    const d = jitteredDelayMs(5000);
    if (d < 5000 || d >= 10000) { inRange = false; break; }
  }
  if (disabled && inRange) {
    pass('jitteredDelayMs returns 0 when disabled and stays in [base, 2*base)');
  } else {
    fail(`jitteredDelayMs out of spec (disabled=${disabled}, inRange=${inRange})`);
  }

  const fakePage = ({ status, finalUrl, bodyText, applyControls }) => {
    let evalCall = 0;
    return {
      async route() {},
      async goto() { return { status: () => status }; },
      async waitForTimeout() {},
      url() { return finalUrl; },
      async evaluate() { evalCall += 1; return evalCall === 1 ? bodyText : applyControls; },
    };
  };
  const URL = 'https://www.pracuj.pl/praca/sap-consultant,oferta,1004870954';
  const challengePage = () => fakePage({
    status: 403,
    finalUrl: URL,
    bodyText: 'Just a moment... Performing security verification. Ray ID: abc123. Cloudflare.',
    applyControls: [],
  });
  const livePage = () => fakePage({
    status: 200,
    finalUrl: URL,
    bodyText: 'Administrator SAP Utilities. '.repeat(20),
    applyControls: ['Apply for this job'],
  });
  const publicResolver = async () => ['93.184.216.34'];

  if (isChallengeResult({ result: 'uncertain', code: 'bot_challenge' }) &&
      isChallengeResult({ result: 'uncertain', code: 'access_blocked' }) &&
      !isChallengeResult({ result: 'expired', code: 'http_gone' }) &&
      !isChallengeResult({ result: 'active', code: 'apply_control_visible' })) {
    pass('isChallengeResult flags only bot_challenge/access_blocked uncertains');
  } else {
    fail('isChallengeResult misclassified a result');
  }

  const fellBackToActive = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => livePage(),
    resolveHostname: publicResolver,
  });
  if (fellBackToActive.result === 'active') {
    pass('Headed fallback recovers a challenge-blocked page as active');
  } else {
    fail(`Headed fallback did not recover page: ${fellBackToActive.result} (${fellBackToActive.code})`);
  }

  const noProvider = await checkUrlLivenessWithFallback(challengePage(), URL, {
    resolveHostname: publicResolver,
  });
  if (noProvider.result === 'uncertain' && noProvider.code === 'bot_challenge') {
    pass('No fallback provider keeps the original challenge result');
  } else {
    fail(`Missing provider changed result to ${noProvider.result} (${noProvider.code})`);
  }

  const stillBlocked = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => challengePage(),
    resolveHostname: publicResolver,
  });
  if (stillBlocked.result === 'uncertain' && stillBlocked.code === 'bot_challenge'
      && /headed retry also blocked/.test(stillBlocked.reason)) {
    pass('Persistent challenge stays uncertain after headed retry (never upgraded to expired)');
  } else {
    fail(`Persistent challenge mishandled: ${stillBlocked.result} (${stillBlocked.code})`);
  }

  const noHeadedAvailable = await checkUrlLivenessWithFallback(challengePage(), URL, {
    getHeadedPage: async () => null, // headed launch failed (no display)
    resolveHostname: publicResolver,
  });
  if (noHeadedAvailable.result === 'uncertain' && noHeadedAvailable.code === 'bot_challenge') {
    pass('Headless-only environment degrades to original challenge result');
  } else {
    fail(`No-display degrade path wrong: ${noHeadedAvailable.result} (${noHeadedAvailable.code})`);
  }

  // SSRF guard — `rejectPrivateOrInvalid` has to refuse every URL whose host
  // resolves to loopback / private / link-local space. The earlier guard only
  // matched literal IPv4 patterns and bracketless IPv6, so several Chromium-
  // routable bypasses (0.0.0.0, [::], [::1] (bracketed), [::ffff:127.0.0.1],
  // localhost.) slipped through. These cases keep that regression covered.
  const { rejectPrivateOrInvalid } = await import(
    pathToFileURL(join(ROOT, 'src/scan/liveness-browser.mjs')).href
  );
  const blockCases = [
    ['http://0.0.0.0/admin', 'IPv4 all-zeros (Linux routes to loopback)'],
    ['http://[::]/', 'IPv6 all-zeros (Linux routes to loopback)'],
    ['http://[::1]/', 'IPv6 loopback (brackets included in url.hostname)'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6 loopback (dotted form)'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped IPv6 loopback (hex form)'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped IPv6 link-local (cloud metadata)'],
    ['http://[fc00::1]/', 'IPv6 ULA (private)'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://localhost./', 'FQDN-trailing-dot localhost'],
    ['http://localhost.localdomain/', 'localhost.localdomain alias'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata IPv4 link-local'],
    ['http://10.0.0.5/', 'IPv4 RFC1918'],
  ];
  let blockMissed = 0;
  for (const [url, label] of blockCases) {
    const verdict = rejectPrivateOrInvalid(url);
    if (verdict?.code !== 'blocked_host') {
      fail(`SSRF guard missed ${label}: ${url} → ${verdict ? verdict.code : 'allowed'}`);
      blockMissed += 1;
    }
  }
  if (blockMissed === 0) pass(`SSRF guard blocks ${blockCases.length} known bypass vectors`);

  const allowCases = [
    'https://boards.greenhouse.io/example/jobs/123',
    'https://jobs.lever.co/example/abc-def',
    'https://example.com/careers/role',
    'https://www.pracuj.pl/praca/role,oferta,1234567',
  ];
  let allowDenied = 0;
  for (const url of allowCases) {
    if (rejectPrivateOrInvalid(url) !== null) {
      fail(`SSRF guard false-positive on legitimate ATS URL: ${url}`);
      allowDenied += 1;
    }
  }
  if (allowDenied === 0) pass('SSRF guard lets legitimate ATS URLs through');

  const protoCase = rejectPrivateOrInvalid('file:///etc/passwd');
  if (protoCase?.code === 'unsupported_protocol') {
    pass('SSRF guard rejects unsupported protocol');
  } else {
    fail(`SSRF guard let unsupported protocol through: ${protoCase?.code ?? 'allowed'}`);
  }

  // SSRF redirect routing tests. DNS is injected so this security regression
  // test is deterministic in offline CI and actually exercises both outcomes.
  const resolveHostname = async (hostname) =>
    hostname === 'ssrf-blocked-host.local' ? ['127.0.0.1'] : ['93.184.216.34'];

  let routeCallback = null;
  const mockPageInstance = {
    _blockedByGuard: null,
    async route(pattern, callback) {
      routeCallback = callback;
    },
    async goto() {
      if (routeCallback) {
        let aborted = false;
        const mockRoute = {
          request: () => ({ url: () => 'http://ssrf-blocked-host.local/sensitive-internal' }),
          abort: async () => {
            aborted = true;
          },
          continue: async () => {}
        };
        await routeCallback(mockRoute);
        if (aborted) {
          throw new Error('net::ERR_BLOCKED_BY_CLIENT');
        }
      }
      return { status: () => 200 };
    },
    async waitForTimeout() {},
    url() { return 'https://example.com/redirected'; },
    async evaluate() { return 'body text'; }
  };

  const redirectResult = await checkUrlLiveness(
    mockPageInstance,
    'https://example.com/public-landing',
    { resolveHostname },
  );
  if (redirectResult.result === 'uncertain' && redirectResult.code === 'blocked_host') {
    pass('SSRF redirect guard blocks redirects/subresources to private IPs via routing');
  } else {
    fail(`SSRF redirect guard failed to block: ${JSON.stringify(redirectResult)}`);
  }

  let legitimateRouteCallback = null;
  const mockPageLegitimate = {
    _blockedByGuard: null,
    async route(pattern, callback) {
      legitimateRouteCallback = callback;
    },
    async goto() {
      if (legitimateRouteCallback) {
        let continued = false;
        const mockRoute = {
          request: () => ({ url: () => 'https://example.com/assets/logo.png' }),
          abort: async () => {},
          continue: async () => {
            continued = true;
          }
        };
        await legitimateRouteCallback(mockRoute);
        if (!continued) {
          throw new Error('Blocked legitimate request');
        }
      }
      return { status: () => 200 };
    },
    async waitForTimeout() {},
    url() { return 'https://example.com'; },
    async evaluate(fn) {
      const fnStr = fn.toString();
      if (fnStr.includes('body')) {
        return 'legitimate page body';
      }
      return ['Apply'];
    }
  };

  const legitimateResult = await checkUrlLiveness(
    mockPageLegitimate,
    'https://example.com',
    { resolveHostname },
  );
  if (legitimateResult.result === 'active') {
    pass('SSRF redirect guard allows legitimate subresource requests');
  } else {
    fail(`SSRF redirect guard blocked legitimate requests: ${JSON.stringify(legitimateResult)}`);
  }
} catch (e) {
  fail(`Liveness classification tests crashed: ${e.message}`);
}

// ── 5. DATA CONTRACT ────────────────────────────────────────────

console.log('\n5. Data contract validation');

// Check system files exist
const systemFiles = [
  'CLAUDE.md', 'CODEX.md', 'VERSION', 'DATA_CONTRACT.md', 'docs/CODEX.md',
  'modes/_shared.md', 'modes/_profile.template.md',
  'modes/oferta.md', 'modes/pdf.md', 'modes/scan.md',
  'modes/heuristics/recruiter-side.md',
  'templates/states.yml', 'templates/cv-template.html',
  '.claude/skills/frontrunner/SKILL.md',
  '.antigravitycli/skills/frontrunner/SKILL.md',
];

for (const f of systemFiles) {
  if (fileExists(f)) {
    pass(`System file exists: ${f}`);
  } else {
    fail(`Missing system file: ${f}`);
  }
}

// Per-CLI SKILL.md entrypoints must be SYMLINKS in the git index (mode 120000).
// A regular-file blob whose content is the link path as text ships a broken,
// empty skill to every user of that CLI — exactly what happened to a CLI whose
// a symlink was created under core.symlinks=false and committed as-is. Checking
// the INDEX mode (not the filesystem) keeps this assertion true on Windows
// checkouts too.
const skillEntrypoints = systemFiles.filter((f) => f.endsWith('/skills/frontrunner/SKILL.md'));
for (const f of skillEntrypoints) {
  const staged = run('git', ['ls-files', '-s', f]);
  if (staged === null || staged === '') {
    fail(`Could not read git index entry for ${f} (lookup failed — not evidence of absence)`);
  } else if (staged.startsWith('120000')) {
    pass(`Entrypoint is a real symlink in git: ${f}`);
  } else {
    fail(`Entrypoint committed as a REGULAR file (mode ${staged.split(' ')[0]}) — users of this CLI get a broken skill: ${f}`);
  }
}

// The SYSTEM_PATHS coverage guard must FAIL when it cannot inspect the tree,
// not report success.
//
// For as long as that guard existed it was a no-op in CI. The script-execution
// section above runs each script from a throwaway copy created inside the repo,
// and `git ls-files` from an untracked directory returns zero paths — so the
// guard printed "OK: 0 tracked files covered" and exited 0 while the real tree
// had an unregistered top-level file. `update-system` never ships an
// unregistered file, so every user who updates silently loses it. That class has
// landed five times with this check green throughout.
//
// This asserts the opposite behaviour directly: invoked where git sees nothing,
// the guard must exit non-zero.
{
  const probeDir = join(ROOT, '.tmp-coverage-guard-probe');
  try {
    mkdirSync(probeDir, { recursive: true });
    copyFileSync(join(ROOT, 'validate-system-paths-coverage.mjs'), join(probeDir, 'validate-system-paths-coverage.mjs'));
    copyFileSync(join(ROOT, 'update-system.mjs'), join(probeDir, 'update-system.mjs'));
    const probe = spawnSync(process.execPath, [join(probeDir, 'validate-system-paths-coverage.mjs')], {
      cwd: probeDir,
      encoding: 'utf-8',
    });
    if (probe.status !== 0) {
      pass('SYSTEM_PATHS coverage guard fails when it cannot inspect the tree (not a silent pass)');
    } else {
      fail('SYSTEM_PATHS coverage guard exited 0 from an untracked dir — it is a no-op in CI again');
    }
  } catch (err) {
    fail(`could not probe the SYSTEM_PATHS coverage guard: ${err.message} (a failed probe is not a pass)`);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

// And the check itself, run where it can actually see the tree. This is the
// assertion that was missing: every tracked file must be claimed by SYSTEM_PATHS
// or USER_PATHS, or `update-system` silently stops shipping it.
{
  const cov = spawnSync(process.execPath, [join(ROOT, 'validate-system-paths-coverage.mjs')], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  if (cov.status === 0) {
    pass('every tracked file is covered by SYSTEM_PATHS or USER_PATHS');
  } else {
    fail(`SYSTEM_PATHS coverage gap — a new file is unregistered and update-system will not ship it:\n${(cov.stderr || cov.stdout || '').trim()}`);
  }
}

// The plugin manifest ships in two locations: .claude-plugin/plugin.json is
// canonical (Claude Code + Copilot CLI both read it), and .github/plugin/
// plugin.json exists only because the awesome-copilot marketplace validator
// accepts just three paths and the Claude-compat one is not among them. Both
// must be bumped together; this assert makes any divergence fail CI loudly
// instead of shipping two drifting manifests.
{
  const canonManifest = readFile('.claude-plugin/plugin.json');
  const copilotManifest = fileExists('.github/plugin/plugin.json') ? readFile('.github/plugin/plugin.json') : null;
  if (copilotManifest === null) {
    fail('.github/plugin/plugin.json missing — awesome-copilot validator needs it (mirror of .claude-plugin/plugin.json)');
  } else if (canonManifest === copilotManifest) {
    pass('plugin.json mirror (.github/plugin/) is byte-identical to the canonical manifest');
  } else {
    fail('plugin.json mirror (.github/plugin/) DIVERGED from .claude-plugin/plugin.json — edit the canonical one and copy it verbatim');
  }
}

// Check user files are NOT tracked (gitignored)
const userFiles = [
  'workspace/profile/profile.yml', 'workspace/profile/targeting.md', 'workspace/search/portals.yml',
];
for (const f of userFiles) {
  const tracked = run('git', ['ls-files', f]);
  if (tracked === '') {
    pass(`User file gitignored: ${f}`);
  } else if (tracked === null) {
    pass(`User file gitignored: ${f}`);
  } else {
    fail(`User file IS tracked (should be gitignored): ${f}`);
  }
}

const batchRunnerSource = readFile('batch/batch-runner.sh');
const minScoreSkipIndex = batchRunnerSource.indexOf('update_state "$id" "$url" "skipped"');
const minScoreReturnIndex = batchRunnerSource.indexOf('return 0', minScoreSkipIndex);
const completedStateIndex = batchRunnerSource.indexOf('update_state "$id" "$url" "completed"', minScoreSkipIndex);
if (
  minScoreSkipIndex !== -1 &&
  minScoreReturnIndex !== -1 &&
  completedStateIndex !== -1 &&
  minScoreSkipIndex < minScoreReturnIndex &&
  minScoreReturnIndex < completedStateIndex
) {
  pass('Batch min-score gate returns before completed state update');
} else {
  fail('Batch min-score gate can fall through to completed state update');
}

if (/if \[\[ "\$status" == "completed" \|\| "\$status" == "skipped" \]\]/.test(batchRunnerSource)) {
  pass('Batch resume treats min-score skipped offers as terminal');
} else {
  fail('Batch resume can reprocess min-score skipped offers');
}

if (/local total=0 completed=0 skipped=0 failed=0 pending=0/.test(batchRunnerSource) &&
    /skipped\) skipped=\$\(\(skipped \+ 1\)\)/.test(batchRunnerSource) &&
    /Completed: \$completed \| Skipped: \$skipped \| Failed: \$failed \| Pending: \$pending/.test(batchRunnerSource)) {
  pass('Batch summary reports skipped offers separately from pending');
} else {
  fail('Batch summary can misreport skipped offers as pending');
}

if (!/\bbc\b/.test(batchRunnerSource)) {
  pass('Batch runner does not depend on bc for score arithmetic');
} else {
  fail('Batch runner still depends on bc for score arithmetic');
}

if (
  !/awk "BEGIN\{[^"]*\$MIN_SCORE/.test(batchRunnerSource) &&
  !/awk "BEGIN\{[^"]*\$score/.test(batchRunnerSource) &&
  !/awk "BEGIN\{[^"]*\$sscore/.test(batchRunnerSource) &&
  /awk -v score="\$score" -v min="\$MIN_SCORE"/.test(batchRunnerSource)
) {
  pass('Batch runner passes score values to awk via -v');
} else {
  fail('Batch runner interpolates score values into awk programs');
}

if (
  /no cached JD; refusing agent\/browser fallback" "\$retries"\n\s+release_report_num "\$report_num"\n/.test(batchRunnerSource) &&
  /mark_paused_rate_limit "\$id" "\$url" "\$started_at" "\$report_num" "\$retries" "\$log_file"\n\s+release_report_num "\$report_num"/.test(batchRunnerSource)
) {
  pass('Batch runner releases shared report reservations on pre-worker and paused exits');
} else {
  fail('Batch runner can leak a shared report reservation on an early terminal exit');
}

// ── 6. PERSONAL DATA LEAK CHECK ─────────────────────────────────

console.log('\n6. Personal data leak check');

const leakPatterns = [
  'Santiago', 'santifer.io', 'Santifer iRepair', 'Zinkee', 'ALMAS',
  'hi@santifer.io', '688921377', '/Users/santifer/',
];

const scanExtensions = ['md', 'yml', 'html', 'mjs', 'sh', 'go', 'json'];
const allowedFiles = [
  // English README + localized translations (all legitimately credit Santiago)
  'README.md', 'README.ar.md', 'README.da.md', 'README.de.md', 'README.es.md', 'README.fr.md', 'README.hi.md',
  'README.ja.md', 'README.ko-KR.md', 'README.pl.md', 'README.pt-BR.md', 'README.ru.md', 'README.ta.md', 'README.cn.md',
  'README.ua.md', 'README.zh-TW.md', 'README.tr.md',
  // Standard project files
  'LICENSE', 'CONTRIBUTING.md',
  'package.json', '.github/FUNDING.yml', 'CLAUDE.md', 'AGENTS.md', 'test-all.mjs',
  // This extracted suite necessarily contains the literals it searches for.
  'tests/core/01-bootstrap-and-data-contracts.mjs',
  '.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', '.github/plugin/plugin.json',
  // Community files (legitimately reference the upstream project)
  'SECURITY.md', 'SUPPORT.md',
  '.github/SECURITY.md',
];

// Build pathspec for git grep — only scan tracked files matching these
// extensions. This is what `grep -rn` was trying to do, but git-aware:
// untracked files (debate artifacts, AI tool scratch, local plans/) and
// gitignored files can't trigger false positives because they were never
// going to reach a commit anyway.
// Argument vector for git grep — no shell involved, so the pathspecs and
// pattern reach git verbatim (no quoting layer, nothing interpolated).
const grepPathspecs = scanExtensions.map(e => `*.${e}`);

let leakFound = false;
for (const pattern of leakPatterns) {
  const result = run(
    'git',
    ['grep', '-n', pattern, '--', ...grepPathspecs],
    { stdio: ['pipe', 'pipe', 'ignore'] }
  );
  if (result) {
    for (const line of result.split('\n')) {
      const file = line.split(':')[0];
      if (allowedFiles.some(a => file.includes(a))) continue;
      warn(`Possible personal data in ${file}: "${pattern}"`);
      leakFound = true;
    }
  }
}
if (!leakFound) {
  pass('No personal data leaks outside allowed files');
}

// ── 7. ABSOLUTE PATH CHECK ──────────────────────────────────────

console.log('\n7. Absolute path check');

// Same git grep approach: only scans tracked files. Untracked AI tool
// outputs, local debate artifacts, etc. can't false-positive here.
const absPathRaw = run(
  'git',
  ['grep', '-n', '/Users/', '--', '*.mjs', '*.sh', '*.md', '*.go', '*.yml'],
  { stdio: ['pipe', 'pipe', 'ignore'] }
);
// The old shell pipeline's `grep -v` exclusions, now as a JS filter.
const ABS_PATH_EXCLUDE = [
  'README.md',
  'LICENSE',
  'CLAUDE.md',
  'test-all.mjs',
  'tests/core/01-bootstrap-and-data-contracts.mjs',
];
const absPathLines = (absPathRaw || '')
  .split('\n')
  .filter(Boolean)
  .filter(line => !ABS_PATH_EXCLUDE.some(x => line.includes(x)));
if (absPathLines.length === 0) {
  pass('No absolute paths in code files');
} else {
  for (const line of absPathLines) {
    fail(`Absolute path: ${line.slice(0, 100)}`);
  }
}

// ── 7b. PDF RENDER WAIT CONDITION ───────────────────────────────
