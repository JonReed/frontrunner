import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pass, fail, warn, run, fileExists, ROOT, NODE, getBash, toBashPath } from '../helpers.mjs';
import { readFile, normalizeEol, readTextLF } from './support.mjs';

console.log('\n8. Mode file integrity');

const expectedModes = [
  '_shared.md', '_profile.template.md', 'oferta.md', 'pdf.md', 'scan.md',
  'batch.md', 'apply.md', 'auto-pipeline.md', 'contacto.md', 'deep.md',
  'ofertas.md', 'pipeline.md', 'project.md', 'tracker.md', 'training.md',
  'interview.md', 'latex.md', 'latex-tex.md', 'email.md', 'add.md', 'titles.md',
  'expand.md', 'discover.md',
  'regional/eu-swe.md',
];

for (const mode of expectedModes) {
  if (fileExists(`modes/${mode}`)) {
    pass(`Mode exists: ${mode}`);
  } else {
    fail(`Missing mode: ${mode}`);
  }
}

// _shared.md must route the agent to the user's targeting file. Asserted by
// real path: it previously required the string "_profile.md", a name that has
// not existed since the workspace consolidation, so the check passed while the
// instruction it guarded pointed at nothing.
const shared = readFile('modes/_shared.md');
if (shared.includes('workspace/profile/targeting.md')) {
  pass('_shared.md routes to workspace/profile/targeting.md');
} else {
  fail('_shared.md does NOT reference workspace/profile/targeting.md');
}

// --- _custom.md must be READ, not just written (#1388): Sources of Truth row +
// honor rule in _shared.md, and an explicit pre-generation read in pdf.md ---
const pdfModeCustom = readFile('modes/pdf.md');
const markersAppearInOrder = (text, markers) => {
  let cursor = -1;
  for (const marker of markers) {
    const idx = text.indexOf(marker, cursor + 1);
    if (idx === -1 || idx <= cursor) return false;
    cursor = idx;
  }
  return true;
};
if (
  shared.includes('`workspace/profile/preferences.md` (if exists)') &&
  markersAppearInOrder(shared, [
    'Read workspace/profile/targeting.md AFTER this file',
    'Read workspace/profile/preferences.md (if it exists) AFTER workspace/profile/targeting.md',
    'honor its house rules in every mode',
  ]) &&
  shared.includes('does not expire between sessions or between items in a batch') &&
  pdfModeCustom.includes('read `workspace/profile/preferences.md` (if it exists) and apply its formatting/content house rules')
) {
  pass('_custom.md is wired into the read path: Sources of Truth row + honor rule in _shared.md + explicit read in pdf.md (#1388)');
} else {
  fail('_custom.md read-path regressed: missing Sources of Truth row, honor rule in _shared.md, or the pre-generation read in pdf.md (#1388 would reopen)');
}

for (const skillPath of ['.claude/skills/frontrunner/SKILL.md', '.agents/skills/frontrunner/SKILL.md']) {
  if (!fileExists(skillPath)) {
    fail(`${skillPath} is missing`);
    continue;
  }
  const skill = readFile(skillPath);
  if (skill.includes('/frontrunner latex')) {
    pass(`${skillPath} exposes /frontrunner latex in discovery menu`);
  } else {
    fail(`${skillPath} does not expose /frontrunner latex in discovery menu`);
  }
  if (
    skill.includes('email') &&
    skill.includes('| `email` | `email` |') &&
    skill.includes('/frontrunner email') &&
    /Standalone modes[\s\S]*Applies to:[^\n]*`email`/.test(skill)
  ) {
    pass(`${skillPath} exposes /frontrunner email in routing, discovery, and standalone loading`);
  } else {
    fail(`${skillPath} does not fully expose /frontrunner email`);
  }
}

const emailMode = readFile('modes/email.md');
if (
  emailMode.includes('Application Email Drafts') &&
  emailMode.includes('Never submit') &&
  emailMode.includes('Never send email') &&
  emailMode.includes('Never click send') &&
  emailMode.includes('hr_application') &&
  emailMode.includes('referral_request') &&
  emailMode.includes('cold_application') &&
  emailMode.includes('Attachment checklist') &&
  emailMode.includes('candidate.wechat') &&
  emailMode.includes('workspace/.state/pdf-index.tsv') &&
  emailMode.includes('workspace/profile/voice-dna.md') &&
  emailMode.includes('workspace/profile/cv.md') &&
  emailMode.includes('workspace/profile/article-digest.md') &&
  emailMode.includes('workspace/profile/profile.yml') &&
  emailMode.includes('workspace/profile/targeting.md')
) {
  pass('email mode covers formal drafts, no-send safety, variants, attachments, contact fields, and source boundaries');
} else {
  fail('email mode missing required application-email behavior');
}

for (const skillPath of ['.claude/skills/frontrunner/SKILL.md', '.agents/skills/frontrunner/SKILL.md']) {
  if (!fileExists(skillPath)) {
    fail(`${skillPath} is missing`);
    continue;
  }
  const skill = readFile(skillPath);
  const sectionOrder = (sectionStart, sectionEnd, markers) => {
    const start = skill.indexOf(sectionStart);
    if (start === -1) return false;
    const end = sectionEnd ? skill.indexOf(sectionEnd, start + sectionStart.length) : -1;
    const section = skill.slice(start, end === -1 ? undefined : end);
    return markersAppearInOrder(section, markers);
  };

  const sharedModeOrder = sectionOrder(
    '### Modes that require `_shared.md` + their mode file',
    '### Standalone modes',
    ['modes/_shared.md', 'workspace/profile/targeting.md', 'workspace/profile/preferences.md', 'modes/{mode}.md'],
  );
  const standaloneModeOrder = sectionOrder(
    '### Standalone modes',
    '### Execution boundary',
    ['workspace/profile/targeting.md', 'workspace/profile/preferences.md', 'modes/{mode}.md'],
  );
  const executionBoundary = sectionOrder(
    '### Execution boundary',
    'Execute the instructions from the loaded mode file.',
    ['Do not delegate `scan`, `pipeline`', 'deterministic', 'model', 'must not receive browser, filesystem, shell, or local', 'application tools'],
  );

  if (
    skill.includes('workspace/profile/preferences.md') &&
    sharedModeOrder &&
    standaloneModeOrder &&
    executionBoundary
  ) {
    pass(`${skillPath} loads workspace/profile/preferences.md after targeting and before the selected mode, with a deterministic execution boundary`);
  } else {
    fail(`${skillPath} lost the targeting → preferences → mode order or deterministic execution boundary (#1388)`);
  }
}

