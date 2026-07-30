/**
 * roles.ts — the data model behind the workflow.
 *
 * The organising idea: this tool exists to get applications OUT. So a role's
 * position in the UI is decided by how close it is to being sent, not by score
 * or date.
 *
 * The existing UI sorts by recency and offers "Mark applied" / "Skip" —
 * bookkeeping actions that assume the work happened somewhere else. The actual
 * work (generating the tailored CV) sits one click deeper, on a page you have
 * to know exists. That is why evaluated roles are hard to find.
 *
 * Here every role carries its NEXT ACTION, and the stream is sorted by
 * readiness so the first row is always the most useful thing to do.
 */

import { readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parsePipelineMetadata } from './pipeline-row.mjs';
import { safeExternalUrl } from './urls';
import { ROOT, WORKSPACE } from './root';

// ---------------------------------------------------------------- types

export type Stage =
  | 'inbox'      // found, not yet scored
  | 'triage'     // scored, awaiting your decision
  | 'prepare'    // you want it; artefacts not ready
  | 'ready'      // artefacts ready; go apply
  | 'applied'    // sent, awaiting reply
  | 'active'     // they replied / interviewing
  | 'closed';    // rejected, discarded, skipped

export type Readiness =
  | 'ready-to-send'
  | 'one-step-away'
  | 'needs-decision'
  | 'in-flight'
  | 'parked';

export interface NextAction {
  /** Imperative, user-facing. "Generate tailored CV", not "pdf". */
  label: string;
  /** What the action does, for the client to dispatch. */
  kind: 'generate-cv' | 'draft-letter' | 'open-posting' | 'mark-applied' | 'decide' | 'follow-up' | 'none';
  /** True when it spends model tokens — always surfaced before it runs. */
  costsTokens: boolean;
}

export interface Role {
  num: number;
  /** Optimistic-concurrency token for the exact tracker row that was read. */
  revision: string;
  date: string;
  company: string;
  role: string;
  score: number | null;
  status: string;
  hasPdf: boolean;
  reportPath: string | null;
  /**
   * The real job posting. Pulled from the report header rather than the
   * tracker, which does not carry it.
   *
   * This matters more than it looks: people do not fully trust an AI
   * assessment, and they should not have to. Every screen that shows an
   * opinion about a job also links to the job itself.
   */
  url: string | null;
  /** Generated CV, when one exists. Read from workspace/.state/pdf-index.tsv. */
  pdf: string | null;
  html: string | null;
  notes: string;
  stage: Stage;
  readiness: Readiness;
  nextAction: NextAction;
  /** Sort key — lower is more urgent. */
  priority: number;
}

// ---------------------------------------------------------------- parsing

const SCORE_RE = /^(\d+(?:\.\d+)?)\/5$/;
const MAX_TRACKER_BYTES = 5 * 1024 * 1024;
const MAX_PIPELINE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_INDEX_BYTES = 2 * 1024 * 1024;

async function readBoundedText(file: string, maxBytes: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(file, reportReadFlags());
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const content = await fh.readFile({ encoding: 'utf8' });
    return Buffer.byteLength(content) <= maxBytes ? content : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function parseScore(cell: string): number | null {
  const m = cell.trim().match(SCORE_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Read the tracker. Deliberately tolerant: a malformed row is skipped rather
 * than throwing, because a single bad row must never blank the whole screen.
 */
export async function readTracker(): Promise<Role[]> {
  const file = WORKSPACE.tracker;
  const raw = await readBoundedText(file, MAX_TRACKER_BYTES);
  if (raw === null) return [];

  const roles: Role[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 8) continue;
    if (!/^\d+$/.test(cells[0])) continue;   // header / separator

    const [numRaw, date, company, role, scoreRaw, status, pdf, report] = cells;
    const notes = cells[8] ?? '';
    const reportMatch = report.match(/\]\(([^)]+)\)/);

    const base = {
      url: null as string | null,
      pdf: null as string | null,
      html: null as string | null,
      num: Number(numRaw),
      revision: createHash('sha256').update(line).digest('hex'),
      date,
      company,
      role,
      score: parseScore(scoreRaw),
      status: status.replace(/\*\*/g, '').trim(),
      hasPdf: pdf.includes('✅'),
      reportPath: reportMatch ? reportMatch[1] : null,
      notes,
    };

    roles.push({ ...base, ...classify(base) });
  }

  // Attach generated documents. generate-pdf.mjs records each linkage here, so
  // this is the authoritative map rather than guessing from filenames.
  const pdfIndex = await readPdfIndex();
  for (const r of roles) {
    const key = String(r.num).padStart(3, '0');
    const entry = pdfIndex.get(key);
    if (entry) {
      r.pdf = entry.pdf;
      r.html = entry.html;
    }
  }

  // Enrich with posting URLs. Only the first 2KB of each report is read, so
  // this stays cheap across a few hundred roles.
  await Promise.all(
    roles.map(async (r) => {
      if (r.reportPath) r.url = await readUrlFromReport(r.reportPath);
    }),
  );

  // Readiness first, then best match within each band — so the strongest
  // opportunity is always the top row of whatever band you are looking at.
  return roles.sort((a, b) => a.priority - b.priority || (b.score ?? 0) - (a.score ?? 0));
}

