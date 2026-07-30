import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pass, fail, warn, run, fileExists, ROOT, NODE, getBash, toBashPath } from '../helpers.mjs';
import { readFile, normalizeEol, readTextLF } from './support.mjs';

console.log('\n9. Local parser contract');

const scanScript = readFile('src/scan/scan.mjs');
if (
  scanScript.includes('typeof entry.name !== \'string\'') &&
  scanScript.includes('entry.name.trim()') &&
  scanScript.includes('entry.name.toLowerCase()')
) {
  pass('src/scan/scan.mjs guards company names before filtering');
} else {
  fail('src/scan/scan.mjs does not guard company names before filtering');
}

if (
  scanScript.includes("skipIds: ['local-parser']") &&
  scanScript.includes('local parser failed, used API fallback') &&
  scanScript.includes('resolveProvider(company, providers')
) {
  pass('src/scan/scan.mjs falls back to ATS API when local parser fails');
} else {
  fail('src/scan/scan.mjs does not fall back to ATS API when local parser fails');
}

if (fileExists('providers/local-parser.mjs')) {
  pass('local-parser provider module exists');
} else {
  fail('local-parser provider module is missing');
}

// pipeline.md location column (B1): formatPipelineOffer appends location as a
// 4th pipe-delimited column when present, and degrades to the original 3-column
// form when the ATS exposes no location.
try {
  const { formatPipelineOffer, formatCompensation } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);
  const withLoc = formatPipelineOffer({ url: 'https://x/1', company: 'Acme', title: 'SA', location: 'Remote (US)' });
  const noLoc = formatPipelineOffer({ url: 'https://x/2', company: 'BigCo', title: 'PM' });
  const blankLoc = formatPipelineOffer({ url: 'https://x/3', company: 'Co', title: 'Eng', location: '   ' });
  const nonStringLoc = formatPipelineOffer({ url: 'https://x/3b', company: 'Co', title: 'Eng', location: 42 });
  if (
    withLoc === '- [ ] https://x/1 | Acme | SA | Remote (US)' &&
    noLoc === '- [ ] https://x/2 | BigCo | PM' &&
    blankLoc === '- [ ] https://x/3 | Co | Eng' &&
    nonStringLoc === '- [ ] https://x/3b | Co | Eng'
  ) {
    pass('src/scan/scan.mjs formatPipelineOffer appends location column (degrades to 3 cols when absent / non-string)');
  } else {
    fail(`src/scan/scan.mjs formatPipelineOffer location column wrong: "${withLoc}" / "${noLoc}" / "${blankLoc}" / "${nonStringLoc}"`);
  }

  // pipeline.md compensation column (B3): formatCompensation renders the parsed
  // {min,max,currency} salary; formatPipelineOffer appends it as the 5th column,
  // forcing the (possibly empty) location cell so comp stays positionally 5th.
  const compRange = formatCompensation({ min: 180000, max: 220000, currency: 'USD' });
  const compSingle = formatCompensation({ min: 150000, max: 150000, currency: 'usd' });
  const compNone = formatCompensation(null);
  const compZeroMin = formatCompensation({ min: 0, max: 200000, currency: '' });
  const withComp = formatPipelineOffer({ url: 'https://x/4', company: 'Acme', title: 'AI Eng', location: 'Remote', salary: { min: 180000, max: 220000, currency: 'USD' } });
  const compNoLoc = formatPipelineOffer({ url: 'https://x/5', company: 'Acme', title: 'AI Eng', salary: { min: 180000, max: 220000, currency: 'USD' } });
  if (
    compRange === '180000-220000 USD' &&
    compSingle === '150000 usd' &&
    compNone === '' &&
    compZeroMin === '200000' &&
    withComp === '- [ ] https://x/4 | Acme | AI Eng | Remote | 180000-220000 USD' &&
    compNoLoc === '- [ ] https://x/5 | Acme | AI Eng |  | 180000-220000 USD'
  ) {
    pass('src/scan/scan.mjs formatPipelineOffer appends compensation column (forces empty location cell when needed)');
  } else {
    fail(`src/scan/scan.mjs compensation column wrong: "${compRange}" / "${compSingle}" / "${compNone}" / "${compZeroMin}" / "${withComp}" / "${compNoLoc}"`);
  }

  // pipeline.md optional note (#1142): formatPipelineOffer preserves an optional
  // free-text ranking signal as a labeled `| note: {text}` segment. It rides on
  // any row shape, an absent/empty note is byte-identical to today's output, and
  // the note is sanitized like every other field (a `|` can't inject a column).
  const noteFull = formatPipelineOffer({ url: 'https://x/6', company: 'Acme', title: 'AI Eng', location: 'Remote', salary: { min: 180000, max: 220000, currency: 'USD' }, note: 'curated shortlist' });
  const noteBare = formatPipelineOffer({ url: 'https://x/7', company: 'Acme', title: 'PM', note: 'Top pick' });
  const noteAbsent = formatPipelineOffer({ url: 'https://x/8', company: 'Acme', title: 'PM' });
  const noteEmpty = formatPipelineOffer({ url: 'https://x/8', company: 'Acme', title: 'PM', note: '' });
  const noteNonString = formatPipelineOffer({ url: 'https://x/8', company: 'Acme', title: 'PM', note: 42 });
  const notePipe = formatPipelineOffer({ url: 'https://x/9', company: 'Acme', title: 'PM', note: 'A | B' });
  if (
    noteFull === '- [ ] https://x/6 | Acme | AI Eng | Remote | 180000-220000 USD | note: curated shortlist' &&
    noteBare === '- [ ] https://x/7 | Acme | PM | note: Top pick' &&
    noteEmpty === noteAbsent &&
    noteNonString === noteAbsent &&
    notePipe === '- [ ] https://x/9 | Acme | PM | note: A / B'
  ) {
    pass('src/scan/scan.mjs formatPipelineOffer preserves an optional labeled note (#1142; absent = byte-identical, sanitized)');
  } else {
    fail(`src/scan/scan.mjs note segment wrong: "${noteFull}" / "${noteBare}" / "${noteEmpty}" / "${noteNonString}" / "${notePipe}"`);
  }
} catch (err) {
  fail(`src/scan/scan.mjs formatPipelineOffer import failed: ${err.message}`);
}

try {
  const { appendToPipeline } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-missing-pipeline-'));
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(fixtureRoot, 'workspace', 'search'), { recursive: true });
    process.chdir(fixtureRoot);
    await appendToPipeline([{ url: 'https://jobs.example.com/1', company: 'Acme', title: 'Engineer' }]);
    const pipeline = readFileSync(join(fixtureRoot, 'workspace', 'search', 'pipeline.md'), 'utf-8');
    if (
      pipeline.includes('# Pipeline') &&
      pipeline.includes('## Pending') &&
      pipeline.includes('- [ ] https://jobs.example.com/1 | Acme | Engineer')
    ) {
      pass('src/scan/scan.mjs creates workspace/search/pipeline.md before appending offers on fresh installs (#1252)');
    } else {
      fail(`src/scan/scan.mjs fresh-install pipeline contents wrong: ${JSON.stringify(pipeline)}`);
    }
  } finally {
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
} catch (err) {
  fail(`src/scan/scan.mjs fresh-install pipeline test crashed: ${err.message}`);
}