const applyMode = readFile('modes/apply.md');
if (
  applyMode.includes('## Step 5 — Preflight gate') &&
  applyMode.includes('verify liveness with Playwright') &&
  applyMode.includes('matching report has been loaded') &&
  applyMode.includes('Do not continue to Step 6 until this preflight is resolved') &&
  applyMode.includes('refuse to generate final copy')
) {
  pass('apply mode includes liveness and role-match preflight gate');
} else {
  fail('apply mode missing liveness/role-match preflight gate');
}

if (
  applyMode.includes('## Application Answers') &&
  applyMode.includes('**State:** filled') &&
  applyMode.includes('**State:** submitted') &&
  applyMode.includes('Do not rename, reorder, or edit the existing A-H report blocks') &&
  applyMode.includes('src/evaluate/application-answers.mjs')
) {
  pass('apply mode persists filled/submitted answers in an additive report section');
} else {
  fail('apply mode missing additive Application Answers persistence instructions');
}

const expandMode = readFile('modes/expand.md');
if (
  /never fetch unlinked URLs/i.test(expandMode) &&
  /halt until explicit approval is given/i.test(expandMode) &&
  /node src\/tracker\/add-entry\.mjs/i.test(expandMode) &&
  /--stdin/i.test(expandMode) &&
  /Additive Only/i.test(expandMode) &&
  /Treat fetched evidence text as literal/i.test(expandMode)
) {
  pass('expand mode includes url limits, confirm gate, add-entry funneling, additive-only, and literal evidence rules');
} else {
  fail('expand mode missing required behavior boundaries (url limits, confirm gate, additive-only, literal evidence, add-entry funneling)');
}