// ---------------------------------------------------------------- the model

type Base = Omit<Role, 'stage' | 'readiness' | 'nextAction' | 'priority'>;

/**
 * Decide stage, readiness and next action.
 *
 * Thresholds mirror the CLI's own rules so the two never disagree: >= 4.0 is a
 * real candidate, 3.0-3.9 needs judgement, below that is parked.
 *
 * IMPORTANT — the next action is the next FREE step wherever one exists.
 *
 * An earlier version made "Generate tailored CV" the primary button on the
 * list. That asks someone to spend their AI allowance on a role they have not
 * read yet, and the honest reaction is "I don't know enough to want to do
 * that." Nobody commits budget to a job they have not looked at.
 *
 * So reading the assessment always comes first; spending happens on the role
 * page, after a decision.
 */
export function classify(r: Base): Pick<Role, 'stage' | 'readiness' | 'nextAction' | 'priority'> {
  const s = r.status.toLowerCase();

  if (['rejected', 'discarded', 'skip'].includes(s)) {
    return {
      stage: 'closed',
      readiness: 'parked',
      nextAction: { label: '—', kind: 'none', costsTokens: false },
      priority: 900,
    };
  }

  if (['responded', 'interview', 'offer', 'hired'].includes(s)) {
    return {
      stage: 'active',
      readiness: 'in-flight',
      nextAction: { label: 'Open', kind: 'follow-up', costsTokens: false },
      priority: 100,
    };
  }

  if (s === 'applied') {
    return {
      stage: 'applied',
      readiness: 'in-flight',
      nextAction: { label: 'Open', kind: 'follow-up', costsTokens: false },
      priority: 300,
    };
  }

  // Evaluated, or anything else not yet sent.
  const score = r.score ?? 0;
  const explicitStages = [...r.notes.matchAll(/\[frontrunner-stage:(triage|prepare|ready)\]/gu)];
  const explicitStage = explicitStages.at(-1)?.[1];

  if (
    explicitStage === 'ready' && r.hasPdf
    || score >= 4.0 && r.hasPdf && explicitStage !== 'triage' && explicitStage !== 'prepare'
  ) {
    return {
      stage: 'ready',
      readiness: 'ready-to-send',
      nextAction: { label: 'Review and apply', kind: 'open-posting', costsTokens: false },
      priority: 10,
    };
  }

  if (explicitStage === 'prepare' || score >= 4.0 && explicitStage !== 'triage') {
    // Free: read why it scored well. The CV is offered on the role page once
    // they have decided they want it.
    return {
      stage: 'prepare',
      readiness: 'one-step-away',
      nextAction: { label: 'See why it fits', kind: 'decide', costsTokens: false },
      priority: 20,
    };
  }

  if (explicitStage === 'triage' || score >= 3.0) {
    return {
      stage: 'triage',
      readiness: 'needs-decision',
      nextAction: { label: 'See the assessment', kind: 'decide', costsTokens: false },
      priority: 50,
    };
  }

  return {
    stage: 'closed',
    readiness: 'parked',
    nextAction: { label: '—', kind: 'none', costsTokens: false },
    priority: 800,
  };
}

// ---------------------------------------------------------------- inbox

export interface InboxRole {
  url: string;
  company: string;
  role: string;
  location: string;
  posted: string | null;
}