try {
  const { appendToPipeline } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);
  const { acquirePipelineLock, LockTimeoutError } = await import(pathToFileURL(join(ROOT, 'src/tracker/pipeline-lock.mjs')).href);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-pipeline-lock-'));
  const originalCwd = process.cwd();
  let prevTimeout;
  let prevRetry;
  try {
    mkdirSync(join(fixtureRoot, 'workspace', 'search'), { recursive: true });
    process.chdir(fixtureRoot);
    const pipelinePath = join(fixtureRoot, 'workspace', 'search', 'pipeline.md');
    // Hold the exact lock appendToPipeline() takes, then confirm it genuinely
    // blocks on it (times out) rather than racing straight through to its
    // read-modify-write. The env overrides keep this assertion in the
    // milliseconds range instead of waiting out the module's real default.
    prevTimeout = process.env.FRONTRUNNER_PIPELINE_LOCK_TIMEOUT_MS;
    prevRetry = process.env.FRONTRUNNER_PIPELINE_LOCK_RETRY_MS;
    process.env.FRONTRUNNER_PIPELINE_LOCK_TIMEOUT_MS = '200';
    process.env.FRONTRUNNER_PIPELINE_LOCK_RETRY_MS = '20';
    const held = await acquirePipelineLock(pipelinePath);
    try {
      await appendToPipeline([{ url: 'https://jobs.example.com/1', company: 'Acme', title: 'Engineer' }]);
      fail('appendToPipeline() proceeded while another holder had the pipeline lock — no shared exclusion');
    } catch (e) {
      if (e instanceof LockTimeoutError) pass('appendToPipeline() shares src/tracker/pipeline-lock.mjs — correctly blocked on a lock held elsewhere (LockTimeoutError)');
      else fail(`appendToPipeline() lock sharing: expected LockTimeoutError, got: ${e?.constructor?.name}: ${e?.message}`);
    } finally {
      held.release();
    }
  } finally {
    if (prevTimeout === undefined) delete process.env.FRONTRUNNER_PIPELINE_LOCK_TIMEOUT_MS;
    else process.env.FRONTRUNNER_PIPELINE_LOCK_TIMEOUT_MS = prevTimeout;
    if (prevRetry === undefined) delete process.env.FRONTRUNNER_PIPELINE_LOCK_RETRY_MS;
    else process.env.FRONTRUNNER_PIPELINE_LOCK_RETRY_MS = prevRetry;
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
} catch (err) {
  fail(`src/tracker/pipeline-lock.mjs sharing test crashed: ${err.message}`);
}

// URL dedup normalization (#2065): a cosmetic query-suffix variant of an
// already-processed URL (locale/tracking params, trailing slash, case) must
// still dedup against the bare form, while an identity-bearing param (e.g.
// Greenhouse's gh_jid) must NOT be stripped.
try {
  const { normalizeUrlForDedup } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);

  const bare = 'https://acme.jobs.personio.com/job/2670127';
  const withLang = `${bare}?language=en`;
  const withTrailingSlash = `${bare}/`;
  const withUtm = `${bare}?utm_source=newsletter`;
  const ghJid = 'https://boards.greenhouse.io/acme/jobs/123?gh_jid=123';
  const malformed = 'not a url';

  if (
    normalizeUrlForDedup(withLang) === normalizeUrlForDedup(bare) &&
    normalizeUrlForDedup(withTrailingSlash) === normalizeUrlForDedup(bare) &&
    normalizeUrlForDedup(withUtm) === normalizeUrlForDedup(bare) &&
    normalizeUrlForDedup(ghJid).includes('gh_jid=123') &&
    normalizeUrlForDedup(malformed) === malformed
  ) {
    pass('src/scan/scan.mjs normalizeUrlForDedup strips cosmetic params/trailing slash but preserves identity params and malformed input (#2065)');
  } else {
    fail(`src/scan/scan.mjs normalizeUrlForDedup wrong: withLang=${normalizeUrlForDedup(withLang)} withTrailingSlash=${normalizeUrlForDedup(withTrailingSlash)} withUtm=${normalizeUrlForDedup(withUtm)} ghJid=${normalizeUrlForDedup(ghJid)} malformed=${normalizeUrlForDedup(malformed)}`);
  }

  // Path casing: src\/scan\/scan.mjs and src\/scan\/scan-ats-full.mjs can reach the identical Workday
  // posting via different path casing (curated workspace/search/portals.yml entry vs. reverse-ATS
  // dataset). A case-sensitive key files them as two roles and pipeline.md gets
  // a duplicate, so the path is lowercased.
  const wdMixed = 'https://Kyndryl.wd5.myworkdayjobs.com/KyndrylProfessionalCareers/job/Network-Engineer_R-64949';
  const wdLower = 'https://kyndryl.wd5.myworkdayjobs.com/kyndrylprofessionalcareers/job/network-engineer_r-64949';
  if (normalizeUrlForDedup(wdMixed) === normalizeUrlForDedup(wdLower)) {
    pass('normalizeUrlForDedup collapses a case-only path difference (same posting via two scanners)');
  } else {
    fail(`normalizeUrlForDedup left a case-only duplicate: ${normalizeUrlForDedup(wdMixed)} vs ${normalizeUrlForDedup(wdLower)}`);
  }

  // ...but query values stay case-sensitive: they can be identity-bearing.
  if (normalizeUrlForDedup('https://boards.greenhouse.io/acme/jobs/9?gh_jid=AbC').includes('gh_jid=AbC')) {
    pass('normalizeUrlForDedup preserves query-value casing (identity-bearing params)');
  } else {
    fail('normalizeUrlForDedup must not lowercase query values — gh_jid is identity-bearing');
  }

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-seen-urls-'));
  const originalCwd = process.cwd();
  try {
    mkdirSync(join(fixtureRoot, 'workspace', '.state'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'workspace', '.state', 'scan-history.tsv'),
      `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n${withLang}\t2026-07-06\tpersonio-feed\tPM\tAcme\tadded\tRemote\n`,
      'utf-8',
    );
    process.chdir(fixtureRoot);
    const { loadSeenUrls } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);
    const { seen } = loadSeenUrls();
    if (seen.has(normalizeUrlForDedup(bare)) && seen.has(normalizeUrlForDedup(withLang))) {
      pass('src/scan/scan.mjs loadSeenUrls dedups a history row against a cosmetic query-suffix variant (#2065)');
    } else {
      fail(`src/scan/scan.mjs loadSeenUrls did not dedup query-suffix variant: has(bare)=${seen.has(normalizeUrlForDedup(bare))} has(withLang)=${seen.has(normalizeUrlForDedup(withLang))}`);
    }

    // Same dedupUrl-once pattern the main-loop and runSeedScan/scan-ats-full
    // loops use: a job re-fetched under either URL variant of an already-seen
    // history row must be counted as a dupe (never re-added to seenUrls).
    let dupeCount = 0;
    let newCount = 0;
    for (const jobUrl of [bare, withLang, withTrailingSlash]) {
      const dedupUrl = normalizeUrlForDedup(jobUrl);
      if (seen.has(dedupUrl)) {
        dupeCount++;
      } else {
        seen.add(dedupUrl);
        newCount++;
      }
    }
    if (dupeCount === 3 && newCount === 0) {
      pass('src/scan/scan.mjs main-loop dedup pattern treats every cosmetic URL variant of a seen row as a duplicate, never re-adds (#2065)');
    } else {
      fail(`src/scan/scan.mjs main-loop dedup pattern wrong: dupeCount=${dupeCount} newCount=${newCount} (expected 3/0)`);
    }
  } finally {
    process.chdir(originalCwd);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
} catch (err) {
  fail(`src/scan/scan.mjs normalizeUrlForDedup test crashed: ${err.message}`);
}