try {
  const {
    formatApplicationAnswersSection,
    upsertApplicationAnswersSection,
  } = await import(pathToFileURL(join(ROOT, 'src/evaluate/application-answers.mjs')).href);

  const snapshot = {
    date: '2026-06-30',
    state: 'submitted',
    freeText: [
      { question: 'Why this role?', answer: 'I want to apply production AI agent experience here.' },
    ],
    selections: [
      { field: 'Technical areas', selected: ['Node.js', 'Go', 'LLM evaluation'] },
    ],
    fieldValues: [
      { field: 'Compensation expectation', value: '$150k base' },
    ],
    files: [
      { field: 'CV', path: 'workspace/documents/acme-cv.pdf', version: 'v3' },
      { field: 'Cover letter', path: 'workspace/documents/acme-cover-letter.pdf' },
    ],
  };

  const section = formatApplicationAnswersSection(snapshot);
  if (
    section.includes('## Application Answers') &&
    section.includes('**Date:** 2026-06-30') &&
    section.includes('**State:** submitted') &&
    section.includes('Why this role?') &&
    section.includes('Node.js, Go, LLM evaluation') &&
    section.includes('Compensation expectation') &&
    section.includes('workspace/documents/acme-cv.pdf (v3)')
  ) {
    pass('application answers formatter captures free text, selections, field values, files, date, and state');
  } else {
    fail(`application answers formatter dropped expected data:\n${section}`);
  }

  const report = [
    '# Evaluation: Acme - Staff Engineer',
    '',
    '## G) Posting Legitimacy',
    'original G content',
    '',
    '## H) Draft Application Answers',
    'draft H content',
    '',
    '## Keywords extracted',
    'agentic systems, node, go',
    '',
  ].join('\n');
  const updated = upsertApplicationAnswersSection(report, snapshot);
  const existingBlocksPreserved =
    updated.includes('## G) Posting Legitimacy\noriginal G content') &&
    updated.includes('## H) Draft Application Answers\ndraft H content') &&
    updated.includes('## Keywords extracted\nagentic systems, node, go');
  const existingOrderPreserved =
    updated.indexOf('## G) Posting Legitimacy') < updated.indexOf('## H) Draft Application Answers') &&
    updated.indexOf('## H) Draft Application Answers') < updated.indexOf('## Keywords extracted') &&
    updated.indexOf('## Keywords extracted') < updated.indexOf('## Application Answers');
  if (existingBlocksPreserved && existingOrderPreserved) {
    pass('application answers upsert appends without changing existing report blocks');
  } else {
    fail(`application answers upsert disturbed report blocks:\n${updated}`);
  }

  const refreshed = upsertApplicationAnswersSection([
    report.trimEnd(),
    '',
    '## Application Answers',
    '',
    'old filled snapshot',
    '',
    '## Later Additive Section',
    'later content',
    '',
  ].join('\n'), snapshot);
  const applicationAnswerHeadings = refreshed.match(/^## Application Answers$/gm) || [];
  if (
    applicationAnswerHeadings.length === 1 &&
    !refreshed.includes('old filled snapshot') &&
    refreshed.includes('## Later Additive Section\nlater content') &&
    refreshed.indexOf('## Application Answers') < refreshed.indexOf('## Later Additive Section')
  ) {
    pass('application answers upsert refreshes only the existing Application Answers section');
  } else {
    fail(`application answers upsert did not replace only its own section:\n${refreshed}`);
  }
} catch (e) {
  fail(`application answers helper crashed: ${e.message}`);
}

if (
  run(NODE, ['src/evaluate/application-answers.mjs', '--report', '--input'], { stdio: ['pipe', 'pipe', 'pipe'] }) === null &&
  run(NODE, ['src/evaluate/application-answers.mjs', '--report', '--input', 'answers.json'], { stdio: ['pipe', 'pipe', 'pipe'] }) === null
) {
  pass('application-answers CLI rejects missing option values');
} else {
  fail('application-answers CLI accepted a missing option value');
}

const ofertaMode = readFile('modes/oferta.md');
const autoPipelineMode = readFile('modes/auto-pipeline.md');
if (
  ofertaMode.includes('## Liveness gate (URL inputs)') &&
  ofertaMode.includes('closed posting evidence') &&
  ofertaMode.includes('Do not continue to Block A until this gate is resolved') &&
  autoPipelineMode.includes('src/pipeline/run.mjs') &&
  autoPipelineMode.includes('conclusive dead posting') &&
  autoPipelineMode.includes('never reaches a model')
) {
  pass('eval modes (oferta/auto-pipeline) gate dead links before evaluation');
} else {
  fail('eval modes missing liveness gate before evaluation');
}

if (
  ofertaMode.includes('## Bounded Research Budget') &&
  ofertaMode.includes('single-pass') &&
  ofertaMode.includes('hard cap: 5 total WebSearch queries') &&
  ofertaMode.includes('Do not invoke `deep-research`') &&
  ofertaMode.includes('Do not spawn subagents') &&
  ofertaMode.includes('Do not continue researching after the query cap is reached') &&
  !autoPipelineMode.includes('WebSearch') &&
  !autoPipelineMode.includes('deep-research') &&
  !autoPipelineMode.includes('spawn subagents')
) {
  pass('eval modes bound company/comp research to a non-recursive query budget (#1235)');
} else {
  fail('eval modes do not bound company/comp research against recursive fanout (#1235)');
}

if (
  ofertaMode.includes('### Geo-mismatch check') &&
  ofertaMode.includes('binding attendance requirement') &&
  ofertaMode.includes('⚠️ **Geo-mismatch:** location field says remote, but JD body says') &&
  ofertaMode.includes('silence is absence of signal, not agreement')
) {
  pass('oferta cross-checks the remote location field against JD-body signals (#1433)');
} else {
  fail('oferta missing geo-mismatch cross-check of location field vs JD body (#1433)');
}

if (
  ofertaMode.includes('### Work-authorization check') &&
  ofertaMode.includes('⛔ **No sponsorship:** JD states "{verbatim JD line}" and role is outside your authorized_in') &&
  ofertaMode.includes('**Work Auth:**') &&
  ofertaMode.includes('this tier is **NEUTRAL**')
) {
  pass('oferta cross-checks visa sponsorship against candidate work authorization');
} else {
  fail('oferta missing work-authorization / visa-sponsorship signal in Block A');
}

// --- Block G agency licensing check (#2037) ---
{
  // 1. Jurisdiction table exists, parses as YAML, and the CA-ON seed is complete
  const alPath = join(ROOT, 'templates', 'agency-licensing.yml');
  if (!existsSync(alPath)) {
    fail('templates/agency-licensing.yml missing (#2037)');
  } else {
    try {
      const { load } = await import('js-yaml');
      const alRaw = readFileSync(alPath, 'utf-8');
      const al = load(alRaw);
      const on = al?.jurisdictions?.['CA-ON'];
      if (
        on &&
        on.licensing_required_for === 'both' &&
        String(on.effective) === '2024-07-01' &&
        typeof on.registry?.url === 'string' && on.registry.url.includes('ontario.ca') &&
        typeof on.registry?.what_it_shows === 'string' && on.registry.what_it_shows.length > 0 &&
        typeof on.legal_basis === 'string' && on.legal_basis.includes('O. Reg. 99/23') &&
        typeof on.client_side_prohibition === 'string' && on.client_side_prohibition.length > 0 &&
        typeof on.penalties === 'string' && on.penalties.length > 0 &&
        typeof on.transitional_notes === 'string' && on.transitional_notes.length > 0 &&
        Array.isArray(on.sources) && on.sources.length > 0 &&
        Boolean(on.as_of)
      ) {
        pass('agency-licensing.yml parses and CA-ON seed carries both-scope licensing, corrected 2024-07-01 effective date, ontario.ca registry, legal basis, client-side prohibition, penalties, transitional notes, sources, as_of (#2037)');
      } else {
        fail('agency-licensing.yml CA-ON seed incomplete — needs licensing_required_for both, effective 2024-07-01 (O. Reg. 339/23 delayed commencement — NOT 2024-01-01), registry.url on ontario.ca with what_it_shows, legal_basis (O. Reg. 99/23), client_side_prohibition, penalties, transitional_notes, sources, as_of (#2037)');
      }
      if (
        alRaw.includes('CONTRIBUTION RULE') &&
        alRaw.includes('NEVER-ASSERT RULE') &&
        alRaw.includes('never a third-party mirror')
      ) {
        pass('agency-licensing.yml header documents the contribution rule, the never-assert rule, and the official-registry-only requirement (#2037)');
      } else {
        fail('agency-licensing.yml header missing the contribution rule, never-assert rule, and/or official-registry-only requirement (#2037)');
      }
    } catch (e) {
      fail(`templates/agency-licensing.yml does not parse as YAML: ${e.message} (#2037)`);
    }
  }

  // 2. oferta.md carries the agency-licensing section with the agency-mediated
  //    trigger, registry pointer, tracker-note suggestion, and role/employer jurisdiction derivation
  const alStart = ofertaMode.indexOf('Agency Licensing Check');
  const alEnd = ofertaMode.indexOf('### Output format:', Math.max(alStart, 0));
  const alSection = alStart >= 0 && alEnd > alStart ? ofertaMode.slice(alStart, alEnd) : '';
  if (
    alSection.includes('templates/agency-licensing.yml') &&
    alSection.includes('agency-mediated') &&
    alSection.includes('"our client"') &&
    alSection.includes('{registry.url}') &&
    alSection.includes('via={Agency}') &&
    alSection.includes('never writes the tracker itself') &&
    alSection.includes("role's stated work location") &&
    alSection.includes('candidate\'s home address does not determine') &&
    alSection.includes('agency based outside Ontario') &&
    alSection.includes('skip this signal silently') &&
    alSection.includes('not legal advice')
  ) {
    pass('oferta Block G agency-licensing signal pins the agency-mediated trigger, registry pointer, via={Agency} tracker-note suggestion, role/employer jurisdiction derivation, Ontario extraterritorial-agency scope, silent skip, and not-legal-advice note (#2037)');
  } else {
    fail('oferta Block G missing/incomplete agency-licensing section — needs table reference, agency-mediated trigger ("our client"), registry pointer, via={Agency} tracker-note suggestion (mode never writes the tracker), role/employer jurisdiction derivation (not candidate residence), Ontario outside-agency scope, silent skip for no-row jurisdictions, and not-legal-advice note (#2037)');
  }

  // 3. Hard-rule pins: the signal never asserts unlicensed status and never
  //    fetches/scrapes the registry (zero-fetch pillar)
  if (
    alSection.includes('never asserts an agency is unlicensed') &&
    alSection.includes('never fetches or scrapes the registry')
  ) {
    pass('oferta agency-licensing signal pins the never-assert-unlicensed and never-fetch/scrape-registry hard rules (#2037)');
  } else {
    fail('oferta agency-licensing signal missing the hard rules — must state it "never asserts an agency is unlicensed" and "never fetches or scrapes the registry" (#2037)');
  }

  // 4. Phrasing discipline holds in the report-facing text: the blockquote
  //    templates the agent renders describe the regime and hand over the
  //    registry link — never accusations about a specific agency. Clause-
  //    directed regex (per #2029/#2031): ban "this/the agency is unlicensed /
  //    operating illegally" patterns while letting regime descriptions
  //    ("Ontario has required ... licences since 2024-07-01") pass.
  const alQuoteLines = alSection.split('\n').filter((l) => l.trimStart().startsWith('>'));
  const alAccusatory = alQuoteLines.filter((l) =>
    /(this|the|that|an?y?)\s+(agency|recruiter|operator)\s+(is|was|are|were)\s+(unlicensed|not\s+licensed|operating\s+(illegally|unlawfully)|breaking\s+the\s+law)/i.test(l)
  );
  if (alSection && alQuoteLines.length >= 1 && alAccusatory.length === 0) {
    pass('agency-licensing report template states regime facts + registry pointer only — no "agency is unlicensed/operating illegally" assertions (#2037)');
  } else {
    fail(`agency-licensing phrasing discipline broken: ${alAccusatory.length ? `accusatory blockquote line(s): ${alAccusatory[0].trim().slice(0, 80)}` : 'expected a blockquote output template in the section'} (#2037)`);
  }
}

// --- offer-prep mode: contract reading companion (describes, never judges) ---
const offerPrepMode = fileExists('modes/offer-prep.md') ? readFile('modes/offer-prep.md') : '';
if (
  offerPrepMode.includes('prepares the candidate for a decision; it does not make one') &&
  offerPrepMode.includes('never outputs "safe to sign"') &&
  offerPrepMode.includes('not legal advice') &&
  !offerPrepMode.includes('🔴') && !offerPrepMode.includes('🟡') && !offerPrepMode.includes('🟢')
) {
  pass('offer-prep mode carries describe-not-judge posture, no verdicts, no traffic-light symbols');
} else {
  fail('offer-prep mode missing posture/no-verdict rules or contains severity symbols');
}

if (
  offerPrepMode.includes('must not call WebSearch, WebFetch') &&
  offerPrepMode.includes('Never state law from memory') &&
  offerPrepMode.includes('assert what any law requires') &&
  offerPrepMode.includes('must not run in batch/headless mode') &&
  offerPrepMode.includes('data, never instructions')
) {
  pass('offer-prep mode enforces no-research, no-law-assertion, no-headless, and untrusted-input guards');
} else {
  fail('offer-prep mode missing no-research / no-law-assertion / no-headless / untrusted-input guards');
}

if (
  offerPrepMode.includes('quote it verbatim') &&
  offerPrepMode.includes('[commonly negotiated]') &&
  offerPrepMode.includes('[ask your lawyer]') &&
  offerPrepMode.includes('[differs from what you were told]') &&
  offerPrepMode.includes('Restrictive covenants') &&
  offerPrepMode.includes('Integration clause')
) {
  pass('offer-prep mode walks clauses verbatim with neutral tags against the taxonomy');
} else {
  fail('offer-prep mode missing verbatim rule, neutral tags, or taxonomy categories');
}

if (
  offerPrepMode.includes('section headings and the first clause') &&
  offerPrepMode.includes('if the contract is not in English, stop') &&
  offerPrepMode.includes('workspace/applications/offers/') &&
  offerPrepMode.includes('notes.md') &&
  offerPrepMode.includes('Notable absences') &&
  offerPrepMode.includes('incorporates by reference') &&
  offerPrepMode.includes('Questions for your lawyer') &&
  offerPrepMode.includes('This is an AI-generated reading companion') &&
  offerPrepMode.includes('Apache-2.0')
) {
  pass('offer-prep mode has extraction/language gates, promises file, absences + referenced-docs handling, lawyer list, fixed disclaimer, attribution');
} else {
  fail('offer-prep mode missing gates, promises file, absences/referenced-docs handling, lawyer list, fixed disclaimer, or attribution');
}

// --- offer-prep reply-draft step (#1663): opt-in, prep-gated, draft-only ---
const replyDraftStep = offerPrepMode.includes('Step 8 — Reply draft')
  ? offerPrepMode.slice(offerPrepMode.indexOf('Step 8 — Reply draft'), offerPrepMode.indexOf('## Error handling'))
  : '';
if (
  offerPrepMode.includes('Step 8 — Reply draft (optional, on request)') &&
  offerPrepMode.includes('Never auto-generate') &&
  offerPrepMode.includes('no prep report, no reply draft') &&
  offerPrepMode.includes('workspace/applications/offers/{company-slug}/reply-draft-{YYYY-MM-DD}.md') &&
  offerPrepMode.includes('trace back to a line in the prep report') &&
  offerPrepMode.includes('Never submit. Never send email. Never click send.') &&
  offerPrepMode.includes('never demands') &&
  offerPrepMode.includes('No legal claims and no cited law in the reply') &&
  offerPrepMode.includes('Before you send') &&
  replyDraftStep.includes('exclusively from the prep report and the current conversation') &&
  !replyDraftStep.includes('in-scope user files')
) {
  pass('offer-prep reply-draft step is opt-in, prep-report-gated, traceable, questions-not-demands, draft-only, law-free, and sourced from prep report + conversation only (#1663)');
} else {
  fail('offer-prep reply-draft step missing (or lost its prep-report gate, reply-draft path, traceability rule, never-send guard, questions-not-demands framing, no-legal-claims rule, checklist, or prep-report+conversation-only source boundary) (#1663)');
}

// --- offer-prep statutory-context notes for restrictive covenants (#2028) ---
{
  // 1. Jurisdiction table exists, parses as YAML, and both seeds are complete
  const rcPath = join(ROOT, 'templates', 'restrictive-covenants.yml');
  const RC_STATUS_ENUM = ['prohibited', 'allowed_with_mandatory_compensation', 'allowed_with_limits', 'common_law_reasonableness'];
  if (!existsSync(rcPath)) {
    fail('templates/restrictive-covenants.yml missing (#2028)');
  } else {
    try {
      const { load } = await import('js-yaml');
      const rcRaw = readFileSync(rcPath, 'utf-8');
      const rc = load(rcRaw);
      const rows = Array.isArray(rc?.covenants) ? rc.covenants : [];
      const completeRow = (r) =>
        r &&
        typeof r.jurisdiction === 'string' &&
        typeof r.jurisdiction_name === 'string' &&
        r.covenant_type === 'non_compete' &&
        RC_STATUS_ENUM.includes(r.status) &&
        Array.isArray(r.exceptions) && r.exceptions.length > 0 &&
        typeof r.effective === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.effective) &&
        typeof r.legal_basis === 'string' && r.legal_basis.length > 0 &&
        Array.isArray(r.sources) && r.sources.length > 0 &&
        typeof r.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.as_of);
      const usCa = rows.find((r) => r?.jurisdiction === 'US-CA');
      const caOn = rows.find((r) => r?.jurisdiction === 'CA-ON');
      if (
        completeRow(usCa) && usCa.status === 'prohibited' &&
        usCa.legal_basis.includes('16600') && usCa.legal_basis.includes('16600.5') &&
        completeRow(caOn) && caOn.status === 'prohibited' &&
        caOn.legal_basis.includes('67.2') && caOn.effective === '2021-10-25' &&
        caOn.exceptions.some((e) => /executive/i.test(e)) &&
        caOn.exceptions.some((e) => /sale/i.test(e))
      ) {
        pass('restrictive-covenants.yml parses; US-CA (§16600/§16600.5) and CA-ON (ESA s.67.2, 2021-10-25) non-compete seeds complete — status enum, exceptions, string dates, legal_basis, sources, as_of (#2028)');
      } else {
        fail('restrictive-covenants.yml seed rows incomplete — need US-CA and CA-ON non_compete rows with prohibited status, exceptions, quoted-string effective/as_of dates, legal_basis, sources (#2028)');
      }
      if (
        rcRaw.includes('CONTRIBUTION RULE') &&
        rcRaw.includes('COVENANT-TYPE DISCIPLINE') &&
        rcRaw.includes('NEVER conflated') &&
        rcRaw.includes('NOT LEGAL ADVICE')
      ) {
        pass('restrictive-covenants.yml header documents the contribution rule, covenant-type discipline, and not-legal-advice boundary (#2028)');
      } else {
        fail('restrictive-covenants.yml header missing the contribution rule, covenant-type (never-conflate) discipline, and/or not-legal-advice note (#2028)');
      }
    } catch (e) {
      fail(`templates/restrictive-covenants.yml does not parse as YAML: ${e.message} (#2028)`);
    }
  }

  // 2. offer-prep carries the statutory-context subsection with both output
  //    integrations (clause-tag note + lawyer question), the covenant-type
  //    discipline, and the never-assert-application hard rule
  const rcStart = offerPrepMode.indexOf('Statutory-context notes for restrictive covenants');
  const rcEnd = offerPrepMode.indexOf('## Step 3', Math.max(rcStart, 0));
  const rcSection = rcStart >= 0 && rcEnd > rcStart ? offerPrepMode.slice(rcStart, rcEnd) : '';
  if (
    rcSection.includes('templates/restrictive-covenants.yml') &&
    rcSection.includes('statutory-context note') &&
    rcSection.includes('Questions for your lawyer') &&
    rcSection.includes('Covenant-type discipline (mandatory)') &&
    rcSection.includes('never conflated') &&
    rcSection.includes('Never assert application (HARD RULE)') &&
    rcSection.includes('cannot self-certify') &&
    rcSection.includes('always a lawyer question') &&
    rcSection.includes('not legal advice') &&
    rcSection.includes('not** online') &&
    rcSection.includes('Render in {language.output}')
  ) {
    pass('offer-prep statutory-context subsection pins table lookup, tag-note + lawyer-question integration, covenant-type discipline, never-assert-application rule, not-legal-advice, no-research reaffirmation, i18n rendering (#2028)');
  } else {
    fail('offer-prep statutory-context subsection missing/incomplete — needs table reference, statutory-context note + lawyer-question integration, covenant-type never-conflate discipline, never-assert-application hard rule, not-legal-advice note, local-lookup-is-not-research clarification, {language.output} rendering (#2028)');
  }

  // 3. Phrasing discipline holds in the report-facing text: the blockquote
  //    template the agent renders may state what a STATUTE says (which
  //    legitimately includes words like "prohibited" or "void" describing
  //    the statute), but must never assert those verdicts about the
  //    candidate's own clause. Only '>' lines (rendered output templates)
  //    are scanned, and only for clause-directed assertions.
  const rcQuoteLines = rcSection.split('\n').filter((l) => l.trimStart().startsWith('>'));
  const rcAssertive = rcQuoteLines.filter((l) =>
    /(this|your|the candidate'?s?) (specific )?(clause|covenant|non-compete) (is|would be|will be) (void|illegal|unenforceable|invalid|prohibited)/i.test(l)
  );
  if (rcSection && rcQuoteLines.length >= 1 && rcAssertive.length === 0) {
    pass('restrictive-covenant statutory-context template states statute facts only — no void/illegal/unenforceable assertions about the candidate\'s clause (#2028)');
  } else {
    fail(`restrictive-covenant phrasing discipline broken: ${rcAssertive.length ? `clause-directed verdict in blockquote: ${rcAssertive[0].trim().slice(0, 80)}` : 'expected a blockquote output template in the section'} (#2028)`);
  }
}