/** Unscored roles waiting in workspace/search/pipeline.md — the "find" phase. */
export async function readInbox(): Promise<InboxRole[]> {
  const file = WORKSPACE.pipeline;
  const raw = await readBoundedText(file, MAX_PIPELINE_BYTES);
  if (raw === null) return [];

  const out: InboxRole[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^-\s*\[\s*\]\s*(\S+)\s*(.*)$/);
    if (!m) continue;
    const url = safeExternalUrl(m[1]);
    if (!url) continue;
    const metadata = parsePipelineMetadata(m[2]);
    out.push({
      url,
      company: metadata.company,
      role: metadata.role,
      location: metadata.location,
      posted: metadata.posted,
    });
  }
  return out;
}

/** Counts for the header — cheap enough to compute on every request. */
export async function summarise() {
  const [roles, inbox] = await Promise.all([readTracker(), readInbox()]);
  const by = (r: Readiness) => roles.filter((x) => x.readiness === r).length;
  return {
    inbox: inbox.length,
    readyToSend: by('ready-to-send'),
    oneStepAway: by('one-step-away'),
    needsDecision: by('needs-decision'),
    inFlight: by('in-flight'),
    parked: by('parked'),
    total: roles.length,
  };
}

/**
 * report number -> generated documents, from workspace/.state/pdf-index.tsv.
 *
 * generate-pdf.mjs writes this file on every render, so it is the
 * authoritative mapping. Guessing from filenames would break the moment a
 * company name contains a character the slugger treats differently.
 */
async function readPdfIndex(): Promise<Map<string, { pdf: string; html: string }>> {
  const out = new Map<string, { pdf: string; html: string }>();
  const file = WORKSPACE.pdfIndex;
  const content = await readBoundedText(file, MAX_PDF_INDEX_BYTES);
  if (content === null) return out;
  for (const line of content.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [num, pdf, html] = line.split('\t');
    if (num && pdf) {
      out.set(num.trim().padStart(3, '0'), {
        pdf: pdf.trim(),
        html: (html ?? '').trim(),
      });
    }
  }
  return out;
}

/** Read just the `**URL:**` line from a report header. */
async function readUrlFromReport(reportPath: string): Promise<string | null> {
  const candidate = safeReportFile(reportPath);
  if (!candidate) return null;
  let fh;
  try {
      fh = await open(candidate, reportReadFlags());
      const stat = await fh.stat();
      if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return null;
      const { buffer } = await fh.read(Buffer.alloc(2048), 0, 2048, 0);
      const m = buffer.toString('utf8').match(/^\*\*URL:\*\*\s*(\S+)/m);
      return m ? safeExternalUrl(m[1]) : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Full report markdown for a role, when one exists. */
export async function readReport(reportPath: string): Promise<string | null> {
  const candidate = safeReportFile(reportPath);
  if (!candidate) return null;
  let fh;
  try {
    fh = await open(candidate, reportReadFlags());
    const stat = await fh.stat();
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return null;
    const content = await fh.readFile({ encoding: 'utf8' });
    return Buffer.byteLength(content) <= MAX_REPORT_BYTES ? content : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const MAX_REPORT_BYTES = 2 * 1024 * 1024;

function reportReadFlags(): number {
  const noFollow = process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number'
    ? constants.O_NOFOLLOW
    : 0;
  return constants.O_RDONLY | noFollow;
}

function safeReportFile(reportPath: string): string | null {
  if (typeof reportPath !== 'string' || reportPath.length > 300 || !reportPath.endsWith('.md')) return null;
  const reportsRoot = WORKSPACE.reports;

  // Report links come from the tracker's markdown and are relative to the file
  // that CONTAINS them — workspace/applications/tracker.md — so they look like
  // '../reports/evaluations/001-x.md'. Resolving those against ROOT lands outside the repo
  // and fails containment, which silently blanked every assessment and every
  // job-advert link. Try the tracker's own directory first, then ROOT for the
  // root-level tracker layout.
  const candidate = [
    resolve(dirname(WORKSPACE.tracker), reportPath),
    resolve(ROOT, reportPath),
  ].find((p) => dirname(p) === reportsRoot);
  return candidate ?? null;
}

export async function listReports(): Promise<string[]> {
  const dir = WORKSPACE.reports;
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}
