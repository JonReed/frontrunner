/**
 * Deterministic persistence for model evaluation data.
 *
 * Models never receive filesystem tools. They return the scoring contract;
 * this module alone creates the report and tracker row.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';
import {
  formatReportNumber,
  releaseReportNumbers,
  reserveReportNumbers,
} from '../tracker/reserve-report-num.mjs';
import { renderEvaluationReport } from './scoring-contract.mjs';

const safeField = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const slugify = (value) => safeField(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

export async function saveEvaluation(result, {
  tool = 'Frontrunner evaluator',
  sourceUrl = null,
  reportNumber = null,
  rootDir = ROOT,
  mergeTracker = true,
} = {}) {
  const reportsDir = join(rootDir, 'reports');
  const additionsDir = join(rootDir, 'batch', 'tracker-additions');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(additionsDir, { recursive: true });

  let ownedReservation = [];
  try {
    const number = reportNumber == null
      ? (ownedReservation = await reserveReportNumbers(1, { rootDir, reportsDir }))[0]
      : Number(reportNumber);
    if (!Number.isInteger(number) || number < 1 || number > 999_999) {
      throw new Error('report number must be a positive integer');
    }
    const num = formatReportNumber(number);
    const today = new Date().toISOString().slice(0, 10);
    const slug = slugify(result.company);
    const filename = `${num}-${slug}-${today}.md`;
    const reportPath = join(reportsDir, filename);
    if (existsSync(reportPath)) throw new Error(`report already exists: reports/${filename}`);

    const sourceLine = sourceUrl ? `**URL:** ${safeField(sourceUrl)}\n` : '';
    const report = renderEvaluationReport(result);
    writeFileSync(reportPath, `# Evaluation: ${result.company} — ${result.role}

**Date:** ${today}
**Archetype:** ${result.archetype}
**Score:** ${result.overallScore.toFixed(1)}/5
${sourceLine}**Legitimacy:** ${result.legitimacy.tier}
**PDF:** pending
**Tool:** ${safeField(tool)}

---

${report.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`, { encoding: 'utf8', mode: 0o600 });

    const trackerPath = join(additionsDir, `${num}-${slug}.tsv`);
    writeFileSync(trackerPath, [
      String(number),
      today,
      safeField(result.company),
      safeField(result.role),
      'Evaluated',
      `${result.overallScore.toFixed(1)}/5`,
      '❌',
      `[${num}](reports/${filename})`,
      `${safeField(tool)}; hostile-content boundary enforced`,
    ].join('\t') + '\n', { encoding: 'utf8', mode: 0o600 });

    if (mergeTracker) {
      execFileSync(process.execPath, [join(rootDir, 'src', 'tracker', 'merge-tracker.mjs')], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    return { number, num, reportPath, trackerPath, filename };
  } finally {
    if (ownedReservation.length) {
      await releaseReportNumbers(ownedReservation, { rootDir, reportsDir });
    }
  }
}
