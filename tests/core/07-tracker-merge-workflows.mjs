import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pass, fail, warn, run, fileExists, ROOT, NODE, getBash, toBashPath } from '../helpers.mjs';
import { readFile, normalizeEol, readTextLF } from './support.mjs';

console.log('\n🧪 Testing dedup-tracker with an inserted Location column...');
try {
  const locTmp = mkdtempSync(join(tmpdir(), 'frontrunner-dedup-loc-'));
  try {
    mkdirSync(join(locTmp, 'data'));
    const tracker = join(locTmp, 'data', 'applications.md');
    // Two dup rows (same company+role) with a Location column. Keeper #60 has the
    // higher score but the lower status; dedup must promote its Status cell.
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|----------|-------|--------|-----|--------|-------|\n' +
      '| 60 | 2026-02-01 | Globex | Widget Engineer | Berlin | 4.5/5 | Rejected | ❌ | [60](r.md) | LOC_SENTINEL |\n' +
      '| 61 | 2026-02-02 | Globex | Widget Engineer | Berlin | 3.0/5 | Evaluated | ❌ | [61](r.md) | dup |\n');

    const r = run(NODE, ['src/tracker/dedup-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker } });
    if (r === null) {
      fail('dedup-tracker crashed on a Location-column tracker');
    } else {
      const out = readFileSync(tracker, 'utf-8');
      const keeper = out.split('\n').find(l => l.includes('| 60 |'));
      // Status cell promoted to Evaluated; Location (Berlin) and the score untouched.
      if (keeper && keeper.includes('Berlin') && keeper.includes('4.5/5') && keeper.includes('Evaluated') && keeper.includes('LOC_SENTINEL')) {
        pass('dedup-tracker promotes the Status cell (not a fixed index) on a Location-column tracker');
      } else {
        fail(`dedup-tracker mis-handled a Location-column row: "${keeper}"`);
      }
    }
  } finally {
    rmSync(locTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup-tracker Location-column test crashed: ${e.message}`);
}

// ── MERGE-TRACKER FUZZY DEDUP (#751 / #721 family) ──────────────
// roleFuzzyMatch over-matched whenever the token overlap dominated the
// SMALLER side: two distinct roles sharing a long prefix ("Full-Stack
// Engineer 5, AI Insights & Visualizations" vs "Full Stack Engineer 5, Ads
// Reporting") or a brand token (#751: "UberEats Feed" vs "Consumer
// Fulfillment (UberEats)") collapsed onto one tracker row — silently
// dropping evaluations. The ratio now divides by the token UNION (true
// Jaccard): genuine reposts (identical token sets) still score 1.0, while
// distinct specialties fall below the 0.6 threshold.
console.log('\n🧪 Testing merge-tracker fuzzy dedup (distinct roles vs reposts)...');
try {
  const mergeTmp = mkdtempSync(join(tmpdir(), 'frontrunner-merge-'));
  try {
    mkdirSync(join(mergeTmp, 'data'));
    mkdirSync(join(mergeTmp, 'reports'));
    const additionsDir = join(mergeTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(mergeTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | StreamCo | Full Stack Engineer 5, Ads Reporting | 4.4/5 | Evaluated | ❌ | [1](../reports/evaluations/001-streamco-2026-01-04.md) | existing |\n' +
      '| 2 | 2026-01-04 | Uber | Senior Software Engineer, Consumer Fulfillment (UberEats) | 4.2/5 | Evaluated | ❌ | [2](../reports/evaluations/002-uber-2026-01-04.md) | existing |\n');
    for (const n of ['001-streamco-2026-01-04', '002-uber-2026-01-04', '003-streamco-2026-01-05', '004-uber-2026-01-05', '005-streamco-2026-01-06']) {
      writeFileSync(join(mergeTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Two DISTINCT roles (long shared prefix / shared brand token) + one true repost (score bump).
    writeFileSync(join(additionsDir, '003-streamco.tsv'),
      '3\t2026-01-05\tStreamCo\tFull-Stack Engineer 5, AI Insights & Visualizations\tEvaluated\t4.6/5\t❌\t[3](workspace/reports/evaluations/003-streamco-2026-01-05.md)\tdistinct role\n');
    writeFileSync(join(additionsDir, '004-uber.tsv'),
      '4\t2026-01-05\tUber\tSenior Software Engineer, UberEats Feed\tEvaluated\t4.1/5\t❌\t[4](workspace/reports/evaluations/004-uber-2026-01-05.md)\tdistinct team (#751)\n');
    writeFileSync(join(additionsDir, '005-streamco.tsv'),
      '5\t2026-01-06\tStreamCo\tFull Stack Engineer 5, Ads Reporting\tEvaluated\t4.5/5\t❌\t[5](workspace/reports/evaluations/005-streamco-2026-01-06.md)\trepost\n');

    const mergeResult = run(NODE, ['src/tracker/merge-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker, FRONTRUNNER_ADDITIONS: additionsDir } });
    if (mergeResult === null) {
      fail('src/tracker/merge-tracker.mjs crashed during fuzzy dedup regression test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');

      // Distinct role sharing a long prefix must be ADDED, not folded into the existing row.
      if (merged.includes('AI Insights & Visualizations') && merged.includes('Ads Reporting')) {
        pass('distinct roles with shared prefix kept as separate rows');
      } else {
        fail('distinct role with shared prefix was merged away (silent data loss)');
      }

      // #751 repro: different teams under one brand token must both survive.
      if (merged.includes('UberEats Feed') && merged.includes('Consumer Fulfillment')) {
        pass('brand-token roles (#751: UberEats Feed vs Consumer Fulfillment) kept separate');
      } else {
        fail('brand-token roles were deduped (#751 regression)');
      }

      // True repost (identical role tokens) must still UPDATE in place — exactly one row, score bumped.
      const adsRows = merged.split('\n').filter(l => l.includes('Ads Reporting'));
      if (adsRows.length === 1 && adsRows[0].includes('4.5/5')) {
        pass('true repost still updates the existing row in place (4.4 → 4.5, no duplicate)');
      } else {
        fail(`repost handling broken: ${adsRows.length} 'Ads Reporting' rows, expected 1 updated to 4.5/5`);
      }
    }
  } finally {
    rmSync(mergeTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker fuzzy dedup tests crashed: ${e.message}`);
}

// merge-tracker used to clobber an Applied row when a sibling req's only
// distinguishing qualifier was a slashed acronym: "(CI/CD)" tokenized to
// nothing, the fuzzy tier matched, and the update path rewrote the existing
// row's title/score/date/report. Two guards now cover it: slashed acronyms
// survive tokenization, and non-report-number matches never rewrite the title.
console.log('\n🧪 Testing merge-tracker sibling-req clobber guard (slash acronyms + title preservation)...');
try {
  const clobberTmp = mkdtempSync(join(tmpdir(), 'frontrunner-clobber-'));
  try {
    mkdirSync(join(clobberTmp, 'data'));
    mkdirSync(join(clobberTmp, 'reports'));
    const additionsDir = join(clobberTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(clobberTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-05 | Globex | Senior Software Engineer, Infrastructure | N/A | Applied | ❌ | - | source=applied |\n' +
      '| 2 | 2026-01-08 | Acme | Senior Platform Engineer, Observability | 3.9/5 | Applied | ❌ | [2](../reports/evaluations/002-acme-2026-01-08.md) | existing |\n');
    for (const n of ['002-acme-2026-01-08', '003-globex-2026-01-09', '004-acme-2026-01-09']) {
      writeFileSync(join(clobberTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Sibling req whose only qualifier is a slashed acronym → must be ADDED.
    writeFileSync(join(additionsDir, '003-globex.tsv'),
      '3\t2026-01-09\tGlobex\tSenior Software Engineer, Infrastructure (CI/CD)\tEvaluated\t4.5/5\t✅\t[3](workspace/reports/evaluations/003-globex-2026-01-09.md)\tdistinct req\n');
    // True repost with reworded title → fuzzy update keeps the EXISTING title.
    writeFileSync(join(additionsDir, '004-acme.tsv'),
      '4\t2026-01-09\tAcme\tSr Platform Engineer, Observability (Remote)\tEvaluated\t4.2/5\t❌\t[4](workspace/reports/evaluations/004-acme-2026-01-09.md)\trepost re-eval\n');

    const clobberResult = run(NODE, ['src/tracker/merge-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker, FRONTRUNNER_ADDITIONS: additionsDir } });
    if (clobberResult === null) {
      fail('merge-tracker.mjs crashed during sibling-req clobber guard test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');

      if (merged.includes('Senior Software Engineer, Infrastructure |') && merged.includes('Infrastructure (CI/CD)')) {
        pass('slash-acronym sibling req added as its own row; Applied row untouched');
      } else {
        fail('slash-acronym sibling req clobbered the existing Applied row (regression)');
      }

      const acmeRows = merged.split('\n').filter(l => l.includes('Observability'));
      if (acmeRows.length === 1 && acmeRows[0].includes('Senior Platform Engineer, Observability') && acmeRows[0].includes('4.2/5')) {
        pass('fuzzy-tier update bumps score but preserves the existing role title');
      } else {
        fail(`fuzzy-tier title preservation broken: ${acmeRows.length} Observability rows: ${acmeRows.join(' // ')}`);
      }
    }
  } finally {
    rmSync(clobberTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker sibling-req clobber guard tests crashed: ${e.message}`);
}

// Tier-2 (entry num + company): pins the TITLE FIELD ONLY (#2166 review).
//
// The title-preservation guard keys on reportNumMatched, which only tier-1
// (report number + company) sets — so tier-2 preserves the existing title too.
// That is intentional: tier-2 fires only AFTER tier-1 failed, i.e. the addition
// carries a report link that did NOT match the row's while the bare num did.
// Report-file numbering and tracker-row numbering drift independently, so a
// tier-2 hit is "these two numbers coincide at this company" — a coincidence,
// not an expressed intent to retitle. Since date/score/report/notes are all
// overwritten unconditionally on the update path, the title is the only field
// left carrying the evidence that two reqs were distinct. This test exists so a
// future refactor cannot flip that behavior silently.
//
// SCOPE — read before extending this test. The fixture below is a deliberately
// pathological isolation case, and the row it produces is internally
// inconsistent: the preserved title describes one req while the overwritten
// report link points at another req's evaluation. That inconsistency is
// PRE-EXISTING tier-2 behavior, not something this change introduces — before
// the guard, the same collision overwrote the title as well, which loses
// strictly more information (the tracker no longer records that the original
// req was ever applied to). This test therefore asserts ONLY that the title
// survives; it does NOT endorse the rest of the merged row as correct. The
// underlying question — whether an uncorroborated num+company collision should
// update in place at all, versus adding the row or surfacing a conflict — is a
// tier-2 redesign, deliberately out of scope for this #2165 bugfix.
console.log('\n🧪 Testing merge-tracker tier-2 (entry num) title preservation...');
try {
  const { roleFuzzyMatch } = await import(pathToFileURL(join(ROOT, 'src/tracker/role-matcher.mjs')).href);
  const tier2Tmp = mkdtempSync(join(tmpdir(), 'frontrunner-tier2-'));
  try {
    mkdirSync(join(tier2Tmp, 'data'));
    mkdirSync(join(tier2Tmp, 'reports'));
    const additionsDir = join(tier2Tmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(tier2Tmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 7 | 2026-02-01 | Initech | Staff Data Engineer, Batch Pipelines | 3.6/5 | Applied | ❌ | [21](../reports/evaluations/021-initech-2026-02-01.md) | existing |\n');
    for (const n of ['021-initech-2026-02-01', '022-initech-2026-02-02']) {
      writeFileSync(join(tier2Tmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // num 7 collides with the existing row at the same company, but the report
    // link (22) does not match the row's (21) — so tier-1 misses and tier-2 is
    // the only tier that can match: the roles are far too different to fuzzy
    // match, which is what isolates tier-2 here.
    writeFileSync(join(additionsDir, '007-initech.tsv'),
      '7\t2026-02-02\tInitech\tTechnical Program Manager, Compliance\tEvaluated\t4.4/5\t❌\t[22](workspace/reports/evaluations/022-initech-2026-02-02.md)\tnum collision, distinct role\n');

    // The isolation above is load-bearing: if these two titles ever DID fuzzy
    // match, tier-3 could satisfy the assertions below and this would silently
    // stop testing tier-2. Assert the premise rather than assuming it.
    if (!roleFuzzyMatch('Staff Data Engineer, Batch Pipelines', 'Technical Program Manager, Compliance')) {
      pass('tier-2 fixture roles do not fuzzy-match, so tier-2 is the only tier that can fire');
    } else {
      fail('tier-2 fixture roles now fuzzy-match — this test no longer isolates tier-2');
    }

    const tier2Result = run(NODE, ['src/tracker/merge-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker, FRONTRUNNER_ADDITIONS: additionsDir } });
    if (tier2Result === null) {
      fail('merge-tracker.mjs crashed during tier-2 title preservation test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');
      const initechRows = merged.split('\n').filter(l => l.includes('Initech'));

      // Characterization only — this pins that the update path RAN (one row,
      // not two, and the score moved), which is what makes the title assertion
      // below non-vacuous. It is not a claim that in-place update is the right
      // outcome for an uncorroborated tier-2 collision; see SCOPE above.
      if (initechRows.length === 1 && initechRows[0].includes('4.4/5')) {
        pass('tier-2 collision takes the in-place update path (pre-existing behavior)');
      } else {
        fail(`tier-2 match/update broken: ${initechRows.length} Initech rows: ${initechRows.join(' // ')}`);
      }

      if (initechRows.length === 1
          && initechRows[0].includes('Staff Data Engineer, Batch Pipelines')
          && !initechRows[0].includes('Technical Program Manager')) {
        pass('tier-2 update preserves the existing role title (only tier-1 may retitle)');
      } else {
        fail(`tier-2 title preservation broken: ${initechRows.join(' // ')}`);
      }
    }
  } finally {
    rmSync(tier2Tmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker tier-2 title preservation tests crashed: ${e.message}`);
}

// ── MERGE-TRACKER CROSS-CHANNEL VIA GUARD: NON-LATIN AGENCIES (#1603) ─────
// normalizeCompany() strips [^a-z0-9], so two different non-Latin agency
// names both collapse to '' and the #1596 cross-channel guard treated them
// as the same channel — silently merging two real submissions. The via
// comparison must use a Unicode-aware key.
console.log('\n🧪 Testing merge-tracker via guard with non-Latin agencies (#1603)...');
try {
  const viaTmp = mkdtempSync(join(tmpdir(), 'frontrunner-via-'));
  try {
    mkdirSync(join(viaTmp, 'data'));
    mkdirSync(join(viaTmp, 'reports'));
    const additionsDir = join(viaTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(viaTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|-----|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | ? | リクルート | Backend Engineer, Payments Platform | 4.0/5 | Evaluated | ❌ | [1](../reports/evaluations/001-unknown-2026-01-04.md) | agency listing |\n');
    for (const n of ['001-unknown-2026-01-04', '002-unknown-2026-01-05', '003-unknown-2026-01-06']) {
      writeFileSync(join(viaTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Same role, unknown employer, DIFFERENT non-Latin agency → a real second
    // submission that must be ADDED as its own row. (Role carries a
    // discriminating token — roleFuzzyMatch rejects baseline-only titles.)
    writeFileSync(join(additionsDir, '002-unknown.tsv'),
      '2\t2026-01-05\t?\tBackend Engineer, Payments Platform\tEvaluated\t4.1/5\t❌\t[2](workspace/reports/evaluations/002-unknown-2026-01-05.md)\tsecond agency\tvia=パーソル\n');
    // Same role, SAME agency re-blasting the listing → duplicate, update in place.
    writeFileSync(join(additionsDir, '003-unknown.tsv'),
      '3\t2026-01-06\t?\tBackend Engineer, Payments Platform\tEvaluated\t4.2/5\t❌\t[3](workspace/reports/evaluations/003-unknown-2026-01-06.md)\tre-blast\tvia=リクルート\n');

    const viaResult = run(NODE, ['src/tracker/merge-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker, FRONTRUNNER_ADDITIONS: additionsDir } });
    if (viaResult === null) {
      fail('src/tracker/merge-tracker.mjs crashed during non-Latin via guard test (#1603)');
    } else {
      const merged = readFileSync(tracker, 'utf-8');
      if (merged.includes('パーソル') && merged.includes('リクルート')) {
        pass('distinct non-Latin agencies kept as separate rows (#1603)');
      } else {
        fail('distinct non-Latin agencies were merged — via key collapsed to the same empty string (#1603)');
      }
      const recruitRows = merged.split('\n').filter(l => l.includes('リクルート'));
      if (recruitRows.length === 1 && recruitRows[0].includes('4.2/5')) {
        pass('same-agency re-blast still updates the existing row in place (#1603)');
      } else {
        fail(`same-agency re-blast handling broken: ${recruitRows.length} リクルート rows, expected 1 updated to 4.2/5`);
      }
    }
  } finally {
    rmSync(viaTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`non-Latin via guard tests crashed: ${e.message}`);
}

// ── MERGE-TRACKER TSV COLUMN-ORDER TOLERANCE (#1427) ─────────────
// Batch TSVs write (status, score); applications.md is (score, status). A
// generator that swaps the two must not merge silently — the score column is
// identified by content pattern, and an undecidable pair is skipped loudly.
console.log('\n🧪 Testing merge-tracker TSV column-order tolerance (#1427)...');
try {
  const { resolveScoreStatus, looksLikeScoreCell } = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker-parse.mjs')).href);

  // Unit: content-pattern discriminator
  if (looksLikeScoreCell('4.2/5') && looksLikeScoreCell('5/5') && looksLikeScoreCell('N/A') && looksLikeScoreCell('DUP') && looksLikeScoreCell('**3.5/5**')) {
    pass('looksLikeScoreCell accepts score cells (incl. N/A, DUP, bolded)');
  } else {
    fail('looksLikeScoreCell rejected a valid score cell');
  }
  if (!looksLikeScoreCell('Evaluated') && !looksLikeScoreCell('Applied') && !looksLikeScoreCell('')) {
    pass('looksLikeScoreCell rejects status labels and blanks');
  } else {
    fail('looksLikeScoreCell matched a non-score cell');
  }

  const std = resolveScoreStatus('Evaluated', '4.2/5');
  const swp = resolveScoreStatus('4.2/5', 'Evaluated');
  if (std && std.score === '4.2/5' && std.status === 'Evaluated' &&
      swp && swp.score === '4.2/5' && swp.status === 'Evaluated') {
    pass('resolveScoreStatus maps both column orders to the same result');
  } else {
    fail(`resolveScoreStatus order handling: std=${JSON.stringify(std)} swp=${JSON.stringify(swp)}`);
  }
  if (resolveScoreStatus('Evaluated', 'Applied') === null && resolveScoreStatus('4.2/5', '5/5') === null) {
    pass('resolveScoreStatus returns null when neither or both cells look like a score');
  } else {
    fail('resolveScoreStatus should be undecidable for two statuses or two scores');
  }

  // #1799: em dash / hyphen recognized as score-cell sentinels, matching the
  // tracker's own "no data" convention used in every other column, alongside
  // the pre-existing N/A / DUP sentinels — for backfilled no-score entries
  // (e.g. a rejection email for a role never run through an evaluation).
  if (looksLikeScoreCell('—') && looksLikeScoreCell('-')) {
    pass('looksLikeScoreCell accepts em-dash and hyphen sentinels (#1799)');
  } else {
    fail('looksLikeScoreCell rejected the em-dash/hyphen sentinels');
  }
  const backfilled = resolveScoreStatus('—', 'Rejected');
  const backfilledSwapped = resolveScoreStatus('Rejected', '—');
  if (backfilled && backfilled.score === '—' && backfilled.status === 'Rejected' &&
      backfilledSwapped && backfilledSwapped.score === '—' && backfilledSwapped.status === 'Rejected') {
    pass('resolveScoreStatus resolves a backfilled em-dash score against a status in either order (#1799)');
  } else {
    fail(`resolveScoreStatus backfilled em-dash handling: std=${JSON.stringify(backfilled)} swp=${JSON.stringify(backfilledSwapped)}`);
  }
  // The #1427 guard must still refuse truly ambiguous rows: two sentinel-like
  // cells give no way to tell score from status.
  if (resolveScoreStatus('—', '-') === null && resolveScoreStatus('—', 'N/A') === null) {
    pass('resolveScoreStatus still refuses two sentinel-like cells as ambiguous (#1427 guard intact)');
  } else {
    fail('resolveScoreStatus should stay undecidable for two sentinel-like cells');
  }

  // End-to-end: a swapped-column TSV merges correctly; an undecidable one is skipped.
  const colTmp = mkdtempSync(join(tmpdir(), 'frontrunner-colorder-'));
  try {
    mkdirSync(join(colTmp, 'data'));
    mkdirSync(join(colTmp, 'reports'));
    const additionsDir = join(colTmp, 'additions');
    mkdirSync(additionsDir);
    const tracker = join(colTmp, 'data', 'applications.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-04 | AnchorCo | Platform Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/evaluations/001-anchorco-2026-01-04.md) | existing |\n');
    for (const n of ['001-anchorco-2026-01-04', '002-swapco-2026-01-05', '003-ambigco-2026-01-05', '004-boldco-2026-01-05']) {
      writeFileSync(join(colTmp, 'reports', `${n}.md`), '# fixture\n');
    }
    // Swapped order: score BEFORE status (4.6/5 then Evaluated).
    writeFileSync(join(additionsDir, '002-swapco.tsv'),
      '2\t2026-01-05\tSwapCo\tData Engineer\t4.6/5\tEvaluated\t❌\t[2](workspace/reports/evaluations/002-swapco-2026-01-05.md)\tswapped cols\n');
    // Undecidable: two status-like cells, no score → must be skipped, not merged.
    writeFileSync(join(additionsDir, '003-ambigco.tsv'),
      '3\t2026-01-05\tAmbigCo\tAnalyst\tEvaluated\tApplied\t❌\t[3](workspace/reports/evaluations/003-ambigco-2026-01-05.md)\tno score\n');
    // Bold score cell → detected AND persisted write-canonical (unbolded).
    writeFileSync(join(additionsDir, '004-boldco.tsv'),
      '4\t2026-01-05\tBoldCo\tSRE\tEvaluated\t**4.7/5**\t❌\t[4](workspace/reports/evaluations/004-boldco-2026-01-05.md)\tbold score\n');

    const mergeResult = run(NODE, ['src/tracker/merge-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: tracker, FRONTRUNNER_ADDITIONS: additionsDir } });
    if (mergeResult === null) {
      fail('src/tracker/merge-tracker.mjs crashed during column-order test');
    } else {
      const merged = readFileSync(tracker, 'utf-8');
      const swapRow = merged.split('\n').find(l => l.includes('SwapCo')) || '';
      // buildRow writes `| … | score | status | … |`, so the score must land in the
      // score column and status in the status column despite the swapped input.
      if (swapRow.includes('| 4.6/5 | Evaluated |')) {
        pass('swapped-column TSV merges with score and status in the correct columns');
      } else {
        fail(`swapped TSV mis-merged: "${swapRow.trim()}"`);
      }
      if (!merged.includes('AmbigCo')) {
        pass('undecidable score/status row is skipped, not merged (no silent swap)');
      } else {
        fail('undecidable row was merged instead of skipped');
      }
      const boldRow = merged.split('\n').find(l => l.includes('BoldCo')) || '';
      if (boldRow.includes('| 4.7/5 | Evaluated |') && !boldRow.includes('**')) {
        pass('bold score cell is persisted write-canonical (unbolded) in the merged row');
      } else {
        fail(`bold score not canonicalized on write: "${boldRow.trim()}"`);
      }
    }
  } finally {
    rmSync(colTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker column-order tests crashed: ${e.message}`);
}

// ── MERGE-TRACKER PDF FLAG SYNC (#1429) ─────────────────────────
// src\/cv\/generate-pdf.mjs can run after the tracker row already exists. The
// gitignored workspace/.state/pdf-index.tsv manifest is the source of truth that the row's
// PDF was generated, so merge-tracker should flip only matching ❌ cells to ✅.
console.log('\n🧪 Testing merge-tracker PDF flag sync from workspace/.state/pdf-index.tsv (#1429)...');
try {
  const runPdfSyncFixture = (name, trackerRow, pdfIndex = null, additions = []) => {
    const tmp = mkdtempSync(join(tmpdir(), `frontrunner-merge-pdf-${name}-`));
    mkdirSync(join(tmp, 'workspace', 'applications'), { recursive: true });
    mkdirSync(join(tmp, 'workspace', '.state'), { recursive: true });
    const additionsDir = join(tmp, 'additions');
    const tracker = join(tmp, 'workspace', 'applications', 'tracker.md');
    writeFileSync(tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      trackerRow + '\n');
    if (pdfIndex !== null) writeFileSync(join(tmp, 'workspace', '.state', 'pdf-index.tsv'), pdfIndex);
    if (additions.length > 0) {
      mkdirSync(additionsDir, { recursive: true });
      for (const addition of additions) {
        writeFileSync(join(additionsDir, addition.name), addition.content);
      }
    }

    try {
    const result = run(NODE, ['src/tracker/merge-tracker.mjs'], {
      env: { ...process.env, FRONTRUNNER_TRACKER: tracker, FRONTRUNNER_ADDITIONS: additionsDir },
    });
    const merged = readFileSync(tracker, 'utf-8');
    return { result, merged };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  const matching = runPdfSyncFixture(
    'match',
    '| 7 | 2026-01-04 | Acme | Engineer | 4.2/5 | Evaluated | ❌ | [12](../reports/evaluations/012-acme-2026-01-04.md) | ok |',
    '# report\tpdf\thtml\tformat\tdate\n' +
      '012\toutput/cv-acme.pdf\toutput/cv-acme.html\tletter\t2026-01-04\n',
  );
  if (matching.result !== null && matching.merged.includes('| ✅ | [12](../reports/evaluations/012-acme-2026-01-04.md) |')) {
    pass('merge-tracker flips a stale ❌ PDF cell when pdf-index.tsv has the row report number');
  } else {
    fail('merge-tracker did not flip the matching PDF cell from ❌ to ✅');
  }

  const nonMatching = runPdfSyncFixture(
    'miss',
    '| 8 | 2026-01-05 | Globex | Analyst | 3.8/5 | Evaluated | ❌ | [22](../reports/evaluations/022-globex-2026-01-05.md) | ok |',
    '# report\tpdf\thtml\tformat\tdate\n' +
      '023\toutput/cv-other.pdf\toutput/cv-other.html\tletter\t2026-01-05\n',
  );
  if (nonMatching.result !== null && nonMatching.merged.includes('| ❌ | [22](../reports/evaluations/022-globex-2026-01-05.md) |')) {
    pass('merge-tracker leaves PDF ❌ when the report number is absent from pdf-index.tsv');
  } else {
    fail('merge-tracker produced a false-positive PDF sync for a missing report number');
  }

  const missingManifest = runPdfSyncFixture(
    'missing',
    '| 9 | 2026-01-06 | Initech | Manager | 3.9/5 | Evaluated | ❌ | [31](../reports/evaluations/031-initech-2026-01-06.md) | ok |',
  );
  if (missingManifest.result !== null && missingManifest.merged.includes('| ❌ | [31](../reports/evaluations/031-initech-2026-01-06.md) |')) {
    pass('merge-tracker runs successfully when workspace/.state/pdf-index.tsv does not exist');
  } else {
    fail('merge-tracker crashed or changed the PDF cell when pdf-index.tsv was missing');
  }

  const newAddition = runPdfSyncFixture(
    'new-addition',
    '',
    '# report\tpdf\thtml\tformat\tdate\n' +
      '041\toutput/cv-umbrella.pdf\toutput/cv-umbrella.html\tletter\t2026-01-07\n',
    [{
      name: '001-umbrella.tsv',
      content: '1\t2026-01-07\tUmbrella\tEngineer\t4.1/5\tEvaluated\t❌\t[41](../reports/evaluations/041-umbrella-2026-01-07.md)\tok\n',
    }],
  );
  if (newAddition.result !== null && newAddition.merged.includes('| 1 | 2026-01-07 | Umbrella | Engineer | 4.1/5 | Evaluated | ✅ | [41](../reports/evaluations/041-umbrella-2026-01-07.md) | ok |')) {
    pass('merge-tracker applies pdf-index.tsv to a newly merged tracker row in the same run');
  } else {
    fail('merge-tracker left a newly merged row at ❌ despite a matching pdf-index.tsv entry');
  }
} catch (e) {
  fail(`merge-tracker PDF flag sync test crashed: ${e.message}`);
}

// ── MERGE-TRACKER REPORT-NUMBER COLLISION (#912) ─────────────────
// The report-number dedup check was not company-guarded: a TSV for NewCo
// with report [1] would find the existing tracker row [1] for OtherCo and
// update it in-place instead of appending NewCo as a new row.
console.log('\n🧪 Testing merge-tracker report-number cross-company collision (#912)...');
try {
  const col912Tmp = mkdtempSync(join(tmpdir(), 'frontrunner-merge-912-'));
  try {
    mkdirSync(join(col912Tmp, 'workspace', 'applications'), { recursive: true });
    mkdirSync(join(col912Tmp, 'workspace', 'reports', 'evaluations'), { recursive: true });
    const col912Additions = join(col912Tmp, 'additions');
    mkdirSync(col912Additions);

    const col912Tracker = join(col912Tmp, 'workspace', 'applications', 'tracker.md');
    writeFileSync(col912Tracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-01 | OtherCo | Staff Engineer | 4.0/5 | Evaluated | ❌ | [1](../reports/evaluations/001-otherco-2026-01-01.md) | original |\n');
    writeFileSync(join(col912Tmp, 'workspace', 'reports', 'evaluations', '001-otherco-2026-01-01.md'), '# fixture\n');
    writeFileSync(join(col912Tmp, 'workspace', 'reports', 'evaluations', '001-newco-2026-01-05.md'), '# fixture\n');

    // NewCo TSV also carries report number [1] — cross-company collision
    writeFileSync(join(col912Additions, '001-newco.tsv'),
      '1\t2026-01-05\tNewCo\tNew Role\tEvaluated\t2.7/5\t❌\t[1](workspace/reports/evaluations/001-newco-2026-01-05.md)\tcollision\n');

    const col912Result = run(NODE, ['src/tracker/merge-tracker.mjs'], {
      env: { ...process.env, FRONTRUNNER_TRACKER: col912Tracker, FRONTRUNNER_ADDITIONS: col912Additions },
    });
    if (col912Result === null) {
      fail('merge-tracker crashed during report-number collision test (#912)');
    } else {
      const col912Merged = readFileSync(col912Tracker, 'utf-8');
      const col912Rows = col912Merged.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.startsWith('|---'));
      const otherCoUnchanged = col912Rows.some((row) =>
        /^\| 1 \| 2026-01-01 \| OtherCo \| Staff Engineer \| 4\.0\/5 \| Evaluated \| [❌✅] \| \[1\]\(\.\.\/reports\/evaluations\/001-otherco-2026-01-01\.md\) \| original \|$/.test(row.trim())
      );

      if (col912Rows.length === 2) {
        pass('report-number collision (#912): merged tracker has exactly 2 rows');
      } else {
        fail(`report-number collision (#912): expected 2 rows, got ${col912Rows.length}`);
      }

      if (otherCoUnchanged) {
        pass('report-number collision (#912): existing OtherCo identity/content left untouched');
      } else {
        fail('report-number collision (#912): OtherCo row was overwritten by NewCo addition');
      }

      const newCoAppended = col912Rows.some((row) =>
        /^\| 2 \| 2026-01-05 \| NewCo \| New Role \| 2\.7\/5 \| Evaluated \| [❌✅] \| \[1\]\(\.\.\/reports\/evaluations\/001-newco-2026-01-05\.md\) \| collision \|$/.test(row.trim())
      );
      if (newCoAppended) {
        pass('report-number collision (#912): NewCo appended as a new entry with correct data');
      } else {
        fail('report-number collision (#912): NewCo entry was swallowed or has incorrect data');
      }
    }
  } finally {
    rmSync(col912Tmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker report-number collision test crashed: ${e.message}`);
}

// ── MERGE-TRACKER STALE-NUMBER COLLISION WITH AN EXISTING ROW (#1704) ────
// Different from the #912 test above: that one is a same-run collision where
// the incoming TSV's num equals an EXISTING row's num (addition.num <= maxNum,
// already handled by the old ++maxNum fallback). This one exercises the actual
// #1704 gap: an existing row's number is invisible to the plain maxNum scan
// (merge-tracker's own header/separator-skip heuristic excludes any row whose
// company/role text happens to contain "Empresa" or "---" — a real Spanish-
// market company name is a realistic trigger), so the naive
// `addition.num > maxNum` check trusted a colliding number as free. The fix
// builds a Set of every number actually on the tracker (independent of that
// heuristic) and refuses to trust a number already in it.
console.log('\n🧪 Testing merge-tracker stale-number collision with a hidden existing row (#1704)...');
try {
  const staleNumTmp = mkdtempSync(join(tmpdir(), 'frontrunner-merge-1704-'));
  try {
    mkdirSync(join(staleNumTmp, 'data'));
    const staleNumAdditions = join(staleNumTmp, 'additions');
    mkdirSync(staleNumAdditions);

    const staleNumTracker = join(staleNumTmp, 'data', 'applications.md');
    // Row #9's company text contains "Empresa" — merge-tracker's existingApps
    // loop skips this line entirely (the same heuristic it uses to skip the
    // Spanish-locale header row), so its number is NOT counted toward the old
    // plain maxNum scan.
    writeFileSync(staleNumTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 9 | 2026-01-02 | Empresa Digital SA | Analyst | 3.5/5 | Evaluated | ❌ | — | original |\n');

    // Stale TSV for an unrelated company also embeds num=9 — numerically
    // "ahead" of the naive maxNum(0) computed from the hidden row, but already
    // used.
    writeFileSync(join(staleNumAdditions, '001-newco.tsv'),
      '9\t2026-01-10\tNewCo\tFresh Role\tEvaluated\t2.9/5\t❌\t—\tstale number\n');

    const staleNumResult = run(NODE, ['src/tracker/merge-tracker.mjs'], {
      env: { ...process.env, FRONTRUNNER_TRACKER: staleNumTracker, FRONTRUNNER_ADDITIONS: staleNumAdditions },
    });
    if (staleNumResult === null) {
      fail('merge-tracker crashed during stale-number collision test (#1704)');
    } else {
      const staleNumMerged = readFileSync(staleNumTracker, 'utf-8');
      const staleNumRows = staleNumMerged.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.startsWith('|---'));

      if (staleNumRows.length === 2) {
        pass('stale-number collision (#1704): merged tracker has exactly 2 rows');
      } else {
        fail(`stale-number collision (#1704): expected 2 rows, got ${staleNumRows.length}`);
      }

      const numsUsed = staleNumRows.map(r => parseInt(r.split('|')[1].trim(), 10));
      if (new Set(numsUsed).size === numsUsed.length) {
        pass('stale-number collision (#1704): no two rows share a tracker number');
      } else {
        fail(`stale-number collision (#1704): duplicate tracker number produced — ${numsUsed.join(', ')}`);
      }

      if (staleNumRows.some(r => r.includes('Empresa Digital SA') && /^\| 9 \|/.test(r))) {
        pass('stale-number collision (#1704): hidden existing row #9 (Empresa Digital SA) untouched');
      } else {
        fail(`stale-number collision (#1704): existing #9 row was overwritten\n${staleNumMerged}`);
      }

      if (staleNumRows.some(r => r.includes('NewCo') && !/^\| 9 \|/.test(r))) {
        pass('stale-number collision (#1704): NewCo bumped to a truly free number instead of reusing #9');
      } else {
        fail(`stale-number collision (#1704): NewCo was not bumped off the colliding number\n${staleNumMerged}`);
      }
    }
  } finally {
    rmSync(staleNumTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker stale-number collision test crashed: ${e.message}`);
}

// ── MERGE-TRACKER RESERVED-NUMBER FIDELITY (#1733) ──────────────
// Parallel workers may reserve numbers in order but finish out of order. A
// free reserved number remains valid even when a later number has already
// reached the tracker; merge-tracker must preserve it, and only renumber on a
// real collision (with a visible warning).
console.log('\n🧪 Testing merge-tracker reserved-number fidelity (#1733)...');
try {
  const reservedTmp = mkdtempSync(join(tmpdir(), 'frontrunner-merge-reserved-'));
  try {
    mkdirSync(join(reservedTmp, 'data'));
    const reservedAdditions = join(reservedTmp, 'additions');
    mkdirSync(reservedAdditions);
    const reservedTracker = join(reservedTmp, 'data', 'applications.md');
    writeFileSync(reservedTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 10 | 2026-01-10 | LaterCo | Engineer | 4.0/5 | Evaluated | ❌ | — | finished first |\n');

    writeFileSync(join(reservedAdditions, '005-early.tsv'),
      '5\t2026-01-05\tEarlyCo\tEngineer\tEvaluated\t4.1/5\t❌\t[5](workspace/reports/evaluations/005-early-2026-01-05.md)\treserved first\n');
    const preserveResult = run(NODE, ['src/tracker/merge-tracker.mjs'], {
      env: { ...process.env, FRONTRUNNER_TRACKER: reservedTracker, FRONTRUNNER_ADDITIONS: reservedAdditions },
    });
    const afterPreserve = readFileSync(reservedTracker, 'utf-8');
    if (preserveResult !== null && /^\| 5 \|[^\n]*\| EarlyCo \|/m.test(afterPreserve)) {
      pass('merge-tracker preserves a free reserved ID below the current maximum');
    } else {
      fail(`merge-tracker renumbered a free reserved ID\n${afterPreserve}`);
    }

    writeFileSync(join(reservedAdditions, '005-collision.tsv'),
      '5\t2026-01-11\tCollisionCo\tAnalyst\tEvaluated\t3.8/5\t❌\t—\tstale reservation\n');
    const collisionResult = spawnSync(NODE, [join(ROOT, 'src/tracker/merge-tracker.mjs')], {
      cwd: ROOT,
      encoding: 'utf-8',
      env: { ...process.env, FRONTRUNNER_TRACKER: reservedTracker, FRONTRUNNER_ADDITIONS: reservedAdditions },
    });
    const afterCollision = readFileSync(reservedTracker, 'utf-8');
    const collisionOutput = `${collisionResult.stdout || ''}\n${collisionResult.stderr || ''}`;
    if (collisionResult.status === 0
        && /^\| 11 \|[^\n]*\| CollisionCo \|/m.test(afterCollision)
        && /#5[^\n]*(?:already|collision)[^\n]*#11/i.test(collisionOutput)) {
      pass('merge-tracker renumbers only a real collision and warns with both IDs');
    } else {
      fail(`merge-tracker collision fallback was not loud and deterministic\n${collisionOutput}\n${afterCollision}`);
    }
  } finally {
    rmSync(reservedTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker reserved-number fidelity test crashed: ${e.message}`);
}

// ── DEDUP BLINDNESS FROM `---` / "Empresa" IN A DATA ROW (#2265) ─────────
// Readers recognized the markdown separator row with `line.includes('---')`,
// which also matched any DATA row whose free text contained three hyphens — a
// URL slug like `Senior-Engineer---Platform-Team`, an em dash typed as
// `---` — or, via the sibling `.includes('Empresa')` guard, a Spanish-market
// company name. Such a row never reached `existingApps`, so it was invisible to
// duplicate detection: re-evaluating that exact role appended a second row
// instead of updating the first in place.
//
// #1704 fixed the NUMBERING half of this (the separate usedNumbers pass, so the
// hidden row's number is never reissued) and deliberately left `existingApps`
// alone. This covers the dedup half, and pins the row-format check that shares
// the same heuristic.
console.log('\n🧪 Testing dedup blindness from `---` / "Empresa" in a data row...');
try {
  const hyphenTmp = mkdtempSync(join(tmpdir(), 'frontrunner-dedup-hyphen-'));
  try {
    const hData = join(hyphenTmp, 'data');
    const hReports = join(hyphenTmp, 'reports');
    const hAdditions = join(hyphenTmp, 'additions');
    mkdirSync(hData);
    mkdirSync(hReports);
    mkdirSync(hAdditions);

    const hTracker = join(hData, 'applications.md');
    const hHeader =
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n';
    // Row #2 hides behind `---` (URL slug); row #1 hides behind "Empresa"
    // (a Spanish company name). Both must be visible to dedup.
    const hRows =
      '| 2 | 2026-01-05 | Acme Corp | Director, Data Platform | 4.3/5 | Evaluated | ❌ | ' +
      '[2](../reports/evaluations/002-acme-corp-2026-01-05.md) | URL slug says Senior-Engineer---Platform-Team. |\n' +
      '| 1 | 2026-01-05 | Empresa Ejemplo | Data Lead | 3.9/5 | Evaluated | ❌ | ' +
      '[1](../reports/evaluations/001-empresa-ejemplo-2026-01-05.md) | Madrid hybrid. |\n';
    writeFileSync(hTracker, hHeader + hRows);
    for (const r of ['002-acme-corp-2026-01-05.md', '001-empresa-ejemplo-2026-01-05.md']) {
      writeFileSync(join(hReports, r), '# fixture\n');
    }

    // Re-evaluation of BOTH existing roles at a higher score. Correct behavior
    // is two in-place updates and zero new rows.
    writeFileSync(join(hAdditions, '002-acme-corp.tsv'),
      '2\t2026-01-06\tAcme Corp\tDirector, Data Platform\tEvaluated\t4.8/5\t❌\t' +
      '[2](workspace/reports/evaluations/002-acme-corp-2026-01-05.md)\tre-evaluated after JD update\n');
    writeFileSync(join(hAdditions, '001-empresa-ejemplo.tsv'),
      '1\t2026-01-06\tEmpresa Ejemplo\tData Lead\tEvaluated\t4.1/5\t❌\t' +
      '[1](workspace/reports/evaluations/001-empresa-ejemplo-2026-01-05.md)\tre-evaluated after JD update\n');

    const hOut = run(NODE, ['src/tracker/merge-tracker.mjs'], {
      env: { ...process.env, FRONTRUNNER_TRACKER: hTracker, FRONTRUNNER_ADDITIONS: hAdditions },
    });

    if (hOut === null) {
      fail('merge-tracker crashed on the `---`/"Empresa" fixture');
    } else {
      if (/Existing: 2 entries/.test(hOut)) {
        pass('rows containing `---` and "Empresa" are both visible to merge-tracker');
      } else {
        fail(`merge-tracker did not see both rows — expected "Existing: 2 entries", got: ${hOut.split('\n').find(l => l.includes('Existing:')) || '(none)'}`);
      }

      const hMerged = readFileSync(hTracker, 'utf-8');
      const hDataRows = hMerged.split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l));

      if (hDataRows.length === 2) {
        pass('re-evaluating a `---`/"Empresa" row updates in place, no duplicate row appended');
      } else {
        fail(`expected 2 rows after two in-place updates, got ${hDataRows.length}`);
      }

      if (/4\.8\/5/.test(hMerged) && /4\.1\/5/.test(hMerged)) {
        pass('both re-evaluated scores landed on the existing rows');
      } else {
        fail('re-evaluated scores did not reach the existing rows');
      }

      // The separator row must still be found, or new rows land in the wrong
      // place (or nowhere) — the structural match has to keep working.
      if (hMerged.includes('|---|------|')) {
        pass('table separator row survives the merge intact');
      } else {
        fail('table separator row was consumed or rewritten');
      }
    }

    // verify-pipeline's row-format check shares the heuristic: a malformed row
    // carrying `---` used to skip the column-count check entirely.
    const hBadRow = join(hData, 'applications-badrow.md');
    writeFileSync(hBadRow, hHeader +
      '| 3 | 2026-01-05 | Acme | Truncated Row --- with hyphens |\n' + hRows);
    let badOut = '';
    let badCode = 0;
    try {
      badOut = execFileSync(NODE, ['src/tracker/verify-pipeline.mjs'], {
        cwd: ROOT, encoding: 'utf-8', timeout: 30000,
        env: { ...process.env, FRONTRUNNER_TRACKER: hBadRow, FRONTRUNNER_REPORTS: hReports },
      });
    } catch (e) {
      badOut = String(e.stdout ?? '');
      badCode = e.status ?? -1;
    }
    if (/Row with too few columns/.test(badOut) && badCode === 1) {
      pass('verify-pipeline flags a malformed row even when it contains `---`');
    } else {
      fail(`verify-pipeline did not flag a short row containing \`---\` (exit ${badCode})`);
    }

    // Header detection must key on the whole header SCHEMA, not one telltale
    // cell: a malformed row carrying an exact `Empresa`/`Company` cell (a
    // company genuinely named that, a one-word note) must not be mistaken for
    // the header and skip the column-count check.
    const hHeaderish = join(hData, 'applications-headerish.md');
    writeFileSync(hHeaderish, hHeader +
      '| 4 | 2026-01-05 | Empresa | Short Row |\n' +
      '| 5 | 2026-01-05 | Company | Also Short |\n' + hRows);
    let hdrOut = '';
    let hdrCode = 0;
    try {
      hdrOut = execFileSync(NODE, ['src/tracker/verify-pipeline.mjs'], {
        cwd: ROOT, encoding: 'utf-8', timeout: 30000,
        env: { ...process.env, FRONTRUNNER_TRACKER: hHeaderish, FRONTRUNNER_REPORTS: hReports },
      });
    } catch (e) {
      hdrOut = String(e.stdout ?? '');
      hdrCode = e.status ?? -1;
    }
    const shortRowErrors = (hdrOut.match(/Row with too few columns/g) || []).length;
    if (shortRowErrors === 2 && hdrCode === 1) {
      pass('a malformed row with an exact Empresa/Company cell is not mistaken for the header');
    } else {
      fail(`expected 2 short-row errors for header-like malformed rows, got ${shortRowErrors} (exit ${hdrCode})`);
    }

    // …and the real header row must still be recognized, or every tracker
    // reports its own header as a malformed row.
    if (!/Row with too few columns[^\n]*# \| Date \| Company/.test(hdrOut)) {
      pass('the genuine header row is still recognized as header furniture');
    } else {
      fail('the genuine header row was flagged as a malformed data row');
    }

    // A FULLY localized header must map through the alias table, not fall back
    // to LEGACY_COLMAP (#2274). On a plain 9-column table the fallback happens
    // to line up and hides the bug; with a Location column inserted, the Score
    // cell is read from Location instead — an ES tracker scored "Remote".
    const trackerParse = await import(pathToFileURL(join(ROOT, 'src/tracker/tracker-parse.mjs')).href);
    const esHeader = '| # | Fecha | Empresa | Puesto | Location | Score | Status | PDF | Report | Notes |';
    const esMap = trackerParse.detectColumns([esHeader]);
    if (esMap && esMap.score === 6 && esMap.company === 3 && esMap.role === 4 && esMap.location === 5) {
      pass('a fully localized header maps through the alias table (#2274)');
    } else {
      fail(`localized header did not map: ${JSON.stringify(esMap)}`);
    }

    // The two readers must agree on every shape, or validation skips as
    // furniture what column detection cannot parse.
    const headerShapes = [
      ['| # | Date | Company | Role | Score | Status | PDF | Report | Notes |', true],
      ['| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |', true],
      ['| # | Fecha | Empresa | Puesto | Score | Status | PDF | Report | Notes |', true],
      [esHeader, true],
      ['| 4 | 2026-01-05 | Company | Short Row |', false],
      ['| 5 | 2026-01-05 | Empresa | Also Short |', false],
      ['| 6 | 2026-01-05 | Acme Corp | Director | 4.0/5 | Evaluated | ❌ | — | note |', false],
      ['|---|------|---------|------|-------|--------|-----|--------|-------|', false],
    ];
    const disagreements = headerShapes.filter(([line, expected]) => {
      const isHeader = trackerParse.isHeaderRow(line);
      const detects = trackerParse.detectColumns([line]) !== null;
      return isHeader !== detects || isHeader !== expected;
    });
    if (disagreements.length === 0) {
      pass('isHeaderRow and detectColumns agree on every header shape');
    } else {
      fail(`isHeaderRow/detectColumns disagree on: ${disagreements.map(d => d[0].slice(0, 40)).join(' | ')}`);
    }
  } finally {
    rmSync(hyphenTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`dedup blindness test crashed: ${e.message}`);
}

// ── MERGE-TRACKER REQ/JOB-NUMBER DEDUP GUARD (#1524) ─────────────────────
// Tier-3 dedup (company + fuzzy role match) had no req/job-number awareness:
// two distinct postings at the same company with similarly-worded titles were
// silently collapsed into one row whenever a req/job number in the Notes
// column was the only thing distinguishing them. Covers: (a) same-looking
// titles + different req numbers → NOT a duplicate, (b) same-looking titles +
// same req number → still a duplicate, (c) no req number on either side →
// existing fuzzy-match behavior unchanged, (d) req number on only one side →
// falls back to fuzzy-match behavior (can't prove a mismatch without both).
console.log('\n🧪 Testing merge-tracker req/job-number dedup guard (#1524)...');
try {
  const reqTmp = mkdtempSync(join(tmpdir(), 'frontrunner-merge-1524-'));
  try {
    mkdirSync(join(reqTmp, 'data'));
    mkdirSync(join(reqTmp, 'reports'));
    const reqAdditions = join(reqTmp, 'additions');
    mkdirSync(reqAdditions);
    const reqTracker = join(reqTmp, 'data', 'applications.md');
    writeFileSync(reqTracker,
      '# Applications Tracker\n\n' +
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
      '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
      '| 1 | 2026-01-01 | Fabrikam | Learning Development Designer III | 3.8/5 | Evaluated | ❌ | [1](../reports/evaluations/001-fabrikam-2026-01-01.md) | Req R_1000001 |\n' +
      '| 2 | 2026-01-01 | Fabrikam | Curriculum Program Coordinator | 3.5/5 | Evaluated | ❌ | [2](../reports/evaluations/002-fabrikam-2026-01-01.md) | no req number here |\n' +
      '| 3 | 2026-01-01 | Northwind | Operations Analyst | 3.6/5 | Evaluated | ❌ | [3](../reports/evaluations/003-northwind-2026-01-01.md) | Job 2026-55501 |\n');
    for (const n of [
      '001-fabrikam-2026-01-01', '002-fabrikam-2026-01-01', '003-northwind-2026-01-01',
      '004-fabrikam-2026-01-02', '005-fabrikam-2026-01-02', '006-fabrikam-2026-01-02', '007-northwind-2026-01-02',
    ]) {
      writeFileSync(join(reqTmp, 'reports', `${n}.md`), '# fixture\n');
    }

    // (a) Same-looking title, DIFFERENT req number → must NOT be treated as a duplicate.
    writeFileSync(join(reqAdditions, '004-fabrikam.tsv'),
      '4\t2026-01-02\tFabrikam\tLearning Development Curriculum Designer\tEvaluated\t4.5/5\t❌\t[4](workspace/reports/evaluations/004-fabrikam-2026-01-02.md)\tReq R_1000002 — distinct posting (#1524)\n');
    // (b) Same-looking title, SAME req number → still a duplicate (lower score → skipped, row untouched).
    writeFileSync(join(reqAdditions, '005-fabrikam.tsv'),
      '5\t2026-01-02\tFabrikam\tLearning Development Designer III (Repost)\tEvaluated\t3.0/5\t❌\t[5](workspace/reports/evaluations/005-fabrikam-2026-01-02.md)\tReq R_1000001 — same posting repost\n');
    // (c) No req number on either side → existing fuzzy-match behavior unchanged (still deduped).
    writeFileSync(join(reqAdditions, '006-fabrikam.tsv'),
      '6\t2026-01-02\tFabrikam\tCurriculum Program Coordinator II\tEvaluated\t3.9/5\t❌\t[6](workspace/reports/evaluations/006-fabrikam-2026-01-02.md)\tno req number, higher score\n');
    // (d) Req number on only one side → can't prove a mismatch, falls back to fuzzy-match (still deduped).
    writeFileSync(join(reqAdditions, '007-northwind.tsv'),
      '7\t2026-01-02\tNorthwind\tOperations Analyst\tEvaluated\t3.2/5\t❌\t[7](workspace/reports/evaluations/007-northwind-2026-01-02.md)\tno req number on this side\n');

    const reqResult = run(NODE, ['src/tracker/merge-tracker.mjs'], { env: { ...process.env, FRONTRUNNER_TRACKER: reqTracker, FRONTRUNNER_ADDITIONS: reqAdditions } });
    if (reqResult === null) {
      fail('src/tracker/merge-tracker.mjs crashed during req/job-number dedup guard test (#1524)');
    } else {
      const reqMerged = readFileSync(reqTracker, 'utf-8');
      const reqRows = reqMerged.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| #') && !l.startsWith('|---'));

      // (a) Different req numbers: distinct posting added as a NEW row, existing #1 left untouched.
      const distinctRow = reqRows.find(r => r.includes('Learning Development Curriculum Designer'));
      const originalRow1 = reqRows.find(r => r.includes('Learning Development Designer III') && !r.includes('(Repost)') && !r.includes('Curriculum Designer'));
      if (distinctRow && originalRow1 && originalRow1.includes('3.8/5') && originalRow1.includes('R_1000001')) {
        pass('(#1524a) different req numbers on similar titles → NOT deduped, both rows present');
      } else {
        fail('(#1524a) different req numbers on similar titles were incorrectly deduped');
      }

      // (b) Same req number: still recognized as a duplicate — no separate "(Repost)" row,
      // and since the new score (3.0) is lower than the existing (3.8), the existing row is left as-is.
      const repostRow = reqRows.find(r => r.includes('(Repost)'));
      if (!repostRow && originalRow1 && originalRow1.includes('3.8/5')) {
        pass('(#1524b) same req number on similar titles → still deduped (skipped, lower score)');
      } else {
        fail('(#1524b) same req number should have been deduped away, not added as a new row');
      }

      // (c) No req number on either side: existing fuzzy-match-only behavior preserved — deduped and
      // updated in place (higher score), not appended as a new row.
      const coordinatorRows = reqRows.filter(r => r.includes('Curriculum Program Coordinator'));
      if (coordinatorRows.length === 1 && coordinatorRows[0].includes('3.9/5')) {
        pass('(#1524c) no req number on either side → fuzzy-match behavior unchanged (updated in place)');
      } else {
        fail(`(#1524c) fuzzy-match-only behavior regressed: expected 1 'Curriculum Program Coordinator' row at 3.9/5, got ${coordinatorRows.length}`);
      }

      // (d) Req number on only one side (existing row has "Job 2026-55501", addition has none):
      // can't prove a mismatch without both numbers, so falls back to fuzzy match → still deduped
      // into exactly one row. The addition's score (3.2) is lower than the existing (3.6), so the
      // existing row is left as-is rather than updated.
      const opsAnalystRows = reqRows.filter(r => r.includes('Operations Analyst'));
      if (opsAnalystRows.length === 1 && opsAnalystRows[0].includes('3.6/5')) {
        pass('(#1524d) req number on only one side → falls back to fuzzy match, still deduped');
      } else {
        fail(`(#1524d) one-sided req number should fall back to fuzzy match: expected 1 'Operations Analyst' row at 3.6/5, got ${opsAnalystRows.length}`);
      }
    }
  } finally {
    rmSync(reqTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`merge-tracker req/job-number dedup guard test crashed: ${e.message}`);
}

// ── MERGE-TRACKER CONCURRENT WRITES (#781 follow-up) ─────────────────────
// Report-number reservation is atomic now (#803), but tracker merges are a
// separate read/modify/write step. If two merge-tracker processes read the same
// old applications.md snapshot and then write back independently, one process
// can erase the row added by the other. This fixture gives each process a
// different additions dir and pauses the first process after it has read the
// tracker, making the old race deterministic.
console.log('\n🧪 Testing merge-tracker concurrent writes...');
try {
  let retries = 1;
  while (retries >= 0) {
    const mergeTmp = mkdtempSync(join(tmpdir(), 'frontrunner-merge-lock-'));
    /**
     * Spawn one isolated `src/tracker/merge-tracker.mjs` process against the temporary fixture.
     *
     * Each spawned process receives the same tracker path and lock path but a
     * different additions directory. Without serialization, both processes can
     * read the same old tracker and the later write can lose the other row. The
     * first worker also sends an IPC readiness message after reading the tracker
     * and before its test hold, which lets the test launch the second worker at
     * the exact old race point instead of relying on scheduler timing.
     *
     * @param {string} additionsDir - Directory containing this process's TSV row.
     * @param {number} [holdMs=0] - Optional post-read delay injected into the merge.
     * @returns {{ready: Promise<void>, result: Promise<{code:number|null,stdout:string,stderr:string}>}}
     * Worker readiness and final process result promises.
     */
    function spawnMerge(additionsDir, holdMs = 0) {
      let markReady;
      let readyMarked = false;
      const ready = new Promise(resolve => { markReady = resolve; });
      const result = new Promise(resolve => {
        const child = spawn(NODE, ['src/tracker/merge-tracker.mjs'], {
          cwd: ROOT,
          env: {
            ...process.env,
            FRONTRUNNER_TRACKER: join(mergeTmp, 'data', 'applications.md'),
            FRONTRUNNER_ADDITIONS: additionsDir,
            FRONTRUNNER_TRACKER_LOCK: join(mergeTmp, 'frontrunner-merge-tracker-fixture.lock'),
            FRONTRUNNER_MERGE_HOLD_MS: String(holdMs),
            FRONTRUNNER_MERGE_READY_IPC: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let stdout = '';
        let stderr = '';
        const resolveReady = () => {
          if (readyMarked) return;
          readyMarked = true;
          markReady();
        };
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('message', msg => {
          if (msg?.type === 'merge-tracker-ready') resolveReady();
        });
        child.on('error', err => {
          resolveReady();
          resolve({ code: -1, stdout, stderr: String(err) });
        });
        child.on('close', code => {
          resolveReady();
          resolve({ code, stdout, stderr });
        });
      });
      return { ready, result };
    }

    /**
     * Fail fast when a worker never reaches the deterministic race checkpoint.
     *
     * A missing readiness signal would otherwise hang the test suite. Timing out
     * turns that broken test contract into a normal assertion failure with a clear
     * message.
     *
     * @param {Promise<void>} ready - Worker readiness promise.
     * @param {number} timeoutMs - Maximum milliseconds to wait.
     * @returns {Promise<void>} Resolves when ready arrives before the timeout.
     */
    function waitForReady(ready, timeoutMs) {
      return Promise.race([
        ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('merge worker did not signal readiness')), timeoutMs)),
      ]);
    }

    try {
      mkdirSync(join(mergeTmp, 'data'));
      mkdirSync(join(mergeTmp, 'reports'));
      const additionsA = join(mergeTmp, 'additions-a');
      const additionsB = join(mergeTmp, 'additions-b');
      mkdirSync(additionsA);
      mkdirSync(additionsB);

      writeFileSync(join(mergeTmp, 'data', 'applications.md'),
        '# Applications Tracker\n\n' +
        '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
        '|---|------|---------|------|-------|--------|-----|--------|-------|\n');
      writeFileSync(join(mergeTmp, 'reports', '010-alpha-2026-01-07.md'), '# fixture\n');
      writeFileSync(join(mergeTmp, 'reports', '011-beta-2026-01-07.md'), '# fixture\n');
      writeFileSync(join(additionsA, '010-alpha.tsv'),
        '10\t2026-01-07\tAlpha\tPlatform Engineer\tEvaluated\t4.1/5\t❌\t[10](workspace/reports/evaluations/010-alpha-2026-01-07.md)\tfirst concurrent merge\n');
      writeFileSync(join(additionsB, '011-beta.tsv'),
        '11\t2026-01-07\tBeta\tData Engineer\tEvaluated\t4.2/5\t❌\t[11](workspace/reports/evaluations/011-beta-2026-01-07.md)\tsecond concurrent merge\n');

      const first = spawnMerge(additionsA, 350);
      await waitForReady(first.ready, 10_000); // Widen to 10s
      const second = spawnMerge(additionsB, 0);
      const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

      if (firstResult.code === 0 && secondResult.code === 0) {
        pass('concurrent merge processes both exited successfully');
      } else {
        throw new Error(`concurrent merge process failed: first=${firstResult.code} second=${secondResult.code} stderr=${firstResult.stderr || secondResult.stderr}`);
      }

      const merged = readFileSync(join(mergeTmp, 'data', 'applications.md'), 'utf-8');
      if (merged.includes('Alpha') && merged.includes('Beta')) {
        pass('concurrent tracker merges preserve rows from both processes');
      } else {
        throw new Error(`concurrent tracker merge lost a row: ${merged}`);
      }
      break;
    } catch (e) {
      if (retries > 0) {
        warn(`merge-tracker concurrent write test flaked (${e.message}). Retrying once...`);
        retries -= 1;
      } else {
        fail(`merge-tracker concurrent write test crashed: ${e.message}`);
        break;
      }
    } finally {
      rmSync(mergeTmp, { recursive: true, force: true });
    }
  }
} catch (e) {
  fail(`merge-tracker concurrent write test crashed: ${e.message}`);
}

// ── 12. COLD-START TRIGGER ──────────────────────────────────────