const routerSkill = readFile('.agents/skills/frontrunner/SKILL.md');
if (
  /argument-hint:.*offer-prep/.test(routerSkill) &&
  routerSkill.includes('| `offer-prep` | `offer-prep` |') &&
  routerSkill.includes('/frontrunner offer-prep') &&
  /Applies to:.*`offer-prep`/.test(routerSkill) &&
  !/Do not delegate[^.]*offer-prep/.test(routerSkill)
) {
  pass('router skill registers offer-prep (argument-hint, routing table, menu, standalone list; never subagent-delegated)');
} else {
  fail('router skill missing offer-prep registration (or offer-prep leaked into the subagent-delegated section)');
}

const claudeMdDoc = readFile('CLAUDE.md');
const agentsMdDoc = readFile('AGENTS.md');
if (
  /^@(?:\.\/)?AGENTS\.md/m.test(claudeMdDoc) &&
  agentsMdDoc.includes('`offer-prep`')
) {
  pass('AGENTS.md documents offer-prep and CLAUDE.md imports it');
} else {
  fail('AGENTS.md missing offer-prep mode row or CLAUDE.md is not importing AGENTS.md');
}

const dataContractDoc = readFile('DATA_CONTRACT.md');
const gitignoreDoc = readFile('.gitignore');
const updaterSrc = readFile('update-system.mjs');
if (
  dataContractDoc.includes('workspace/applications/offers/') &&
  dataContractDoc.includes('modes/offer-prep.md') &&
  /^\/workspace\/$/m.test(gitignoreDoc) &&
  updaterSrc.includes("'modes/offer-prep.md'")
) {
  pass('offer-prep registered in data contract, gitignore, and updater manifest');
} else {
  fail('offer-prep missing from data contract / gitignore / SYSTEM_PATHS');
}

