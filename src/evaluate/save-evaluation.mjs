/**
 * Deterministic persistence for model evaluation data.
 *
 * Models never receive filesystem tools. They return the scoring contract;
 * this module alone creates the report and tracker row.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '#paths';
import {
  formatReportNumber,
  releaseReportNumbers,
  reserveReportNumbers,
} from '../tracker/reserve-report-num.mjs';
import {
  publishEvaluationArtifacts,
  recoverEvaluationPublications,
} from './evaluation-publication.mjs';
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
  const reportsDir = join(rootDir, 'workspace', 'reports', 'evaluations');
  const additionsDir = join(rootDir, 'workspace', '.state', 'tracker-additions');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(additionsDir, { recursive: true });
  await recoverEvaluationPublications({ rootDir });

  let ownedReservation = [];
  let pendingJournalPath = null;
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
    if (existsSync(reportPath)) throw new Error(`report already exists: workspace/reports/evaluations/${filename}`);

    const sourceLine = sourceUrl ? `**URL:** ${safeField(sourceUrl)}\n` : '';
    const report = renderEvaluationReport(result);
    const reportContent = `# Evaluation: ${result.company} — ${result.role}

**Date:** ${today}
**Archetype:** ${result.archetype}
**Score:** ${result.overallScore.toFixed(1)}/5
${sourceLine}**Legitimacy:** ${result.legitimacy.tier}
**PDF:** pending
**Tool:** ${safeField(tool)}

---

${report.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

    const trackerPath = join(additionsDir, `${num}-${slug}.tsv`);
    const trackerContent = [
      String(number),
      today,
      safeField(result.company),
      safeField(result.role),
      'Evaluated',
      `${result.overallScore.toFixed(1)}/5`,
      '❌',
      `[${num}](workspace/reports/evaluations/${filename})`,
      `${safeField(tool)}; hostile-content boundary enforced`,
    ].join('\t') + '\n';
    pendingJournalPath = join(reportsDir, `${num}-PUBLISHING.json`);
    await publishEvaluationArtifacts({
      number,
      slug,
      date: today,
      report: reportContent,
      tracker: trackerContent,
      mergeTracker,
      rootDir,
    });
    return { number, num, reportPath, trackerPath, filename };
  } finally {
    if (ownedReservation.length && (!pendingJournalPath || !existsSync(pendingJournalPath))) {
      await releaseReportNumbers(ownedReservation, { rootDir, reportsDir });
    }
  }
}