// Company blacklist (#1742): workspace/search/blacklist.md is the user's do-not-apply
// list. parseBlacklist keys rows by the shared normalizeCompany() so matching
// is case- and punctuation-insensitive; loadBlacklist on an absent file is a
// no-op (empty Map — the scan filter never fires).
try {
  const { parseBlacklist, loadBlacklist } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);
  const bl = parseBlacklist([
    '# Company Blacklist',
    '',
    '| Company | Since | Scope | Reason |',
    '|---------|-------|-------|--------|',
    '| Acme Corp. | 2026-01-15 | company | post-interview process signals |',
    '| Globex | 2026-02-01 | company | zero conversion |',
  ].join('\n'));
  const exact = bl.get('acmecorp');
  if (
    bl.size === 2 &&
    exact && exact.reason === 'post-interview process signals' && exact.since === '2026-01-15' &&
    bl.has('globex') && !bl.has('company')
  ) {
    pass('src/scan/scan.mjs parseBlacklist parses the table and keys by normalized company (#1742)');
  } else {
    fail(`src/scan/scan.mjs parseBlacklist wrong: size=${bl.size} keys=${[...bl.keys()].join(',')}`);
  }

  // Normalization tier: the same key the tracker writers use, so an ATS feed
  // variant ("ACME-CORP", "acme corp") hits the "Acme Corp." row.
  const { normalizeCompany } = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker-utils.mjs')).href);
  if (bl.get(normalizeCompany('ACME-CORP')) === exact && bl.get(normalizeCompany('acme corp')) === exact) {
    pass('src/scan/scan.mjs blacklist matching is case/punctuation-insensitive via shared normalizeCompany (#1742)');
  } else {
    fail('src/scan/scan.mjs blacklist matching misses case/punctuation company variants');
  }

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-blacklist-'));
  try {
    const absent = loadBlacklist(join(fixtureRoot, 'data', 'blacklist.md'));
    if (absent instanceof Map && absent.size === 0) {
      pass('src/scan/scan.mjs loadBlacklist with absent file is a no-op empty Map (opt-in, #1742)');
    } else {
      fail('src/scan/scan.mjs loadBlacklist did not return an empty Map for an absent file');
    }
    mkdirSync(join(fixtureRoot, 'data'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'data', 'blacklist.md'), '| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Initech | 2026-03-01 | company | example |\n', 'utf-8');
    const present = loadBlacklist(join(fixtureRoot, 'data', 'blacklist.md'));
    if (present.size === 1 && present.get('initech')?.reason === 'example') {
      pass('src/scan/scan.mjs loadBlacklist reads workspace/search/blacklist.md when present (#1742)');
    } else {
      fail('src/scan/scan.mjs loadBlacklist did not parse a present blacklist file');
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
} catch (err) {
  fail(`src/scan/scan.mjs blacklist tests crashed: ${err.message}`);
}

// Blacklist wiring: skips are counted and reported (never silent), persisted to
// scan-runs.tsv by header name, and --include-blacklisted bypasses the filter.
if (
  scanScript.includes("args.includes('--include-blacklisted')") &&
  scanScript.includes('totalFilteredBlacklist') &&
  scanScript.includes('skipped (blacklist)') &&
  scanScript.includes('filtered_blacklist')
) {
  pass('src/scan/scan.mjs wires blacklist counter, summary line, scan-runs column, and --include-blacklisted (#1742)');
} else {
  fail('src/scan/scan.mjs missing blacklist counter/summary/scan-runs/--include-blacklisted wiring');
}

// Prompt-level gates (#1742): direct oferta/apply modes name the user gate,
// while auto-pipeline delegates it to the canonical deterministic scanner.
{
  const ofertaGate = readFile('modes/oferta.md');
  const autoGate = readFile('modes/auto-pipeline.md');
  const applyGate = readFile('modes/apply.md');
  if (
    ofertaGate.includes('## Blacklist gate') && ofertaGate.includes('workspace/search/blacklist.md') &&
    autoGate.includes('src/pipeline/run.mjs') && autoGate.includes('workspace/search/blacklist.md') &&
    applyGate.includes('Blacklist check') && applyGate.includes('workspace/search/blacklist.md')
  ) {
    pass('modes gate on workspace/search/blacklist.md before evaluation and form filling (#1742)');
  } else {
    fail('modes missing the workspace/search/blacklist.md gate (oferta/auto-pipeline/apply)');
  }
}

// Read-only JD resolution: direct evaluation modes and the canonical pipeline
// must prefer provider APIs/cache and reserve browser extraction for fallback.
// scan.md and pipeline.md delegate the whole sequence to reviewed code.
{
  const ofertaJdPath = readFile('modes/oferta.md');
  const autoPipelineJdPath = readFile('modes/auto-pipeline.md');
  const pipelineJdPath = readFile('modes/pipeline.md');
  const scanJdPath = readFile('modes/scan.md');
  if (
    ofertaJdPath.includes('src/scan/liveness-service.mjs') &&
    ofertaJdPath.includes('provider API first') &&
    ofertaJdPath.includes('Only when') &&
    autoPipelineJdPath.includes('Provider APIs run before') &&
    autoPipelineJdPath.includes('Playwright fallback') &&
    pipelineJdPath.includes('npm run pipeline') &&
    pipelineJdPath.includes('provider API') &&
    pipelineJdPath.includes('Playwright') &&
    scanJdPath.includes('Provider APIs are authoritative') &&
    scanJdPath.includes('Playwright service is a bounded fallback') &&
    !scanJdPath.includes('browser_navigate') &&
    !scanJdPath.includes('browser_snapshot')
  ) {
    pass('read-only JD paths prefer provider APIs/cache and keep browser extraction as fallback');
  } else {
    fail('read-only JD paths missing canonical API-first/browser-fallback wiring');
  }
  // apply must stay on the MCP — the extractor is read-only and never fills forms.
  if (!readFile('modes/apply.md').includes('src\/scan\/browser-extract.mjs')) {
    pass('apply mode does not route through the read-only extractor (#1449)');
  } else {
    fail('apply mode references src/scan/browser-extract.mjs — the extractor must not touch the apply/form path');
  }

  // Language-market pipeline mirrors must route execution through the same
  // canonical pipeline while retaining their localized presentation guidance.
  const langPipelines = readdirSync(join(ROOT, 'modes'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `modes/${e.name}/pipeline.md`)
    .filter((p) => existsSync(join(ROOT, p)));
  const langMissing = langPipelines.filter((m) => {
    const src = readFile(m);
    return !(
      src.includes('npm run pipeline') &&
      src.includes('API/cache') &&
      src.includes('Playwright')
    );
  });
  if (langPipelines.length > 0 && langMissing.length === 0) {
    pass(`all ${langPipelines.length} language pipeline mirrors route through the canonical API-first pipeline`);
  } else {
    fail(`language pipeline mirrors missing canonical pipeline override: ${langMissing.join(', ') || '(none found)'}`);
  }
}

if (readFile('DATA_CONTRACT.md').includes('workspace/search/blacklist.md')) {
  pass('DATA_CONTRACT.md registers workspace/search/blacklist.md as user layer (#1742)');
} else {
  fail('DATA_CONTRACT.md does not register workspace/search/blacklist.md');
}

if (fileExists('templates/blacklist.example.md') && readFile('templates/blacklist.example.md').includes('| Company | Since | Scope | Reason |')) {
  pass('templates/blacklist.example.md ships the blacklist table seed (#1742)');
} else {
  fail('templates/blacklist.example.md missing or lacks the table header');
}

const scanMode = fileExists('modes/scan.md') ? readFile('modes/scan.md') : '';
if (
  scanMode.includes('npm run scan') &&
  scanMode.includes('Source coverage belongs in code') &&
  !scanMode.includes('local_parser_ok') &&
  !scanMode.includes('browser_navigate')
) {
  pass('scan.md delegates source coverage and fallback decisions to deterministic code');
} else {
  fail('scan.md reintroduced agent-owned source/fallback orchestration');
}

// Provider-specific field knowledge belongs in provider code, not duplicated
// into an agent prompt where it can drift.
if (
  readFile('providers/ashby.mjs').includes('secondaryLocations') &&
  readFile('providers/lever.mjs').includes('descriptionPlain') &&
  !scanMode.includes('secondaryLocations') &&
  !scanMode.includes('descriptionPlain')
) {
  pass('provider parse conventions live only in deterministic provider modules');
} else {
  fail('provider parse conventions are missing from code or duplicated into scan.md');
}

if (!fileExists('scripts/parsers/cohere_jobs.py')) {
  pass('Cohere parser example is not bundled as a runtime script');
} else {
  fail('Cohere parser example is still bundled as a runtime script');
}

const portalExample = readFile('templates/portals.example.yml');
if (
  !portalExample.includes('cohere_jobs.py') &&
  portalExample.includes('scripts/parsers/example-js-company-jobs.js') &&
  portalExample.includes('scripts/parsers/example_python_company_jobs.py') &&
  portalExample.includes('already know their target careers URL')
) {
  pass('portals example documents a generic local parser contract');
} else {
  fail('portals example still points at a bundled Cohere parser');
}

// Security hardening: command allowlist, in-repo script containment, careers_url/company validation.
try {
  const localParser = (await import(pathToFileURL(join(ROOT, 'providers/local-parser.mjs')).href)).default;

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'rm' } }) === null) {
    pass('local-parser rejects a non-interpreter command (e.g. rm)');
  } else {
    fail('local-parser should reject a command that is not a whitelisted interpreter or in-repo script');
  }

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'python3', script: '/etc/passwd' } }) === null) {
    pass('local-parser rejects a script outside the project root');
  } else {
    fail('local-parser should reject a script path that escapes the project root');
  }

  const okEntry = localParser.detect({
    name: 'X', careers_url: 'https://x.co',
    parser: { command: 'node', script: 'src/scan/scan.mjs' },
  });
  if (okEntry && okEntry.url) pass('local-parser accepts a whitelisted interpreter + an in-repo script');
  else fail('local-parser should accept a whitelisted interpreter with an in-repo script');

  let rejectedUrl = false;
  try {
    await localParser.fetch({ name: 'X', careers_url: '--oops', parser: { command: 'python3', args: ['--url', '{careers_url}'] } });
  } catch (e) {
    rejectedUrl = /careers_url/.test(e.message);
  }
  if (rejectedUrl) pass('local-parser rejects a non-URL careers_url before spawning (argument injection guard)');
  else fail('local-parser should reject a careers_url that is not http(s)');

  let rejectedCompany = false;
  try {
    await localParser.fetch({ name: '--rf', careers_url: 'https://x.co', parser: { command: 'python3', args: ['--company', '{company}'] } });
  } catch (e) {
    rejectedCompany = /company/.test(e.message);
  }
  if (rejectedCompany) pass('local-parser rejects a company name that could be read as a flag');
  else fail('local-parser should reject an unsafe company name');

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'node', args: ['-e', 'process.exit(0)'] } }) === null) {
    pass('local-parser rejects inline interpreter code (node -e ...)');
  } else {
    fail('local-parser should reject inline-code flags (-e/-c/--eval)');
  }

  if (localParser.detect({ name: 'X', careers_url: 'https://x.co', parser: { command: 'node', args: ['--eval=globalThis.x=1', 'src\/scan\/scan.mjs'] } }) === null) {
    pass('local-parser rejects interpreter options before the script (node --eval=… script)');
  } else {
    fail('local-parser should reject interpreter options preceding the parser script');
  }

  if (localParser.detect({ name: 'Yahoo!', careers_url: 'https://x.co', parser: { command: 'node', script: 'src\/scan\/scan.mjs' } })?.url) {
    pass('local-parser accepts a company name with punctuation when {company} is unused');
  } else {
    fail('local-parser should not reject a fixed-script entry over an unused company placeholder');
  }
} catch (e) {
  fail(`local-parser hardening tests crashed: ${e.message}`);
}