if (
  ofertaMode.includes('Company type classification (required)') &&
  ofertaMode.includes('Growth-stage startup / VC-backed startup') &&
  ofertaMode.includes('Early-stage startup / pre-revenue startup') &&
  ofertaMode.includes('Open-source community / education community') &&
  ofertaMode.includes('actual contract / hiring entity') &&
  ofertaMode.includes('default compensation reliability to the conservative canonical tier: `Low`') &&
  ofertaMode.includes('Compensation reliability (required)') &&
  ofertaMode.includes('If no advertised number exists, collapse this section to exactly two concise lines') &&
  ofertaMode.includes('skip component split, detailed market rows, and HR verification questions') &&
  ofertaMode.includes('Advertised range') &&
  ofertaMode.includes('Likely guaranteed base') &&
  ofertaMode.includes('Variable / conditional cash components') &&
  ofertaMode.includes('Expected stable cash') &&
  ofertaMode.includes('Non-cash benefits') &&
  ofertaMode.includes('Required HR verification questions when a salary figure exists') &&
  ofertaMode.includes('Do not present advertised compensation as real take-home pay')
) {
  pass('oferta requires company-type-driven compensation reliability checks');
} else {
  fail('oferta missing durable company-type compensation reliability instructions');
}

if (
  shared.includes('## Company Type and Compensation Reliability') &&
  shared.includes('Company type taxonomy') &&
  shared.includes('Growth-stage startup / VC-backed startup') &&
  shared.includes('Early-stage startup / pre-revenue startup') &&
  shared.includes('Open-source community / education community') &&
  shared.includes('actual contract / hiring entity') &&
  shared.includes('default compensation reliability to the conservative canonical tier: `Low`') &&
  shared.includes('Compensation reliability tiers') &&
  shared.includes('collapse compensation analysis to two concise lines: company type and reliability tier') &&
  shared.includes('advertised range, likely guaranteed base, variable / conditional cash components, expected stable cash, and non-cash benefits') &&
  shared.includes('Never present advertised compensation as real take-home pay')
) {
  pass('_shared.md defines the canonical company-type compensation reliability framework');
} else {
  fail('_shared.md missing canonical company-type compensation reliability framework');
}

