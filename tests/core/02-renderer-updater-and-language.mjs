import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pass, fail, warn, run, fileExists, ROOT, NODE, getBash, toBashPath } from '../helpers.mjs';
import { readFile, normalizeEol, readTextLF } from './support.mjs';

console.log('\n7b. PDF render wait condition');

const generatePdfScript = readFile('src/cv/generate-pdf.mjs');
if (/waitUntil:\s*['"]load['"]/.test(generatePdfScript)) {
  pass('generate-pdf waits for load before rendering');
} else {
  fail('generate-pdf does not wait for load before rendering');
}
if (!/waitUntil:\s*['"]networkidle['"]/.test(generatePdfScript)) {
  pass('generate-pdf does not wait for networkidle');
} else {
  fail('generate-pdf still waits for networkidle');
}

function extractRenderHtmlToPdfOptions(source) {
  const call = /renderHtmlToPdf\s*\(\s*html\s*,\s*outputPath\s*,/g.exec(source);
  if (!call) return '';
  const objectStart = source.indexOf('{', call.index + call[0].length);
  if (objectStart === -1) return '';

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = objectStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(objectStart + 1, i);
    }
  }
  return '';
}

const renderHtmlToPdfOptions = extractRenderHtmlToPdfOptions(generatePdfScript);
if (renderHtmlToPdfOptions && /\breportNum\b/.test(renderHtmlToPdfOptions) && /\binputPath\b/.test(renderHtmlToPdfOptions)) {
  pass('generate-pdf threads reportNum/inputPath into renderHtmlToPdf');
} else {
  fail('generate-pdf does not pass reportNum/inputPath into renderHtmlToPdf');
}
const nestedRenderOptions = extractRenderHtmlToPdfOptions('return renderHtmlToPdf(html, outputPath, { format, metadata: { reportNum, inputPath } });');
if (/\breportNum\b/.test(nestedRenderOptions) && /\binputPath\b/.test(nestedRenderOptions)) {
  pass('generate-pdf renderHtmlToPdf option matcher handles nested object literals');
} else {
  fail('generate-pdf renderHtmlToPdf option matcher fails on nested object literals');
}
if (generatePdfScript.includes('opts.reportNum') && generatePdfScript.includes('opts.inputPath')) {
  pass('renderHtmlToPdf reads manifest metadata from opts');
} else {
  fail('renderHtmlToPdf does not read manifest metadata from opts');
}

if (generatePdfScript.includes('--allow-reorder')) {
  pass('generate-pdf documents --allow-reorder in its usage strings');
} else {
  fail('generate-pdf is missing --allow-reorder from its usage strings');
}

try {
  const { validateCvSectionOrder } = await import(pathToFileURL(join(ROOT, 'src/cv/generate-pdf.mjs')).href);
  const cvMarkdown = '# Education\ntext\n# Work Experience\ntext\n# Projects\ntext';
  const reorderedHtml = '<div class="section-title">Projects</div><div class="section-title">Education</div>';

  let threw = false;
  try {
    validateCvSectionOrder(reorderedHtml, cvMarkdown);
  } catch {
    threw = true;
  }
  if (threw) {
    pass('validateCvSectionOrder throws on a reordered CV by default (--allow-reorder unset)');
  } else {
    fail('validateCvSectionOrder should throw by default when section order diverges from workspace/profile/cv.md');
  }

  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  let threwWithFlag = false;
  try {
    validateCvSectionOrder(reorderedHtml, cvMarkdown, { allowReorder: true });
  } catch {
    threwWithFlag = true;
  } finally {
    console.warn = originalWarn;
  }
  if (!threwWithFlag && warned) {
    pass('validateCvSectionOrder({ allowReorder: true }) warns instead of throwing on a reordered CV');
  } else {
    fail('validateCvSectionOrder({ allowReorder: true }) should warn, not throw, and should not silently do neither');
  }
} catch (e) {
  fail(`validateCvSectionOrder allowReorder tests crashed: ${e.message}`);
}
try {
  const { repoRelativeManifestPath, injectPrintPageCss } = await import(pathToFileURL(join(ROOT, 'src/cv/generate-pdf.mjs')).href);
  const insideHtmlPath = join(ROOT, 'templates', 'cv-template.html');
  const outsideHtmlPath = join(dirname(ROOT), 'outside-cv-template.html');

  if (repoRelativeManifestPath(insideHtmlPath) === 'templates/cv-template.html') {
    pass('PDF manifest records repo-local source HTML paths');
  } else {
    fail('PDF manifest does not normalize repo-local source HTML paths');
  }

  if (repoRelativeManifestPath('') === '' && repoRelativeManifestPath(outsideHtmlPath) === '') {
    pass('PDF manifest leaves HTML column blank when source HTML is missing or outside the repo');
  } else {
    fail('PDF manifest mishandles missing or external source HTML paths');
  }

  const injectedPageCss = injectPrintPageCss('<html><head><title>CV</title></head><body></body></html>', 'letter');
  if (
    injectedPageCss.includes('@page { size: Letter; margin: var(--page-margin, 0.6in); }') &&
    injectedPageCss.indexOf('frontrunner-page-setup') < injectedPageCss.indexOf('</head>')
  ) {
    pass('PDF renderer injects CSS page size and margins before rendering');
  } else {
    fail('PDF renderer does not inject CSS page size/margins into the document head');
  }

  const mixedCasePageCss = injectPrintPageCss('<html><head></head><body></body></html>', 'Letter');
  if (mixedCasePageCss.includes('@page { size: Letter; margin: var(--page-margin, 0.6in); }')) {
    pass('PDF renderer treats page format case-insensitively');
  } else {
    fail('PDF renderer falls back to A4 for mixed-case letter format');
  }

  const doctypeNoHead = injectPrintPageCss('<!doctype html><html lang="en"><body></body></html>');
  if (
    doctypeNoHead.startsWith('<!doctype html>') &&
    doctypeNoHead.includes('<html lang="en">\n<head>\n<style id="frontrunner-page-setup">') &&
    doctypeNoHead.indexOf('<head>') < doctypeNoHead.indexOf('<body>')
  ) {
    pass('PDF renderer preserves doctype when injecting page CSS into full HTML without head');
  } else {
    fail('PDF renderer may insert page CSS before doctype for full HTML without head');
  }

  const fragmentPageCss = injectPrintPageCss('<section>CV</section>');
  if (fragmentPageCss.startsWith('<style id="frontrunner-page-setup">')) {
    pass('PDF renderer still prepends page CSS for HTML fragments');
  } else {
    fail('PDF renderer no longer handles HTML fragments with fallback CSS injection');
  }

  if (
    generatePdfScript.includes('preferCSSPageSize: true') &&
    generatePdfScript.includes("right: '0'") &&
    generatePdfScript.includes('injectPrintPageCss(html, format)') &&
    !/page\.pdf\(\{\s*format:/s.test(generatePdfScript)
  ) {
    pass('PDF renderer uses CSS @page margins instead of Playwright margins');
  } else {
    fail('PDF renderer may clip right-aligned content by ignoring CSS page sizing (#1341)');
  }
} catch (e) {
  fail(`PDF manifest path helper test crashed: ${e.message}`);
}

console.log('\n7b2. PDF renderer temporary-file cleanup');

try {
  const { renderHtmlToPdf } = await import(pathToFileURL(join(ROOT, 'src/cv/generate-pdf.mjs')).href);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-cleanup-launch-'));
  const launchError = new Error('injected browser launch failure');
  let caught;
  try {
    await renderHtmlToPdf('<html><body>PII_MARKER@example.com</body></html>', join(fixtureRoot, 'cv.pdf'), {
      baseDir: fixtureRoot,
      launchBrowser: async () => { throw launchError; },
    });
  } catch (error) {
    caught = error;
  }
  const leftovers = readdirSync(fixtureRoot)
    .filter((name) => name.startsWith('.frontrunner-render-'));
  if (caught === launchError && leftovers.length === 0) {
    pass('PDF renderer removes temporary HTML when Chromium launch fails');
  } else {
    fail(`PDF renderer leaked temporary HTML after launch failure: ${leftovers.join(', ')}`);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
} catch (error) {
  fail(`PDF renderer launch-cleanup test crashed: ${error.message}`);
}

try {
  const { renderHtmlToPdf } = await import(pathToFileURL(join(ROOT, 'src/cv/generate-pdf.mjs')).href);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-pdf-cleanup-page-'));
  const pageError = new Error('injected newPage failure');
  let closeCalls = 0;
  let caught;
  try {
    await renderHtmlToPdf('<html><body>PRIVATE_CV_MARKER</body></html>', join(fixtureRoot, 'cv.pdf'), {
      baseDir: fixtureRoot,
      launchBrowser: async () => ({
        newPage: async () => { throw pageError; },
        close: async () => { closeCalls += 1; },
      }),
    });
  } catch (error) {
    caught = error;
  }
  const leftovers = readdirSync(fixtureRoot)
    .filter((name) => name.startsWith('.frontrunner-render-'));
  if (caught === pageError && closeCalls === 1 && leftovers.length === 0) {
    pass('PDF renderer closes Chromium and removes temporary HTML after launch');
  } else {
    fail(`PDF renderer post-launch cleanup mismatch: close=${closeCalls}, temp=${leftovers.join(', ')}`);
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
} catch (error) {
  fail(`PDF renderer post-launch cleanup test crashed: ${error.message}`);
}

// ── 7c. UPDATER SAFETY ────────────────────────────────────────────

console.log('\n7c. Updater safety');

const updateSystemScript = readFile('update-system.mjs');
if (updateSystemScript.includes("'CODEX.md'")) {
  pass('update-system preserves CODEX.md as a system-layer wrapper');
} else {
  fail('update-system does not preserve CODEX.md');
}

try {
  const {
    NPM_INSTALL_TIMEOUT_MS,
    PLAYWRIGHT_INSTALL_TIMEOUT_MS,
    REEXEC_BUFFER_TIMEOUT_MS,
    UPDATE_PATH_CHECKOUT_BUDGET_MS,
    gitTimeoutMs,
    parsePositiveInt,
    reexecTimeoutMs,
  } = await import(pathToFileURL(join(ROOT, 'update-system.mjs')).href);
  const fetchTimeout = gitTimeoutMs(['fetch']);
  const gitCommandTimeout = gitTimeoutMs(['checkout']);
  const updatePathCount = 100;
  const minimumReexecBudget =
    fetchTimeout +
    gitCommandTimeout * 3 +
    updatePathCount * UPDATE_PATH_CHECKOUT_BUDGET_MS +
    NPM_INSTALL_TIMEOUT_MS +
    PLAYWRIGHT_INSTALL_TIMEOUT_MS +
    REEXEC_BUFFER_TIMEOUT_MS;

  if (parsePositiveInt('42', 7) === 42 && parsePositiveInt('-1', 7) === 7 && parsePositiveInt('nope', 7) === 7) {
    pass('update-system timeout parser accepts only positive integer overrides');
  } else {
    fail('update-system timeout parser does not preserve fallback semantics');
  }

  if (gitTimeoutMs(['fetch']) > gitTimeoutMs(['checkout'])) {
    pass('update-system gives fetch a larger timeout than ordinary git commands');
  } else {
    fail('update-system fetch timeout is not larger than ordinary git command timeout');
  }

  if (reexecTimeoutMs(updatePathCount) >= minimumReexecBudget) {
    pass('update-system sizes self-reexec timeout for downstream fetch/git/install/rebuild work');
  } else {
    fail('update-system self-reexec timeout budget is too small for downstream apply work');
  }
} catch (e) {
  fail(`update-system timeout helper test crashed: ${e.message}`);
}

// ── 7d. OUTPUT LANGUAGE CONTRACT ─────────────────────────────────

console.log('\n7d. Output language contract');

const profileExample = readTextLF('config/profile.example.yml');
const outputLanguageAgentsDoc = readTextLF('AGENTS.md');
const outputLanguageClaudeDoc = readTextLF('CLAUDE.md');
const frontrunnerSkill = readTextLF('.agents/skills/frontrunner/SKILL.md');
const batchPrompt = readTextLF('batch/batch-prompt.md');

if (/language:\s*\n(?:\s*#.*\n)*\s*output:\s*["']?en["']?/.test(profileExample)) {
  pass('profile.example.yml documents language.output default');
} else {
  fail('profile.example.yml is missing language.output default');
}

// Regression guard (#1771): doc assertions must survive CRLF checkouts
// (Windows core.autocrlf=true). Exercises the real read path: a CRLF fixture
// is written to disk and read back through readTextLF, so stripping the
// normalization out of readTextLF fails this check on every platform. The
// fixture lives under ROOT because readFile resolves ROOT-relative paths.
try {
  const crlfGuardTmp = mkdtempSync(join(ROOT, 'crlf-guard-'));
  try {
    writeFileSync(
      join(crlfGuardTmp, 'crlf-fixture.md'),
      'language:\r\n  # Output language for human-facing prose\r\n  output: en\r\n\r\nWrite HTML to `workspace/documents/cv-x.html`\r\n\r\n```bash\r\nnode src\/cv\/generate-pdf.mjs \\\r\n  workspace/documents/cv-x.html \\\r\n  workspace/documents/cv-x.pdf\r\n```\r\n'
    );
    const crlfGuardContent = readTextLF(`${basename(crlfGuardTmp)}/crlf-fixture.md`);
    if (
      !crlfGuardContent.includes('\r') &&
      /language:\s*\n(?:\s*#.*\n)*\s*output:\s*["']?en["']?/.test(crlfGuardContent) &&
      crlfGuardContent.match(/node src\/cv\/generate-pdf\.mjs \\\n\s+([^\s\\]+) \\/)?.[1] === 'workspace/documents/cv-x.html'
    ) {
      pass('doc assertions tolerate CRLF checkouts via readTextLF normalization');
    } else {
      fail('doc assertions break on CRLF checkouts — readTextLF normalization regressed');
    }
  } finally {
    rmSync(crlfGuardTmp, { recursive: true, force: true });
  }
} catch (e) {
  fail(`CRLF regression guard crashed: ${e.message}`);
}

if (
  /language\.output/.test(outputLanguageAgentsDoc) &&
  /human-facing output/i.test(outputLanguageAgentsDoc) &&
  /modes_dir/.test(outputLanguageAgentsDoc)
) {
  pass('AGENTS.md documents output language separately from market modes');
} else {
  fail('AGENTS.md does not document the language.output vs modes_dir contract');
}

const marketModeDocs = [
  ['AGENTS.md', outputLanguageAgentsDoc],
  ['CLAUDE.md', outputLanguageClaudeDoc],
];

const outputRequestSwitchesMarketMode = (text) => text.split('\n').some((line) =>
  /asks? for (German|French|Arabic|Japanese|Turkish) output/i.test(line) &&
  /(?:switch(?:es|ing)?|use|read from)[^\n]*(?:language\.modes_dir|modes\/(?:de|fr|ar|ja|tr))/i.test(line)
);

const validOutputLanguageGuidance = 'If the user asks for French output, set language.output to fr.';
const invalidOutputLanguageGuidance = 'If the user asks for French output, switch to language.modes_dir: modes/fr.';
if (
  !outputRequestSwitchesMarketMode(validOutputLanguageGuidance) &&
  outputRequestSwitchesMarketMode(invalidOutputLanguageGuidance)
) {
  pass('output-language mentions do not imply a market-mode switch');
} else {
  fail('output-language mentions are incorrectly treated as market-mode switches');
}

for (const [docName, docText] of marketModeDocs) {
  if (outputRequestSwitchesMarketMode(docText)) {
    fail(`${docName} treats output-language requests as market-mode selection`);
  } else {
    pass(`${docName} keeps output language separate from market-mode selection`);
  }
}

if (/language\.output/.test(frontrunnerSkill) && /human-facing output/i.test(frontrunnerSkill)) {
  pass('frontrunner skill injects the output language rule');
} else {
  fail('frontrunner skill does not inject the output language rule');
}

if (/Language Rule/i.test(batchPrompt) && /language\.output/.test(batchPrompt) && /write all human-facing output/i.test(batchPrompt)) {
  pass('batch prompt honors language.output for worker prose');
} else {
  fail('batch prompt does not honor language.output for worker prose');
}

const batchEvaluationInputs = batchPrompt.match(/### Step 2 \u2014 Evaluate A-G([\s\S]*?)#### Step 0 \u2014 Archetype Detection/)?.[1] ?? '';
if (/`llms\.txt`/.test(batchEvaluationInputs)) {
  pass('batch evaluation step loads llms.txt');
} else {
  fail('batch evaluation step does not load llms.txt');
}

if (/Canonical base language:\s*English\./.test(batchPrompt)) {
  pass('batch prompt uses an English canonical base');
} else {
  fail('batch prompt canonical base is not English');
}

if (!/Antes de interpretar|clasifica el|salario p\u00fablico|promesa contractual/i.test(batchPrompt)) {
  pass('batch prompt keeps system instructions in its canonical English base');
} else {
  fail('batch prompt contains Spanish system instructions despite its English canonical base');
}

const batchHtmlWritePath = batchPrompt.match(/Write HTML to `([^`]+)`/)?.[1];
const batchPdfInputPath = batchPrompt.match(/node src\/cv\/generate-pdf\.mjs \\\n\s+([^\s\\]+) \\/)?.[1];
if (batchHtmlWritePath && batchHtmlWritePath === batchPdfInputPath) {
  pass('batch prompt renders the HTML path it writes');
} else {
  fail(`batch prompt HTML path mismatch: writes ${batchHtmlWritePath ?? 'unknown'}, renders ${batchPdfInputPath ?? 'unknown'}`);
}

const batchFinalJson = batchPrompt.match(/### Step 6 \u2014 Final JSON([\s\S]*?)\n---/)?.[1] ?? '';
if (
  /JSON\.stringify|JSON serializer/i.test(batchFinalJson) &&
  /"pdf":\s*\{pdf_path_json_string_or_null\}/.test(batchFinalJson) &&
  /dynamic string[\s\S]{0,160}escap/i.test(batchFinalJson)
) {
  pass('batch final JSON preserves native types and escapes dynamic strings');
} else {
  fail('batch final JSON does not require typed, escaped serialization');
}

const batchTrackerStep = batchPrompt.match(/### Step 5 \u2014 Tracker TSV Line[\s\S]*?### Step 6 \u2014 Final JSON/)?.[0] ?? '';
if (/\{\{REPORT_NUM\}\}\\t\{\{DATE\}\}/.test(batchTrackerStep) && !/Compute `\{next_num\}`/.test(batchTrackerStep)) {
  pass('batch workers use the coordinator-reserved tracker number');
} else {
  fail('batch workers still compute tracker numbers independently');
}

const batchMachineSummary = batchPrompt.match(/#### Machine Summary[\s\S]*?### Step 3 \u2014 Save the Report/)?.[0] ?? '';
const patternsMachineFields = readFile('src/analysis/analyze-patterns.mjs').match(/const MACHINE_SUMMARY_FIELDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
if (
  /^via:/m.test(batchMachineSummary) &&
  /^company_confidential:/m.test(batchMachineSummary) &&
  /['"]via['"]/.test(patternsMachineFields) &&
  /['"]company_confidential['"]/.test(patternsMachineFields)
) {
  pass('batch Machine Summary fields are preserved by the downstream parser');
} else {
  fail('batch Machine Summary and downstream parser fields are misaligned');
}

// ── 7e. CV SECTION ORDER CHECK IS LANGUAGE-AWARE ────────────────

// SECTION_ALIASES held English titles only, so a CV rendered in one of the
// shipped non-English modes produced zero sections comparable against the
// English workspace/profile/cv.md: validateCvSectionOrder() saw fewer than two comparable
// sections and early-returned, and the guard silently did nothing. Polish
// (modes/pl) is covered here — a Polish CV that hoisted Education above
// Doświadczenie zawodowe used to render without complaint while the identical
// English CV was correctly rejected.

console.log('\n7e. CV section order check is language-aware');

for (const header of ['podsumowanie zawodowe', 'doświadczenie zawodowe', 'wykształcenie', 'certyfikaty', 'umiejętności']) {
  if (generatePdfScript.includes(`['${header}',`)) {
    pass(`SECTION_ALIASES maps Polish header: ${header}`);
  } else {
    fail(`SECTION_ALIASES missing Polish header: ${header}`);
  }
}

// Playwright is a declared runtime dependency. Missing it is a broken test
// environment, not permission to silently reduce behavioral coverage.
let pdfModule;
try {
  pdfModule = await import(pathToFileURL(join(ROOT, 'src/cv/generate-pdf.mjs')).href);
} catch (e) {
  fail(`Cannot import required src/cv/generate-pdf.mjs dependency: ${e.code || e.message}`);
}

if (pdfModule) {
  const { sectionKey, validateCvSectionOrder } = pdfModule;

  // Canonical keys are language-independent; only the spelling differs.
  const keyCases = [
    ['Podsumowanie zawodowe', 'summary'],
    ['Kompetencje kluczowe', 'competencies'],
    ['Kluczowe kompetencje', 'competencies'], // word-order variant
    ['Doświadczenie zawodowe', 'experience'],
    ['Przebieg kariery', 'experience'],
    ['Wykształcenie', 'education'],
    ['Certyfikaty', 'certifications'],
    ['Umiejętności', 'skills'],
    ['Wyksztalcenie', 'education'],  // diacritics stripped
    ['Umiejetnosci', 'skills'],      // diacritics stripped
    ['Work Experience', 'experience'], // English must be unchanged
    ['Core Competencies', 'competencies'],
  ];
  let keysOk = true;
  for (const [title, expected] of keyCases) {
    const actual = sectionKey(title);
    if (actual !== expected) {
      fail(`sectionKey("${title}") = "${actual}", expected "${expected}"`);
      keysOk = false;
    }
  }
  if (keysOk) pass(`sectionKey resolves all ${keyCases.length} PL/EN heading spellings`);

  // Hermetic workspace/profile/cv.md stand-in: passed in directly, so the test does not depend on
  // a workspace/profile/cv.md existing in the checkout (it is gitignored).
  const cvMd = [
    '# CV', '## Professional Summary', '## Work Experience',
    '## Education', '## Certifications', '## Skills',
  ].join('\n');
  const titlesToHtml = titles => titles.map(t => `<div class="section-title">${t}</div>`).join('\n');

  const plCorrect = titlesToHtml([
    'Podsumowanie zawodowe', 'Kompetencje kluczowe', 'Doświadczenie zawodowe',
    'Wykształcenie', 'Certyfikaty', 'Umiejętności',
  ]);
  // Education hoisted above Work Experience — the divergence the guard exists to catch.
  const plMisordered = titlesToHtml([
    'Podsumowanie zawodowe', 'Wykształcenie', 'Doświadczenie zawodowe',
  ]);
  const enMisordered = titlesToHtml([
    'Professional Summary', 'Education', 'Work Experience',
  ]);

  const throws = (html, opts) => {
    try { validateCvSectionOrder(html, cvMd, opts); return false; } catch { return true; }
  };

  if (throws(plMisordered)) {
    pass('Polish CV with Education before Work Experience is rejected');
  } else {
    fail('Polish CV with Education before Work Experience was NOT rejected (guard is a no-op)');
  }

  if (!throws(plCorrect)) {
    pass('Polish CV in workspace/profile/cv.md order is accepted');
  } else {
    fail('Polish CV in workspace/profile/cv.md order was wrongly rejected');
  }

  if (throws(enMisordered)) {
    pass('English CV order check still rejects divergence (no regression)');
  } else {
    fail('English CV order check regressed');
  }

  // --allow-reorder must keep downgrading the divergence to a warning now that
  // Polish CVs actually reach this code path.
  if (!throws(plMisordered, { allowReorder: true })) {
    pass('allowReorder downgrades Polish divergence to a warning');
  } else {
    fail('allowReorder did not suppress Polish divergence');
  }
}

// ── 8. MODE FILE INTEGRITY ──────────────────────────────────────