// Reverse-scan SSRF guard: a constructed careers_url must resolve to the ATS's own host.
try {
  const { entryOnHost } = await import(pathToFileURL(join(ROOT, 'src/scan/scan-ats-full.mjs')).href);
  const canonical = entryOnHost('acme', 'https://jobs.lever.co/acme', (h) => h === 'jobs.lever.co');
  const offHost = entryOnHost('acme', 'https://evil.example.com/acme', (h) => h === 'jobs.lever.co');
  if (canonical && canonical.careers_url === 'https://jobs.lever.co/acme' && offHost === null) {
    pass('scan-ats-full entryOnHost keeps canonical ATS hosts and drops others (SSRF guard)');
  } else {
    fail('scan-ats-full entryOnHost should keep canonical hosts and drop non-canonical ones');
  }
} catch (e) {
  fail(`scan-ats-full host-guard test crashed: ${e.message}`);
}

// Reverse-scan date gate (--include-undated) + cap-aware sampling (--shuffle).
try {
  const { classifyPostingDate, sampleCompanies } = await import(pathToFileURL(join(ROOT, 'src/scan/scan-ats-full.mjs')).href);
  const cutoff = 1_000_000;
  const dateOk =
    classifyPostingDate({ postedAt: 2_000_000 }, cutoff) === 'keep' &&
    classifyPostingDate({ postedAt: 500_000 }, cutoff) === 'stale' &&
    classifyPostingDate({}, cutoff) === 'undated' &&
    classifyPostingDate({ postedAt: null }, cutoff) === 'undated';
  if (dateOk) pass('scan-ats-full classifyPostingDate: fresh→keep, old→stale, no-date→undated (the --include-undated gate)');
  else fail('scan-ats-full classifyPostingDate gate is wrong');

  const list = ['a', 'b', 'c', 'd', 'e'];
  const prefix = sampleCompanies(list, 3, false);
  const all = sampleCompanies(list, 99, false);
  const shuffled = sampleCompanies(list, 3, true);
  const sampleOk =
    JSON.stringify(prefix) === JSON.stringify(['a', 'b', 'c']) &&        // default = alphabetical prefix
    all.length === 5 &&                                                  // limit >= length → all
    shuffled.length === 3 &&                                             // --shuffle still respects the cap
    shuffled.every((x) => list.includes(x)) &&                           // --shuffle preserves membership
    JSON.stringify(list) === JSON.stringify(['a', 'b', 'c', 'd', 'e']);  // never mutates the input
  if (sampleOk) pass('scan-ats-full sampleCompanies: alphabetical prefix by default; capped, membership-preserving, non-mutating on --shuffle');
  else fail('scan-ats-full sampleCompanies behaves wrong');
} catch (e) {
  fail(`scan-ats-full date-gate/sampling test crashed: ${e.message}`);
}

// Reverse-scan blacklist gate: scan-ats-full must share src\/scan\/scan.mjs's
// user-owned do-not-apply semantics, including audit mode annotation.
try {
  const { filterBlacklistedOffers } = await import(pathToFileURL(join(ROOT, 'src/scan/scan-ats-full.mjs')).href);
  const blacklist = new Map([
    ['acmecorp', { company: 'Acme Corp', reason: 'example reason' }],
  ]);
  const offers = [
    { company: 'Acme Corp.', title: 'Software Engineer', url: 'https://example.com/acme' },
    { company: 'Globex', title: 'Software Engineer', url: 'https://example.com/globex' },
  ];
  const skipped = typeof filterBlacklistedOffers === 'function'
    ? filterBlacklistedOffers(offers, blacklist, { includeBlacklisted: false })
    : null;
  const audited = typeof filterBlacklistedOffers === 'function'
    ? filterBlacklistedOffers(offers, blacklist, { includeBlacklisted: true })
    : null;
  const ok =
    skipped?.filteredBlacklist === 1 &&
    skipped.offers.length === 1 &&
    skipped.offers[0].company === 'Globex' &&
    audited?.annotatedBlacklisted === 1 &&
    audited.offers.length === 2 &&
    audited.offers[0].blacklisted === true &&
    audited.offers[0].note.includes('blacklisted: example reason') &&
    offers[0].blacklisted === undefined;
  if (ok) pass('scan-ats-full filters workspace/search/blacklist.md matches by default and annotates them under --include-blacklisted (#1911)');
  else fail('scan-ats-full missing blacklist filter/audit semantics (#1911)');
} catch (e) {
  fail(`scan-ats-full blacklist test crashed: ${e.message}`);
}

