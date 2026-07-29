/**
 * report.ts — turn a 2,200-word evaluation into what a job seeker needs.
 *
 * The reports are structured A–G plus a machine-summary YAML fence, a score
 * breakdown, extracted ATS keywords and a cover-letter draft. That is the right
 * shape for an agent and the wrong shape for a person deciding whether to spend
 * an evening applying.
 *
 * Someone reading this wants four things, in this order:
 *   1. Should I bother?          -> the verdict
 *   2. Why does it fit me?       -> the match
 *   3. What is weak?             -> the gaps, stated honestly
 *   4. What would they ask me?   -> interview prep
 *
 * Everything else — YAML, keyword lists, legitimacy signal tables — is
 * machinery. It stays available but does not lead.
 */

export interface ReportSection {
  id: string;
  title: string;
  body: string;
}

export interface ParsedReport {
  /** One-line verdict pulled from the header or the Verdict section. */
  verdict: string | null;
  /** Sections a human wants, in reading order. */
  primary: ReportSection[];
  /** Machinery — available, collapsed by default. */
  secondary: ReportSection[];
  /** True for the short triage format (no A–G blocks). */
  isTriage: boolean;
}

/** Headings a person actually wants, mapped to plain titles. */
const PRIMARY: Record<string, string> = {
  'verdict': 'Verdict',
  'a) role summary': 'What the job is',
  'b) match with cv': 'Why you fit',
  "why it doesn't fit": "Why it doesn't fit",
  'hard blockers': 'Dealbreakers',
  'c) level and strategy': 'How to pitch yourself',
  'd) comp and demand': 'Pay and demand',
  'f) interview plan': 'What they might ask',
  'better fit at this company': 'Better fit here',
};

/** Machinery: correct to keep, wrong to lead with. */
const SECONDARY: Record<string, string> = {
  'machine summary': 'Raw data',
  'e) customization plan': 'CV tailoring plan',
  'g) posting legitimacy': 'Is this posting real?',
  'risk summary': 'Risk summary',
  'score breakdown': 'How it scored',
  'keywords extracted': 'ATS keywords',
  'cover letter draft': 'Cover letter draft',
};

export function parseReport(markdown: string): ParsedReport {
  const lines = markdown.split('\n');

  const sections: ReportSection[] = [];
  let current: ReportSection | null = null;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (current) sections.push(current);
      const title = h2[1].trim();
      current = { id: title.toLowerCase(), title, body: '' };
      continue;
    }
    if (current) current.body += line + '\n';
  }
  if (current) sections.push(current);

  const primary: ReportSection[] = [];
  const secondary: ReportSection[] = [];

  for (const s of sections) {
    const key = s.id;
    if (key in PRIMARY) primary.push({ ...s, title: PRIMARY[key] });
    else if (key in SECONDARY) secondary.push({ ...s, title: SECONDARY[key] });
    else secondary.push(s);
  }

  // Preserve the reading order defined above rather than file order.
  const order = Object.values(PRIMARY);
  primary.sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));

  const verdictSection = sections.find((s) => s.id === 'verdict');
  const verdict = verdictSection
    ? verdictSection.body.trim().split('\n')[0].replace(/^\*\*|\*\*$/g, '').trim()
    : null;

  return {
    verdict,
    primary,
    secondary,
    isTriage: !sections.some((s) => s.id.startsWith('a) ')),
  };
}
