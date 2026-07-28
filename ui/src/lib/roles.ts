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

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Repo root: the career-ops checkout this UI lives inside. */
export const ROOT = join(process.cwd(), '..');

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
  date: string;
  company: string;
  role: string;
  score: number | null;
  status: string;
  hasPdf: boolean;
  reportPath: string | null;
  notes: string;
  stage: Stage;
  readiness: Readiness;
  nextAction: NextAction;
  /** Sort key — lower is more urgent. */
  priority: number;
}

// ---------------------------------------------------------------- parsing

const SCORE_RE = /^(\d+(?:\.\d+)?)\/5$/;

function parseScore(cell: string): number | null {
  const m = cell.trim().match(SCORE_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Read the tracker. Deliberately tolerant: a malformed row is skipped rather
 * than throwing, because a single bad row must never blank the whole screen.
 */
export async function readTracker(): Promise<Role[]> {
  const file = join(ROOT, 'data', 'applications.md');
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf8');

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
      num: Number(numRaw),
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

  if (score >= 4.0 && r.hasPdf) {
    return {
      stage: 'ready',
      readiness: 'ready-to-send',
      nextAction: { label: 'Review and apply', kind: 'open-posting', costsTokens: false },
      priority: 10,
    };
  }

  if (score >= 4.0) {
    // Free: read why it scored well. The CV is offered on the role page once
    // they have decided they want it.
    return {
      stage: 'prepare',
      readiness: 'one-step-away',
      nextAction: { label: 'See why it fits', kind: 'decide', costsTokens: false },
      priority: 20,
    };
  }

  if (score >= 3.0) {
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

/** Unscored roles waiting in data/pipeline.md — the "find" phase. */
export async function readInbox(): Promise<InboxRole[]> {
  const file = join(ROOT, 'data', 'pipeline.md');
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf8');

  const out: InboxRole[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^-\s*\[\s*\]\s*(\S+)\s*(.*)$/);
    if (!m) continue;
    const parts = m[2].split('|').map((p) => p.trim()).filter(Boolean);
    const postedPart = parts.find((p) => p.startsWith('posted:'));
    out.push({
      url: m[1],
      company: parts[0] ?? '',
      role: parts[1] ?? '',
      location: parts[2] ?? '',
      posted: postedPart ? postedPart.replace('posted:', '').trim() : null,
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

/** Full report markdown for a role, when one exists. */
export async function readReport(reportPath: string): Promise<string | null> {
  const candidates = [join(ROOT, 'data', reportPath), join(ROOT, reportPath)];
  for (const c of candidates) {
    if (existsSync(c)) return readFile(c, 'utf8');
  }
  return null;
}

export async function listReports(): Promise<string[]> {
  const dir = join(ROOT, 'reports');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith('.md'));
}