// Reverse-scan content_filter wiring (#1846) — src\/scan\/scan-ats-full.mjs previously
// imported only buildTitleFilter/buildLocationFilter, so workspace/search/portals.yml's
// content_filter (incl. #1638's per-title-keyword scoping) had zero effect
// on reverse scans. passesFilters() is the shared gate runSeedScan() uses;
// exercise it directly with buildContentFilter/matchedTitleKeywords from
// src\/scan\/scan.mjs the same way src\/scan\/scan-ats-full.mjs wires them.
try {
  const { passesFilters } = await import(pathToFileURL(join(ROOT, 'src/scan/scan-ats-full.mjs')).href);
  const { buildTitleFilter, buildLocationFilter, buildContentFilter } =
    await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);

  const titleFilterConfig = { positive: ['AI Engineer', 'Instructional Designer'] };
  const titleFilter = buildTitleFilter(titleFilterConfig);
  const locationFilter = buildLocationFilter(null);

  // (a) A posting that fails the GLOBAL content_filter is rejected.
  const globalCf = buildContentFilter({ positive: ['gpt', 'llm'] });
  const failsGlobal = passesFilters(
    { title: 'AI Engineer', location: '', description: 'Kubernetes and Terraform all day' },
    { titleFilter, locationFilter, contentFilter: globalCf, titleFilterConfig },
  );
  if (failsGlobal === false) {
    pass('scan-ats-full passesFilters rejects a posting failing the global content_filter');
  } else {
    fail('scan-ats-full passesFilters should reject postings failing the global content_filter');
  }

  // (b) A posting that fails a PER-TITLE-KEYWORD content_filter override is rejected.
  const scopedCf = buildContentFilter({
    by_title_keyword: { 'AI Engineer': { positive: ['gpt', 'llm', 'claude'] } },
  });
  const failsScoped = passesFilters(
    { title: 'Senior AI Engineer', location: '', description: 'Build internal tools, no ML involved' },
    { titleFilter, locationFilter, contentFilter: scopedCf, titleFilterConfig },
  );
  if (failsScoped === false) {
    pass('scan-ats-full passesFilters rejects a posting failing its by_title_keyword override');
  } else {
    fail('scan-ats-full passesFilters should reject postings failing a by_title_keyword override');
  }

  // (c) Regression for #1636: a posting matched via a DIFFERENT title keyword
  // with no content_filter override for it must NOT be wrongly rejected.
  const passesUnrelated = passesFilters(
    { title: 'Instructional Designer II', location: '', description: 'Designs onboarding curricula' },
    { titleFilter, locationFilter, contentFilter: scopedCf, titleFilterConfig },
  );
  if (passesUnrelated === true) {
    pass('scan-ats-full passesFilters does not leak an unrelated by_title_keyword override onto a different title match');
  } else {
    fail('scan-ats-full passesFilters wrongly rejected a posting whose matched keyword has no override (#1636 regression)');
  }

  // No content_filter configured at all → behaves exactly as before (title/location only).
  const noCf = passesFilters(
    { title: 'AI Engineer', location: '', description: 'Kubernetes and Terraform all day' },
    { titleFilter, locationFilter, contentFilter: null, titleFilterConfig },
  );
  if (noCf === true) {
    pass('scan-ats-full passesFilters passes everything through when content_filter is absent');
  } else {
    fail('scan-ats-full passesFilters should pass all postings when content_filter is absent');
  }
} catch (e) {
  fail(`scan-ats-full content_filter wiring test crashed: ${e.message}`);
}

// ── VC Portfolio Seed Fetcher ────────────────────────────────────────
// Tests the pure (no-network) parseSeedEntries(), parseYCPayload(),
// parseA16zPayload(), toPortalEntry(), and the SEED_SOURCES registry.
// Inline fixtures — no HTTP calls, CI-safe.

console.log('\n9b. VC portfolio seed fetcher (config/seeds/vc-portfolios.mjs)');