const zhShared = readFile('modes/zh/_shared.md');
const zhOferta = readFile('modes/zh/oferta.md');
if (
  zhShared.includes('## 公司类型与薪资可信度') &&
  zhShared.includes('成长期创业公司 / 已融资创业公司') &&
  zhShared.includes('早期初创企业 / 未盈利创业公司') &&
  zhShared.includes('开源社区 / 教育社区') &&
  zhShared.includes('实际合同主体 / 用工主体') &&
  zhShared.includes('薪资可信度默认使用保守的正式等级：`低`') &&
  zhShared.includes('薪资分析压缩为两行：公司类型和薪资可信度') &&
  zhShared.includes('浮动 / 条件性现金组成') &&
  zhOferta.includes('公司类型分类（必填）') &&
  zhOferta.includes('薪资可信度（必填）') &&
  zhOferta.includes('没有任何公开薪资数字，也没有“综合薪资”“底薪+提成”“含绩效”“含全勤”“最高可达”等模糊补偿表述') &&
  zhOferta.includes('JD 未提供薪资 / 补偿信息；跳过薪资组成拆分、详细市场数据表和 HR 核验问题') &&
  zhOferta.includes('出现“综合薪资”“底薪+提成”“含绩效”“含全勤”“最高可达”“上不封顶”等模糊补偿表述时，进入完整薪资可信度路径') &&
  zhOferta.includes('公开薪资区间') &&
  zhOferta.includes('可能的合同固定 base') &&
  zhOferta.includes('浮动 / 条件性现金组成') &&
  zhOferta.includes('非现金福利') &&
  zhOferta.includes('当 JD 明确写出薪资数字，或出现模糊补偿表述时，必须给出 3-6 个 HR 核验问题') &&
  zhOferta.includes('不要把招聘广告薪资当作真实到手')
) {
  pass('Chinese modes include company-type compensation reliability checks');
} else {
  fail('Chinese modes missing company-type compensation reliability checks');
}

const batchPromptDoc = readFile('batch/batch-prompt.md');
if (
  batchPromptDoc.includes('Company type classification (required)') &&
  batchPromptDoc.includes('actual contract / hiring entity') &&
  batchPromptDoc.includes('default compensation reliability to the conservative canonical tier: `Low`') &&
  batchPromptDoc.includes('Compensation reliability (required)') &&
  batchPromptDoc.includes('If no advertised number exists, collapse this section to exactly two concise lines') &&
  batchPromptDoc.includes('skip component split, detailed market rows, and HR verification questions') &&
  batchPromptDoc.includes('Advertised range') &&
  batchPromptDoc.includes('Likely guaranteed base') &&
  batchPromptDoc.includes('Variable / conditional cash components') &&
  batchPromptDoc.includes('Expected stable cash') &&
  batchPromptDoc.includes('Non-cash benefits') &&
  batchPromptDoc.includes('When a salary figure exists, include 3-6 HR verification questions') &&
  batchPromptDoc.includes('Do not present advertised compensation as real take-home pay')
) {
  pass('batch workers inherit company-type compensation reliability checks');
} else {
  fail('batch prompt missing company-type compensation reliability checks');
}