try {
  const {
    parseYCPayload,
    parseA16zPayload,
    parseSeedEntries,
    toPortalEntry,
    SEED_SOURCES,
    SLUG_RE,
  } = await import(pathToFileURL(join(ROOT, 'config/seeds/vc-portfolios.mjs')).href);

  // ── 1. YC payload parsing ──────────────────────────────────────────
  const ycFixture = {
    companies: [
      { name: 'Stripe', slug: 'stripe', website: 'https://stripe.com', batch: 'W11' },
      { name: 'Airbnb', slug: 'airbnb', website: 'https://airbnb.com', batch: 'W09' },
      { name: 'OpenAI', slug: 'openai', website: 'https://openai.com', batch: 'W16' },
    ],
  };
  const ycEntries = parseYCPayload(ycFixture);
  const ycOk =
    ycEntries.length === 3 &&
    ycEntries[0].name === 'Stripe' &&
    ycEntries[0].slug === 'stripe' &&
    ycEntries[0].url === 'https://stripe.com' &&
    ycEntries[0].source === 'yc' &&
    ycEntries[0].batch === 'W11' &&
    ycEntries[1].slug === 'airbnb' &&
    ycEntries[2].slug === 'openai';
  if (ycOk) pass('parseYCPayload: parses companies array into SeedCompany[] with name/slug/url/source/batch');
  else fail(`parseYCPayload: output wrong — ${JSON.stringify(ycEntries[0])}`);

  // parseSeedEntries() is the universal entry point used by the issue acceptance criteria.
  const viaGeneric = parseSeedEntries(ycFixture, 'yc');
  if (viaGeneric.length === 3 && viaGeneric[0].slug === 'stripe') {
    pass('parseSeedEntries(payload, "yc") delegates to parseYCPayload correctly');
  } else {
    fail('parseSeedEntries with source="yc" did not return expected entries');
  }

  // ── 2. a16z HTML parsing ───────────────────────────────────────────
  // Sample HTML fixture with data-company-name attributes (the most reliable strategy).
  const a16zHtml = `
    <div class="portfolio-grid">
      <a href="https://github.com" data-company-name="GitHub" data-company-url="https://github.com" class="portfolio-card"></a>
      <a href="https://lyft.com" data-company-name="Lyft" data-company-url="https://lyft.com" class="portfolio-card"></a>
      <a href="https://slack.com" data-company-name="Slack" data-company-url="https://slack.com" class="portfolio-card"></a>
    </div>
  `;
  const a16zEntries = parseA16zPayload(a16zHtml);
  const a16zOk =
    a16zEntries.length === 3 &&
    a16zEntries.some(e => e.name === 'GitHub' && e.source === 'a16z' && e.url === 'https://github.com') &&
    a16zEntries.some(e => e.name === 'Lyft' && e.source === 'a16z') &&
    a16zEntries.some(e => e.name === 'Slack' && e.source === 'a16z');
  if (a16zOk) pass('parseA16zPayload: extracts companies from data-company-name HTML attributes');
  else fail(`parseA16zPayload: output wrong — got ${a16zEntries.length} entries: ${JSON.stringify(a16zEntries.map(e => e.name))}`);

  // parseSeedEntries() delegating to a16z.
  const a16zViaGeneric = parseSeedEntries(a16zHtml, 'a16z');
  if (a16zViaGeneric.length === 3 && a16zViaGeneric.some(e => e.slug === 'github')) {
    pass('parseSeedEntries(html, "a16z") delegates to parseA16zPayload correctly');
  } else {
    fail('parseSeedEntries with source="a16z" did not return expected entries');
  }

  // ── 3. SLUG_RE validation — invalid slugs are dropped ─────────────
  const badSlugFixture = {
    companies: [
      { name: 'Good Co', slug: 'good-co', website: 'https://good.co' },
      { name: 'Bad Slash', slug: 'bad/slash', website: 'https://bad.com' },      // rejected: /
      { name: 'Bad Space', slug: 'bad space', website: 'https://bad2.com' },     // rejected: space
      { name: 'Bad Bang', slug: 'bad!bang', website: 'https://bad3.com' },       // rejected: !
      { name: 'Also Good', slug: 'also.good_123', website: 'https://also.co' }, // valid: . _ digits
    ],
  };
  const slugFiltered = parseYCPayload(badSlugFixture);
  const slugOk =
    slugFiltered.length === 2 &&
    slugFiltered.some(e => e.slug === 'good-co') &&
    slugFiltered.some(e => e.slug === 'also.good_123') &&
    !slugFiltered.some(e => e.slug.includes('/') || e.slug.includes(' ') || e.slug.includes('!'));
  if (slugOk) pass('SLUG_RE validation: entries with invalid slug characters (/, space, !) are dropped; valid slugs pass through');
  else fail(`SLUG_RE validation wrong — got: ${JSON.stringify(slugFiltered.map(e => e.slug))}`);

  // ── 4. toPortalEntry — explicit ATS hint ──────────────────────────
  const withGreenhouse = toPortalEntry({ name: 'Stripe', slug: 'stripe', url: 'https://stripe.com', source: 'yc', ats: 'greenhouse', ats_id: 'stripe' });
  const withLever = toPortalEntry({ name: 'Acme', slug: 'acme', url: 'https://acme.com', source: 'yc', ats: 'lever', ats_id: 'acme' });
  const withAshby = toPortalEntry({ name: 'Beta', slug: 'beta', url: 'https://beta.com', source: 'yc', ats: 'ashby', ats_id: 'beta-corp' });
  const atsHintOk =
    withGreenhouse.careers_url === 'https://job-boards.greenhouse.io/stripe' &&
    withGreenhouse.name === 'Stripe' &&
    withGreenhouse.source === 'yc' &&
    withLever.careers_url === 'https://jobs.lever.co/acme' &&
    withAshby.careers_url === 'https://jobs.ashbyhq.com/beta-corp';
  if (atsHintOk) pass('toPortalEntry: explicit ats+ats_id hint maps to correct Greenhouse/Lever/Ashby URL');
  else fail(`toPortalEntry ATS hint wrong — greenhouse: ${withGreenhouse.careers_url}, lever: ${withLever.careers_url}`);

  // ── 5. toPortalEntry — no ATS hint, slug-based fallback ───────────
  const noHint = toPortalEntry({ name: 'NewCo', slug: 'newco', url: 'https://newco.io', source: 'yc' });
  const noHintOk =
    noHint.careers_url === 'https://job-boards.greenhouse.io/newco' && // Greenhouse is the default probe
    noHint.name === 'NewCo';
  if (noHintOk) pass('toPortalEntry: no ATS hint falls back to Greenhouse URL from slug (provider.detect() validates at scan time)');
  else fail(`toPortalEntry fallback wrong — got: ${noHint.careers_url}`);

  // ── 5b. toPortalEntry — website fallback when slug is empty ───────
  const noSlug = toPortalEntry({ name: 'Custom', slug: '', url: 'https://custom.com', source: 'a16z' });
  if (noSlug.careers_url === 'https://custom.com') {
    pass('toPortalEntry: empty slug falls back to company website URL');
  } else {
    fail(`toPortalEntry website fallback wrong — got: ${noSlug.careers_url}`);
  }

  // ── 6. Dedup guard — duplicate slugs yield only one entry ─────────
  const dupFixture = {
    companies: [
      { name: 'Stripe', slug: 'stripe', website: 'https://stripe.com' },
      { name: 'Stripe Inc', slug: 'stripe', website: 'https://stripe.com/inc' }, // same slug → dropped
      { name: 'Airbnb', slug: 'airbnb', website: 'https://airbnb.com' },
    ],
  };
  const dedupd = parseYCPayload(dupFixture);
  if (dedupd.length === 2 && dedupd.filter(e => e.slug === 'stripe').length === 1) {
    pass('parseSeedEntries dedup: duplicate slugs produce only one entry (first one wins)');
  } else {
    fail(`parseSeedEntries dedup wrong — got ${dedupd.length} entries`);
  }

  // ── 7. SEED_SOURCES registry ───────────────────────────────────────
  const registryOk =
    typeof SEED_SOURCES === 'object' &&
    SEED_SOURCES !== null &&
    typeof SEED_SOURCES.yc === 'object' &&
    typeof SEED_SOURCES.yc.fetch === 'function' &&
    typeof SEED_SOURCES.yc.label === 'string' &&
    typeof SEED_SOURCES.a16z === 'object' &&
    typeof SEED_SOURCES.a16z.fetch === 'function' &&
    typeof SEED_SOURCES.a16z.label === 'string' &&
    Object.keys(SEED_SOURCES).includes('yc') &&
    Object.keys(SEED_SOURCES).includes('a16z');
  if (registryOk) pass('SEED_SOURCES registry: both "yc" and "a16z" keys exist with fetch function and label string');
  else fail(`SEED_SOURCES registry malformed — keys: ${JSON.stringify(Object.keys(SEED_SOURCES || {}))}`);

} catch (e) {
  fail(`VC portfolio seed fetcher tests crashed: ${e.message}`);
}

// src\/tracker\/tracker.mjs delete: removeRowByNum removes the right row, preserves the rest.
try {
  const { removeRowByNum } = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker.mjs')).href);
  const md = [
    '# Applications',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-01 | Acme | Dev | 4.0/5 | Evaluated | y | [r1](workspace/reports/evaluations/1.md) | a |',
    '| 2 | 2026-06-02 | Beta | Eng | 3.5/5 | Applied | y | [r2](workspace/reports/evaluations/2.md) | b |',
    '| 3 | 2026-06-03 | Gamma | Lead | 4.5/5 | Interview | y | [r3](workspace/reports/evaluations/3.md) | c |',
    '',
  ].join('\n');
  const r2 = removeRowByNum(md, 2);
  const miss = removeRowByNum(md, 99);
  const ok =
    r2.removed && r2.removedCount === 1 &&
    r2.report === '[r2](workspace/reports/evaluations/2.md)' &&            // report column (index 7) surfaced for orphan note
    !r2.newContent.includes('| 2 |') &&              // the target row is gone
    r2.newContent.includes('| 1 |') && r2.newContent.includes('| 3 |') && // other rows kept
    r2.newContent.includes('# Applications') &&      // non-table line preserved
    r2.newContent.includes('|---|') &&               // separator preserved
    miss.removed === false && miss.newContent === md; // no-op on a missing number
  if (ok) pass('src/tracker/tracker.mjs removeRowByNum: removes the matching row, preserves header/separator/other rows, no-op on miss');
  else fail('src/tracker/tracker.mjs removeRowByNum behaves wrong');
} catch (e) {
  fail(`src/tracker/tracker.mjs removeRowByNum test crashed: ${e.message}`);
}