const pipelineMode = readFile('modes/pipeline.md');
if (
  pipelineMode.includes('npm run pipeline') &&
  pipelineMode.includes('src/pipeline/run.mjs') &&
  pipelineMode.includes('workspace/.state/liveness-results.tsv') &&
  pipelineMode.includes('provider APIs') &&
  pipelineMode.includes('Playwright') &&
  pipelineMode.includes('Uncertain liveness results are kept')
) {
  pass('pipeline mode delegates API-first liveness and uncertain-result handling to the canonical pipeline');
} else {
  fail('pipeline mode missing canonical API-first liveness workflow');
}

// --- salary tracking mode wiring (#1656 PR-2) ---
const trackerModeDoc = readFile('modes/tracker.md');
const patternsModeDoc = readFile('modes/patterns.md');
if (
  ofertaMode.includes('Advertised (JD)') &&
  ofertaMode.includes('salary-observations.tsv') &&
  ofertaMode.includes('advertised_comp')
) {
  pass('oferta pins the verbatim advertised figure (Block D first row + advertised_comp) and gates desired observations on an explicit user ask');
} else {
  fail('oferta missing Advertised (JD) row, salary-observations.tsv append rule, or advertised_comp requirement');
}

if (
  trackerModeDoc.includes('salary-observations.tsv') &&
  trackerModeDoc.includes('recruiter-verbal') &&
  trackerModeDoc.includes('src/analysis/salary-gap.mjs')
) {
  pass('tracker appends confirmed actual observations with source tiers and surfaces salary-gap');
} else {
  fail('tracker missing salary observation append (source tiers) or salary-gap mention');
}

if (/## Step 3[\s\S]*?salary-observations\.tsv[\s\S]*?## Step 4/.test(offerPrepMode)) {
  pass('offer-prep Step 3 records the contract/offer-letter actual into the observation log');
} else {
  fail('offer-prep Step 3 missing the salary-observations.tsv append');
}

if (patternsModeDoc.includes('src/analysis/salary-gap.mjs')) {
  pass('patterns mode offers salary-gap as an additional lens');
} else {
  fail('patterns mode missing salary-gap lens mention');
}

if ((batchPromptDoc.match(/advertised_comp/g) || []).length >= 2) {
  pass('batch prompt carries advertised_comp in both Machine Summary fences');
} else {
  fail('batch prompt missing advertised_comp in one or both Machine Summary fences');
}

// ── upskill Learning Plan trust model (#1740, phase 2b) ──
// The learning plan (Step 3) layers web-searched resources onto the phase-1 gap
// heatmap. Its eight trust-model promises are load-bearing: each is frozen here
// so a future edit to modes/upskill.md can't silently drop a guarantee. Match a
// stable keyword phrase per rule, not whole paragraphs.
const upskillModeDoc = readFile('modes/upskill.md');

// The phase-2 "coming later" placeholder must be gone — the plan ships now.
// Reject ANY pending-wording variant about the learning plan (coming later,
// pending, coming soon, not yet, unavailable/not available, TBD, WIP, in
// progress, TODO, ships in phase 2), not just one narrow phrasing, and ALSO
// catch standalone pending-phase wording near the plan (e.g. "phase 2b
// pending", "planned for phase 2b"), so a regressing edit can't reintroduce a
// "not yet" placeholder in either form.
// Scope the negative pending-checks to ONLY the `## Learning Plan` section
// (heading → next `## ` or EOF), so unrelated changelog/example content
// elsewhere in the doc can't falsely trigger a pending failure. The positive
// "section exists" check below still runs against the whole doc.
const upskillLpMatch = upskillModeDoc.match(/^## Learning Plan\b[\s\S]*?(?=^## |(?![\s\S]))/m);
const upskillLpSection = upskillLpMatch ? upskillLpMatch[0] : '';
const upskillLearningPlanPending =
  /learning plan[^\n]*(?:coming|later|pending|soon|todo|phase 2|not yet|not available|unavailable|tbd|wip|in progress)/i.test(upskillLpSection) ||
  /ships in phase 2/i.test(upskillLpSection) ||
  /phase\s*2b?\b[^\n]*(?:pending|coming|planned|later|tbd)/i.test(upskillLpSection) ||
  /(?:pending|planned|upcoming)\b[^\n]*phase\s*2b?/i.test(upskillLpSection);
if (
  !upskillLearningPlanPending &&
  upskillModeDoc.includes('## Learning Plan')
) {
  pass('upskill: learning plan ships (no "phase 2 pending"/"coming later"/TODO placeholder; report template has a Learning Plan section)');
} else {
  fail('upskill: learning plan still marked pending (phase-2/coming-later/TODO variant) or missing the Learning Plan template section');
}

// Rule 1 — search-result-or-nothing grounding + explicit skip on weak/absent search.
if (
  upskillModeDoc.includes('Search-result-or-nothing') &&
  upskillModeDoc.includes('skip the Learning Plan section')
) {
  pass('upskill trust rule 1: resources must come from a web-search result, else skip the section explicitly');
} else {
  fail('upskill trust rule 1 (search-result-or-nothing grounding) missing');
}

// Rule 2 — deterministic degradation: heatmap + Suggested Order still ship without resources.
if (
  upskillModeDoc.includes('Deterministic degradation') &&
  upskillModeDoc.includes('heatmap + Suggested Order still ship')
) {
  pass('upskill trust rule 2: deterministic degradation — heatmap + Suggested Order ship without the plan');
} else {
  fail('upskill trust rule 2 (deterministic degradation) missing');
}

// Rule 3 — ephemeral, non-versioned resources; only gap tiers stable across runs.
if (upskillModeDoc.includes('regenerated fresh every run, never diffed')) {
  pass('upskill trust rule 3: resources are ephemeral (regenerated fresh, never diffed across runs)');
} else {
  fail('upskill trust rule 3 (ephemeral / non-versioned resources) missing');
}

// Rule 4 — write-time URL liveness via the check-liveness pattern; dead links excluded.
if (
  upskillModeDoc.includes('Write-time URL liveness') &&
  upskillModeDoc.includes('src/scan/liveness-core.mjs') &&
  upskillModeDoc.includes('dead links never enter the report')
) {
  pass('upskill trust rule 4: write-time URL liveness via check-liveness pattern; dead links excluded');
} else {
  fail('upskill trust rule 4 (write-time URL liveness) missing');
}

// Rule 5 — hard search budget: 2/gap, ~12/run, include the current year.
if (
  upskillModeDoc.includes('Max 2 searches per gap') &&
  upskillModeDoc.includes('~12 searches per aggregate run') &&
  upskillModeDoc.includes('current year in queries')
) {
  pass('upskill trust rule 5: hard search budget (max 2/gap, ~12/run, current year in queries)');
} else {
  fail('upskill trust rule 5 (hard search budget) missing');
}

// Rule 6 — free-first with explicit failure; never silently substitute a paid resource.
if (
  upskillModeDoc.includes('Free-first with explicit failure') &&
  upskillModeDoc.includes('never silently substitutes a paid resource')
) {
  pass('upskill trust rule 6: free-first with explicit failure (no silent paid substitution)');
} else {
  fail('upskill trust rule 6 (free-first with explicit failure) missing');
}

// Rule 7 — effort estimates only from the resource's own stated length.
if (
  upskillModeDoc.includes("resource's own stated length") &&
  upskillModeDoc.includes('never invented')
) {
  pass('upskill trust rule 7: effort estimates only from the resource\'s own stated length, never invented');
} else {
  fail('upskill trust rule 7 (effort from stated length only) missing');
}

// Rule 8 — scope boundary: link to /frontrunner training; never run training's scoring.
if (
  upskillModeDoc.includes('/frontrunner training {name}') &&
  upskillModeDoc.includes('6-dimension scoring') &&
  upskillModeDoc.includes('`upskill` finds; `training` judges')
) {
  pass('upskill trust rule 8: scope boundary — links to /frontrunner training, never runs training scoring');
} else {
  fail('upskill trust rule 8 (scope boundary: upskill finds, training judges) missing');
}

// --- src\/scan\/company-history.mjs wiring across mode docs (Task 6) ---
const followupModeDoc = readFile('modes/followup.md');

if (
  ofertaMode.includes('src/scan/company-history.mjs') &&
  ofertaMode.includes('Prior-contact FYI') &&
  ofertaMode.includes('Not a legitimacy signal')
) {
  pass('oferta mode wires src/scan/company-history.mjs and keeps the prior-contact FYI out of the legitimacy tier');
} else {
  fail('oferta mode missing src/scan/company-history.mjs reference, the "Prior-contact FYI" block, or the "Not a legitimacy signal" guardrail');
}

// Hygiene must not just be mentioned — it must be documented BEFORE the
// aged-Applied cards are consumed (the documented precedence is the guard
// against drawing conclusions from stale tracker rows). Anchor to the exact
// cue line so an unrelated "hygiene" mention elsewhere cannot satisfy this.
const patternsHygieneIdx = patternsModeDoc.indexOf('Hygiene first, always.');
const patternsAgedIdx = patternsModeDoc.indexOf('aged-Applied');
if (
  patternsModeDoc.includes('src/scan/company-history.mjs') &&
  patternsHygieneIdx !== -1 && patternsAgedIdx !== -1 &&
  patternsHygieneIdx < patternsAgedIdx
) {
  pass('patterns mode adds the company-history lens with hygiene documented before aged-Applied cards');
} else {
  fail('patterns mode missing src/scan/company-history.mjs lens, the "Hygiene first, always." cue, aged-Applied mention, or hygiene-before-aged-Applied ordering');
}

if (followupModeDoc.includes('src/scan/company-history.mjs') && followupModeDoc.includes('silent-on-you')) {
  pass('followup mode references both src/scan/company-history.mjs and the silent-on-you label when setting expectations');
} else {
  fail('followup mode must reference BOTH src/scan/company-history.mjs and silent-on-you');
}

if (trackerModeDoc.includes('src/scan/company-history.mjs') && trackerModeDoc.includes('silent-on-you')) {
  pass('tracker mode offers src/scan/company-history.mjs when a silent-on-you company is present');
} else {
  fail('tracker mode missing src/scan/company-history.mjs reference or the silent-on-you trigger');
}

// Note: Block G's reposting signal in _shared.md/oferta.md is intentionally
// sourced from scan-history.tsv (agent-observable), NOT routed through
// src\/scan\/company-history.mjs — every legitimacy Source must be observable without
// executing a script that could silently fail. See PR #1712 review.

// Funnel-calibration wiring (#status-ledger): the lens must be offered where
// the data lives, and the honesty rules must survive as mode text, not just
// script output.
if (
  patternsModeDoc.includes('funnel-velocity.mjs') &&
  patternsModeDoc.includes('selection-bias') &&
  patternsModeDoc.includes('n=20')
) {
  pass('patterns mode offers the funnel-calibration lens with its honesty rules');
} else {
  fail('patterns mode missing funnel-velocity lens, selection-bias note, or n=20 claim gate');
}

if (
  trackerModeDoc.includes('funnel-velocity.mjs') &&
  trackerModeDoc.includes('set-status.mjs') &&
  trackerModeDoc.includes('--on')
) {
  pass('tracker mode surfaces funnel-velocity and routes status changes through set-status --on');
} else {
  fail('tracker mode missing funnel-velocity mention or set-status/--on routing');
}

if (followupModeDoc.includes('funnel-velocity.mjs') && followupModeDoc.includes('--on')) {
  pass('followup mode cross-references the waiting block and --on event dating');
} else {
  fail('followup mode missing funnel-velocity waiting cross-reference or --on');
}

const applyModeDoc = readFile('modes/apply.md');
if (applyModeDoc.includes('--on YYYY-MM-DD')) {
  pass('apply Step 9 documents --on for backdated submissions');
} else {
  fail('apply mode missing --on backdating hint in Step 9');
}

// ── 9. LOCAL PARSER CONTRACT ────────────────────────────────────