// Every applications.md writer must perform its read and atomic replacement
// through one shared transaction object. The integration suite proves actual
// contention; these structural checks enforce the transaction boundaries.
try {
  const nodeTrackerWriters = [
    ['src/tracker/dedup-tracker.mjs', 1],
    ['src/tracker/normalize-statuses.mjs', 1],
    ['src/tracker/reply-watch.mjs', 1],
    ['src/tracker/tracker.mjs', 2],
  ];
  const unsafeWriters = nodeTrackerWriters.filter(([name, minTransactions]) => {
    const source = readFile(name);
    const opens = (source.match(/await\s+openTrackerTransaction\s*\(/g) || []).length;
    const reads = (source.match(/trackerTransaction\.read\s*\(/g) || []).length;
    const replacements = (source.match(/trackerTransaction\.replace\s*\(/g) || []).length;
    const closes = (source.match(/trackerTransaction\??\.close\s*\(/g) || []).length;
    return opens < minTransactions || reads < 1 || replacements < minTransactions || closes < minTransactions
      || source.includes('acquireTrackerLock') || source.includes('trackerLockDirFor')
      || /writeFileAtomic\(\s*(?:APPS_FILE|MD_PATH|trackerPath|writeTarget)\b/.test(source)
      || /(?:fs\.)?writeFileSync\(\s*(?:APPS_FILE|MD_PATH|trackerPath)\b/.test(source);
  }).map(([name]) => name);
  if (unsafeWriters.length === 0) {
    pass('all root tracker writers keep read and atomic replacement in shared transactions');
  } else {
    fail(`tracker writers bypass shared transaction scope: ${unsafeWriters.join(', ')}`);
  }

  // (Go dashboard removed in Frontrunner — the cross-runtime half of this
  //  lock contract no longer applies; the JS writers above are still checked.)
} catch (e) {
  fail(`tracker writer lock contract tests crashed: ${e.message}`);
}

// ── 10. PORTALS CONFIG VALIDATOR ────────────────────────────────

console.log('\n10. Portals config validator');

try {
  const tmp = mkdtempSync(join(tmpdir(), 'frontrunner-portals-validator-'));
  const validPath = join(tmp, 'valid.yml');
  const invalidProviderPath = join(tmp, 'invalid-provider.yml');
  const emptyKeywordPath = join(tmp, 'empty-keyword.yml');
  const duplicateCompanyPath = join(tmp, 'duplicate-company.yml');
  const badContentFilterPath = join(tmp, 'bad-content-filter.yml');
  const deadByTitleKeywordPath = join(tmp, 'dead-by-title-keyword.yml');
  const badVisaFilterPath = join(tmp, 'bad-visa-filter.yml');

  writeFileSync(validPath, `
title_filter:
  positive: ["AI"]
  negative: ["Intern"]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  writeFileSync(invalidProviderPath, `
title_filter:
  positive: ["AI"]
tracked_companies:
  - name: "Acme"
    provider: "missing-provider"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  writeFileSync(emptyKeywordPath, `
title_filter:
  positive: ["AI", "   "]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  writeFileSync(duplicateCompanyPath, `
title_filter:
  positive: ["AI"]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
  - name: " acme "
    careers_url: "https://jobs.lever.co/acme2"
`, 'utf-8');

  // content_filter with an empty-string keyword must be rejected, same as
  // title/location filters (an empty keyword would match every description).
  writeFileSync(badContentFilterPath, `
title_filter:
  positive: ["AI"]
content_filter:
  positive: ["rust", "   "]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  // by_title_keyword.<kw> that doesn't match any title_filter.positive entry
  // (typo, or a keyword later removed from title_filter) is dead config — it
  // will never fire. Should warn, not error (#1636 CodeRabbit follow-up).
  writeFileSync(deadByTitleKeywordPath, `
title_filter:
  positive: ["AI Engineer"]
content_filter:
  by_title_keyword:
    "AI Enginer":
      positive: ["gpt"]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  // visa_filter with an empty-string keyword or a non-boolean require_mention
  // must be rejected (an empty keyword would match every description).
  writeFileSync(badVisaFilterPath, `
title_filter:
  positive: ["AI"]
visa_filter:
  require_mention: "yes"
  positive: ["h-1b", "   "]
tracked_companies:
  - name: "Acme"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');

  const validResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', validPath]);
  if (validResult !== null && validResult.includes('0 errors')) {
    pass('validate-portals accepts a minimal valid portals file');
  } else {
    fail('validate-portals should accept a minimal valid portals file');
  }

  const exampleResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', 'templates/portals.example.yml']);
  if (exampleResult !== null && exampleResult.includes('0 errors')) {
    pass('validate-portals accepts templates/portals.example.yml');
  } else {
    fail('validate-portals should accept templates/portals.example.yml');
  }

  const invalidProviderResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', invalidProviderPath]);
  if (invalidProviderResult === null) {
    pass('validate-portals rejects unknown explicit providers');
  } else {
    fail('validate-portals should reject unknown explicit providers');
  }

  const emptyKeywordResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', emptyKeywordPath]);
  if (emptyKeywordResult === null) {
    pass('validate-portals rejects empty title/location keywords');
  } else {
    fail('validate-portals should reject empty title/location keywords');
  }

  const duplicateCompanyResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', duplicateCompanyPath]);
  if (duplicateCompanyResult !== null && duplicateCompanyResult.includes('1 warning')) {
    pass('validate-portals warns on duplicate enabled company names');
  } else {
    fail('validate-portals should warn on duplicate enabled company names');
  }

  const badContentFilterResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', badContentFilterPath]);
  if (badContentFilterResult === null) {
    pass('validate-portals rejects empty content_filter keywords');
  } else {
    fail('validate-portals should reject empty content_filter keywords');
  }

  const deadByTitleKeywordResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', deadByTitleKeywordPath]);
  if (deadByTitleKeywordResult !== null && deadByTitleKeywordResult.includes('1 warning')) {
    pass('validate-portals warns on a by_title_keyword entry with no matching title_filter.positive keyword');
  } else {
    fail('validate-portals should warn (not error) on a dead by_title_keyword entry');
  }

  const badVisaFilterResult = run(NODE, ['src/scan/validate-portals.mjs', '--file', badVisaFilterPath]);
  if (badVisaFilterResult === null) {
    pass('validate-portals rejects invalid visa_filter (empty keyword / non-boolean require_mention)');
  } else {
    fail('validate-portals should reject invalid visa_filter');
  }

  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  fail(`portals validator tests crashed: ${e.message}`);
}

// ── 10b. PORTAL SLUG VALIDATOR (src\/scan\/verify-portals.mjs) ─────────────

console.log('\n10b. Portal slug validator');

try {
  const { deriveSlugCandidates, parseAtsSlug, verifyCompanies, classifyFetchError } =
    await import(pathToFileURL(join(ROOT, 'src/scan/verify-portals.mjs')).href);

  const slugs = deriveSlugCandidates('Acme Corp!');
  const baseSlugs = ['acmecorp', 'acme-corp', 'acme_corp', 'acme'];
  if (baseSlugs.every((s) => slugs.includes(s)) && slugs.includes('acmeai') && slugs.includes('acme.tech')) {
    pass('verify-portals derives slug candidates from a company name');
  } else {
    fail(`verify-portals slug candidates wrong: ${JSON.stringify(slugs)}`);
  }

  if (deriveSlugCandidates('Deepset').includes('deepsetai')) {
    pass('verify-portals derives common slug suffixes (e.g. deepsetai)');
  } else {
    fail('verify-portals missing deepsetai suffix for Deepset');
  }

  if (
    classifyFetchError({ status: 404 }) === 'slug_gone' &&
    classifyFetchError({ name: 'AbortError' }) === 'network' &&
    classifyFetchError({ status: 503 }) === 'server'
  ) {
    pass('verify-portals classifies fetch errors by kind');
  } else {
    fail('verify-portals classifyFetchError misclassified HTTP errors');
  }

  if (
    parseAtsSlug('https://job-boards.greenhouse.io/acme')?.ats === 'greenhouse' &&
    parseAtsSlug('https://jobs.ashbyhq.com/acme')?.ats === 'ashby' &&
    parseAtsSlug('https://api.lever.co/v0/postings/acme')?.slug === 'acme' &&
    parseAtsSlug('https://openai.com/careers') === null
  ) {
    pass('verify-portals recognizes ATS slugs and skips branded URLs');
  } else {
    fail('verify-portals parseAtsSlug misclassified an ATS or branded URL');
  }

  const leverSlug = parseAtsSlug('https://jobs.lever.co/acme');
  if (leverSlug?.ats === 'lever' && leverSlug?.slug === 'acme' && !leverSlug?.eu) {
    pass('verify-portals parseAtsSlug extracts lever slug from jobs.lever.co URL');
  } else {
    fail(`verify-portals parseAtsSlug lever: ${JSON.stringify(leverSlug)}`);
  }

  const leverEuSlug = parseAtsSlug('https://jobs.eu.lever.co/acme-eu');
  if (leverEuSlug?.ats === 'lever' && leverEuSlug?.slug === 'acme-eu' && leverEuSlug?.eu === true) {
    pass('verify-portals parseAtsSlug extracts lever-eu slug and sets eu:true from jobs.eu.lever.co URL');
  } else {
    fail(`verify-portals parseAtsSlug lever-eu: ${JSON.stringify(leverEuSlug)}`);
  }

  // Mock fetchJson: 200+jobs → live, 200+empty → empty, otherwise 404 → missing.
  const mockFetch = async (url) => {
    if (url.includes('/boards/live/jobs')) return { jobs: [{}, {}] };
    if (url.includes('/boards/empty/jobs')) return { jobs: [] };
    if (url.includes('/posting-api/job-board/deepsetai')) return { jobs: [{}] };
    if (url.includes('api.lever.co/v0/postings/acme-lv')) return [{}];
    if (url.includes('api.eu.lever.co/v0/postings/acme-eu')) return [{}, {}, {}];
    if (url === 'https://api.eu.lever.co/v0/postings/diabolocom') return [{}, {}];
    const err = new Error('HTTP 404'); err.status = 404; throw err;
  };
  const results = await verifyCompanies([
    { name: 'Live', careers_url: 'https://job-boards.greenhouse.io/live' },
    { name: 'Empty', careers_url: 'https://job-boards.greenhouse.io/empty' },
    { name: 'Typo', careers_url: 'https://job-boards.greenhouse.io/nope' },
    { name: 'Deepset', careers_url: 'https://job-boards.greenhouse.io/deepset' },
    { name: 'Branded', careers_url: 'https://acme.com/careers' },
    { name: 'Off', enabled: false, careers_url: 'https://job-boards.greenhouse.io/live' },
    { name: 'Lever Live', careers_url: 'https://jobs.lever.co/acme-lv' },
    { name: 'Lever EU Live', careers_url: 'https://jobs.eu.lever.co/acme-eu' },
    { name: 'Diabolocom EU Discovery', careers_url: 'https://job-boards.greenhouse.io/does-not-exist-diabolocom' },
  ], { fetchJson: mockFetch });
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  if (
    results.length === 8 &&
    byName.Live.status === 'live' && byName.Empty.status === 'empty' &&
    byName.Typo.status === 'missing' && byName.Typo.errorKind === 'slug_gone' &&
    byName.Branded.status === 'skipped' &&
    byName['Lever Live'].status === 'live' &&
    byName['Lever EU Live'].status === 'live' &&
    byName.Deepset.suggested?.ats === 'ashby' && byName.Deepset.suggested?.slug === 'deepsetai' &&
    byName['Diabolocom EU Discovery'].suggested?.ats === 'lever' &&
    byName['Diabolocom EU Discovery'].suggested?.slug === 'diabolocom' &&
    byName['Diabolocom EU Discovery'].suggested?.url === 'https://api.eu.lever.co/v0/postings/diabolocom'
  ) {
    pass('verify-portals classifies live / empty / unresolved / non-ATS (disabled excluded)');
  } else {
    fail(`verify-portals classification wrong: ${JSON.stringify(byName)} (${results.length} rows)`);
  }

  // Tier 2: non-ATS companies are probed through the scanner's provider layer,
  // bounded to a few requests. Fake providers stand in for Workday/SF/etc.
  const fakeCtx = { transport: 'http', fetchJson: async () => ({}), fetchText: async () => ['x'] };
  const fakeProviders = new Map([
    ['fakeats', {
      id: 'fakeats',
      detect: (e) => (/fakeats\.io/.test(e.careers_url || '') ? { url: e.careers_url } : null),
      fetch: async (e, ctx) => {
        // The probe MUST bound pagination — a provider is never asked to walk a
        // whole board for a health check.
        if (ctx.maxPages !== 1) throw new Error('probe did not pass maxPages=1');
        if (e.careers_url.includes('/full')) return [
          { title: 'A', url: 'https://fakeats.io/jobs/a', company: e.name, location: '' },
          { title: 'B', url: 'https://fakeats.io/jobs/b', company: e.name, location: '' },
        ];
        if (e.careers_url.includes('/empty')) return [];
        const err = new Error('HTTP 404'); err.status = 404; throw err;
      },
    }],
    ['pager', {
      // Ignores maxPages and paginates forever; the probe's request budget must
      // still cut it off after the budgeted pages and classify it live.
      id: 'pager',
      detect: (e) => (/pager\.io/.test(e.careers_url || '') ? { url: e.careers_url } : null),
      fetch: async (e, ctx) => {
        const jobs = [];
        for (let p = 0; p < 50; p++) jobs.push(...(await ctx.fetchText(`u?p=${p}`)));
        return jobs;
      },
    }],
    ['swallower', {
      // Mimics SuccessFactors CSB: burns the whole budget on discovery/locale
      // requests that yield no jobs, swallowing every fetch error internally
      // (per-locale try/catch). The probe must read "budget tripped + 0 jobs"
      // as live/partial — the endpoint answered fine — never as 'empty'.
      id: 'swallower',
      detect: (e) => (/swallower\.io/.test(e.careers_url || '') ? { url: e.careers_url } : null),
      fetch: async (e, ctx) => {
        for (let p = 0; p < 50; p++) {
          try { await ctx.fetchJson(`u?p=${p}`); } catch { break; }
        }
        return [];
      },
    }],
  ]);
  const provResults = await verifyCompanies([
    { name: 'PFull', careers_url: 'https://fakeats.io/full' },
    { name: 'PEmpty', careers_url: 'https://fakeats.io/empty' },
    { name: 'PDead', careers_url: 'https://fakeats.io/dead' },
    { name: 'PPager', careers_url: 'https://pager.io/board' },
    { name: 'PSwallow', careers_url: 'https://swallower.io/board' },
    { name: 'NoProv', careers_url: 'https://unknown.example/careers' },
  ], { fetchJson: mockFetch, providers: fakeProviders, httpCtx: fakeCtx });
  const pv = Object.fromEntries(provResults.map((r) => [r.name, r]));
  if (
    pv.PFull?.status === 'live' && pv.PFull?.jobCount === 2 &&
    pv.PEmpty?.status === 'empty' &&
    pv.PDead?.status === 'missing' && pv.PDead?.errorKind === 'slug_gone' &&
    pv.PPager?.status === 'live' && pv.PPager?.partial === true &&
    pv.PSwallow?.status === 'live' && pv.PSwallow?.partial === true &&
    pv.NoProv?.status === 'skipped'
  ) {
    pass('verify-portals probes non-ATS boards via providers, bounded to a request budget');
  } else {
    fail(`verify-portals provider-fallback wrong: ${JSON.stringify(pv)}`);
  }

  // Without a providers map, non-ATS entries must stay skipped (unchanged CLI
  // behavior for the ATS-only unit path).
  const noProv = await verifyCompanies(
    [{ name: 'X', careers_url: 'https://fakeats.io/full' }],
    { fetchJson: mockFetch },
  );
  if (noProv[0]?.status === 'skipped') {
    pass('verify-portals stays skipped for non-ATS when no providers are supplied');
  } else {
    fail(`verify-portals should skip non-ATS without providers: ${JSON.stringify(noProv)}`);
  }
} catch (e) {
  fail(`portal slug validator tests crashed: ${e.message}`);
}

// ── 11. AGENTS.md INTEGRITY ─────────────────────────────────────
