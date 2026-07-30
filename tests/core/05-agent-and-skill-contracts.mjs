import { execSync, execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, symlinkSync, copyFileSync, lstatSync, readlinkSync, chmodSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pass, fail, warn, run, fileExists, ROOT, NODE, getBash, toBashPath } from '../helpers.mjs';
import { readFile, normalizeEol, readTextLF } from './support.mjs';

const scanScript = readFile('src/scan/scan.mjs');

console.log('\n11. AGENTS.md integrity');

const agents = readFile('AGENTS.md');
const requiredSections = [
  'Data Contract', 'Update Check', 'Ethical Use',
  'Offer Verification', 'Canonical States', 'TSV Format',
  'First Run', 'Onboarding',
];

for (const section of requiredSections) {
  if (agents.includes(section)) {
    pass(`AGENTS.md has section: ${section}`);
  } else {
    fail(`AGENTS.md missing section: ${section}`);
  }
}

// ── 11. CLI WRAPPER FILE INTEGRITY ──────────────────────────

console.log('\n11. CLI wrapper file integrity');

const cliWrappers = ['CLAUDE.md', 'CODEX.md'];
for (const f of cliWrappers) {
  if (!fileExists(f)) {
    fail(`Missing CLI wrapper: ${f}`);
    continue;
  }
  const content = readFile(f);
  if (content.includes('AGENTS.md')) {
    pass(`${f} references AGENTS.md`);
  } else {
    fail(`${f} does NOT reference AGENTS.md`);
  }
}
if (!fileExists('GEMINI.md')) {
  fail('Missing legacy Gemini context guard: GEMINI.md');
} else {
  const geminiContext = readFile('GEMINI.md');
  if (/^@(?:\.\/)?AGENTS\.md/m.test(geminiContext)) {
    fail('GEMINI.md imports AGENTS.md and duplicates Antigravity context');
  } else {
    pass('GEMINI.md is a no-op context guard for Antigravity');
  }
}

const codexWrapper = fileExists('CODEX.md') ? readFile('CODEX.md') : '';
if (/^@(?:\.\/)?AGENTS\.md/m.test(codexWrapper)) {
  pass('CODEX.md imports AGENTS.md as a thin wrapper');
} else {
  fail('CODEX.md is not a thin AGENTS.md wrapper');
}

const codexGuideDoc = fileExists('docs/CODEX.md') ? readFile('docs/CODEX.md') : '';
if (
  /AGENTS\.md/.test(codexGuideDoc) &&
  /CODEX\.md/.test(codexGuideDoc) &&
  /codex exec/.test(codexGuideDoc) &&
  /Codex/i.test(codexGuideDoc)
) {
  pass('docs/CODEX.md is a complete Codex guide');
} else {
  fail('docs/CODEX.md is missing required content');
}

const claudeWrapperLines = readFile('CLAUDE.md').trim().split(/\r?\n/);
const claudeWrapperBody = claudeWrapperLines.slice(1).filter(line => line.trim());
if (
  claudeWrapperLines[0] === '@AGENTS.md' &&
  claudeWrapperBody.length <= 1 &&
  claudeWrapperBody.every(line => { const t = line.trim(); return t.startsWith('<!--') && t.endsWith('-->'); })
) {
  pass('CLAUDE.md is a thin AGENTS.md wrapper (#1088)');
} else {
  fail('CLAUDE.md must contain only @AGENTS.md plus an optional Claude-only placeholder comment (#1088)');
}

const criticalRoutingContracts = [
  ['paste-a-JD auto-pipeline', /Pastes JD or URL\s*\|\s*auto-pipeline/],
  ['PDF mode', /generate CV\/PDF\s*\|\s*`pdf`/i],
  ['language modes_dir override', /language\.modes_dir:\s*modes\/(?:\{lang\}|de)/],
  ['doctor --json onboarding', /node doctor\.mjs --json/],
];
for (const [name, marker] of criticalRoutingContracts) {
  if (marker.test(agents)) pass(`AGENTS.md preserves ${name} routing for Claude`);
  else fail(`AGENTS.md is missing ${name} routing required by the Claude wrapper`);
}
const claudeSkillEntrypoint = readFile('.claude/skills/frontrunner/SKILL.md');
if (/\.agents\/skills\/frontrunner\/SKILL\.md/.test(claudeSkillEntrypoint) || claudeSkillEntrypoint === readFile('.agents/skills/frontrunner/SKILL.md')) {
  pass('Claude skill invocation resolves to the canonical frontrunner router');
} else {
  fail('Claude skill invocation does not resolve to the canonical frontrunner router');
}

// ── 12. SKILL SYMLINK INTEGRITY ─────────────────────────────

console.log('\n12. Skill symlink integrity');

const canonicalSkill = '.agents/skills/frontrunner/SKILL.md';
const symlinks = [
  '.claude/skills/frontrunner/SKILL.md',
  '.antigravitycli/skills/frontrunner/SKILL.md',
];

let canonicalReal = null;
let canonicalContent = null;
try {
  canonicalReal = realpathSync(join(ROOT, canonicalSkill));
  canonicalContent = readFile(canonicalSkill);
  pass(`Canonical skill resolves: ${canonicalSkill}`);
} catch {
  fail(`Canonical skill not found: ${canonicalSkill}`);
}

for (const link of symlinks) {
  let resolved = null;
  try {
    resolved = realpathSync(join(ROOT, link));
    if (resolved !== canonicalReal) {
      const content = readFileSync(resolved, 'utf-8').trim();
      if (content.startsWith('..') && content.split('\n').length === 1) {
        resolved = realpathSync(join(dirname(join(ROOT, link)), content));
      }
    }
  } catch {
    resolved = null;
  }
  if (resolved === null) {
    fail(`Symlink missing: ${link}`);
    continue;
  }
  if (resolved === canonicalReal) {
    pass(`${link} → canonical skill`);
  } else if (canonicalContent !== null && readFile(link) === canonicalContent) {
    pass(`${link} is a materialized copy of canonical skill`);
  } else {
    fail(`${link} resolves to ${resolved}, expected ${canonicalReal} or byte-identical canonical skill copy`);
  }
}

if (
  /Codex/i.test(canonicalContent ?? '') &&
  /`codex`/.test(canonicalContent ?? '') &&
  /`codex exec/.test(canonicalContent ?? '') &&
  /prompt/i.test(canonicalContent ?? '') &&
  /\/frontrunner/.test(canonicalContent ?? '')
) {
  pass('frontrunner skill router documents the Codex invocation model');
} else {
  fail('frontrunner skill router is missing Codex invocation guidance');
}

console.log('\n12c. Codex documentation guidance');

const readmeDoc = readFile('README.md');
if (
  /CODEX\.md/.test(readmeDoc) &&
  /codex exec/.test(readmeDoc) &&
  /Codex/i.test(readmeDoc) &&
  /(slash commands?.*not guaranteed|plain language|prompt)/i.test(readmeDoc)
) {
  pass('README documents CODEX.md and Codex interactive/headless usage');
} else {
  fail('README is missing required Codex usage guidance');
}

const setupDoc = readFile('docs/SETUP.md');
if (
  /codex exec/.test(setupDoc) &&
  /Codex/i.test(setupDoc) &&
  /(slash commands?.*not guaranteed|plain language|prompt)/i.test(setupDoc)
) {
  pass('docs/SETUP.md explains the Codex invocation model');
} else {
  fail('docs/SETUP.md is missing Codex invocation guidance');
}

const agentsDoc = readFile('AGENTS.md');
if (
  /CODEX\.md/.test(agentsDoc) &&
  /codex exec/.test(agentsDoc) &&
  /Codex/i.test(agentsDoc) &&
  /(slash commands?.*not guaranteed|prompt|\/frontrunner.*unavailable)/i.test(agentsDoc)
) {
  pass('AGENTS.md includes CODEX.md and Codex-specific command guidance');
} else {
  fail('AGENTS.md is missing CODEX.md or Codex command guidance');
}

console.log('\n12a. Skill entrypoint materialization');

{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-skills-'));
  try {
    const canonicalDir = join(fixtureRoot, '.agents', 'skills', 'frontrunner');
    const claudeDir = join(fixtureRoot, '.claude', 'skills', 'frontrunner');
    const antigravityDir = join(fixtureRoot, '.antigravitycli', 'skills', 'frontrunner');
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(antigravityDir, { recursive: true });

    const fixtureSkill = '---\nname: frontrunner\n---\n\n# canonical skill\n';
    const pointer = '../../../.agents/skills/frontrunner/SKILL.md';
    writeFileSync(join(canonicalDir, 'SKILL.md'), fixtureSkill);
    writeFileSync(join(claudeDir, 'SKILL.md'), pointer);
    writeFileSync(join(antigravityDir, 'SKILL.md'), pointer);

    const skills = await import(pathToFileURL(join(ROOT, 'src/lib/skill-entrypoints.mjs')).href);
    const materialized = skills.materializeSkillEntrypoints(fixtureRoot).sort();
    const expected = [
      '.antigravitycli/skills/frontrunner/SKILL.md',
      '.claude/skills/frontrunner/SKILL.md',
    ];

    if (JSON.stringify(materialized) === JSON.stringify(expected)) {
      pass('update-system materializes pointer skill entrypoints');
    } else {
      fail(`unexpected materialized skill entrypoints: ${JSON.stringify(materialized)}`);
    }

    const claudeSkill = readFileSync(join(claudeDir, 'SKILL.md'), 'utf-8');
    const antigravitySkill = readFileSync(join(antigravityDir, 'SKILL.md'), 'utf-8');
    if (claudeSkill === fixtureSkill && antigravitySkill === fixtureSkill) {
      pass('materialized skill entrypoints match canonical content');
    } else {
      fail('materialized skill entrypoints do not match canonical content');
    }
  } catch (e) {
    fail(`skill entrypoint materialization test crashed: ${e.message}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// Every CLI skill entrypoint tracked in git MUST also be listed in
// SKILL_ENTRYPOINTS, because that array is the only thing that materializes
// these files on filesystems without symlink support. A tracked-but-unlisted
// entrypoint checks out as a pointer text file on Windows and stays that way:
// the user opens their CLI and the skill is the literal string
// "../../../.agents/skills/frontrunner/SKILL.md". That is bug #1051, and it hit
// a second time because Kimi shipped after the list was written and nobody
// compared the two. Adding a CLI touches five wiring points; this asserts the
// sixth instead of trusting a reviewer to remember it.
console.log('\n12a-bis. Every tracked skill entrypoint is materializable');

{
  try {
    const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf-8' })
      .split('\n')
      .filter((p) => /^\.[^/]+\/skills\/frontrunner\/SKILL\.md$/.test(p))
      .filter((p) => !p.startsWith('.agents/')) // the canonical target, not an entrypoint
      .sort();

    // An empty list means git could not see the tree, not that there is nothing
    // to check (#2240): a guard that cannot look must never pass.
    if (tracked.length === 0) {
      fail('git ls-files returned no skill entrypoints — this check could not inspect anything');
    } else {
      const skills = await import(pathToFileURL(join(ROOT, 'src/lib/skill-entrypoints.mjs')).href);
      const listed = new Set(skills.SKILL_ENTRYPOINTS.map((e) => e.path));
      const unlisted = tracked.filter((p) => !listed.has(p));

      if (unlisted.length === 0) {
        pass(`all ${tracked.length} tracked skill entrypoints are in SKILL_ENTRYPOINTS`);
      } else {
        fail(`skill entrypoint(s) tracked in git but missing from SKILL_ENTRYPOINTS — broken on filesystems without symlinks: ${unlisted.join(', ')}`);
      }
    }
  } catch (e) {
    fail(`skill entrypoint coverage check crashed: ${e.message}`);
  }
}

console.log('\n12b. Skill entrypoint bootstrap (npx / old releases)');

{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-ensure-skills-'));
  try {
    const canonicalDir = join(fixtureRoot, '.agents', 'skills', 'frontrunner');
    const claudeDir = join(fixtureRoot, '.claude', 'skills', 'frontrunner');
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });

    const fixtureSkill = '---\nname: frontrunner\n---\n\n# canonical skill\n';
    const pointer = '../../../.agents/skills/frontrunner/SKILL.md';
    writeFileSync(join(canonicalDir, 'SKILL.md'), fixtureSkill);
    writeFileSync(join(claudeDir, 'SKILL.md'), pointer);

    const skills = await import(pathToFileURL(join(ROOT, 'src/lib/skill-entrypoints.mjs')).href);
    const touched = skills.ensureSkillEntrypoints(fixtureRoot).sort();
    // Derived from SKILL_ENTRYPOINTS, never hand-listed. A literal array here is
    // a second copy of the same list, and a second copy goes stale: adding Kimi
    // to the registry turned this assertion red for the correct behaviour, which
    // teaches whoever hits it to edit the expectation without reading it. The
    // assertion that matters is "bootstraps everything in the registry", and
    // that one holds whatever the registry contains.
    const expectedTouched = skills.SKILL_ENTRYPOINTS.map((e) => e.path).sort();

    if (JSON.stringify(touched) === JSON.stringify(expectedTouched)) {
      pass('ensureSkillEntrypoints bootstraps all CLI skill entrypoints');
    } else {
      fail(`unexpected bootstrapped skill entrypoints: ${JSON.stringify(touched)}`);
    }

    const agSkill = readFileSync(join(fixtureRoot, '.antigravitycli', 'skills', 'frontrunner', 'SKILL.md'), 'utf-8');
    const claudeSkill = readFileSync(join(claudeDir, 'SKILL.md'), 'utf-8');
    if (agSkill === fixtureSkill && claudeSkill === fixtureSkill) {
      pass('ensureSkillEntrypoints materializes canonical skill content');
    } else {
      fail('bootstrapped skill entrypoints do not match canonical content');
    }
  } catch (e) {
    fail(`skill entrypoint bootstrap test crashed: ${e.message}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

{
  // Regression guard for #1245: the self-reexec checkout derives its file list
  // from update-system.mjs's static relative imports, so the parser must catch
  // every relative import/export form and ignore bare/package specifiers.
  try {
    const updater = await import(pathToFileURL(join(ROOT, 'update-system.mjs')).href);
    const sample = [
      "import { a } from './src/lib/skill-entrypoints.mjs';",
      'import b from "../lib/helper.mjs";',
      "export { c } from './sibling.mjs';",
      "import './side-effect.mjs';",
      "import { readFileSync } from 'node:fs';",
      "import yaml from 'js-yaml';",
    ].join('\n');
    const specs = updater.relativeImportSpecifiers(sample).sort();
    const expected = [
      '../lib/helper.mjs',
      './sibling.mjs',
      './side-effect.mjs',
      './src/lib/skill-entrypoints.mjs',
    ];
    if (JSON.stringify(specs) === JSON.stringify(expected)) {
      pass('relativeImportSpecifiers extracts relative imports, ignores bare/package (#1245)');
    } else {
      fail(`relativeImportSpecifiers mismatch: got ${JSON.stringify(specs)}`);
    }

    // #1706: update-system.mjs must be SELF-LOADING — no static (top-level)
    // relative imports. A pre-#1245 client's apply() self-reexec checks out
    // ONLY update-system.mjs before re-execing it, so a static top-level
    // relative import crashes that re-exec with ERR_MODULE_NOT_FOUND on the
    // old→new jump. Relative modules must be pulled in lazily instead. Matched
    // line-anchored (not via relativeImportSpecifiers, whose loose regex also
    // matches such specifiers inside prose/comments) so only real top-level
    // import/export statements count.
    const liveSource = readFileSync(join(ROOT, 'update-system.mjs'), 'utf-8');
    const staticRelativeImport = /^\s*(?:import|export)\b[^\n]*?\bfrom\s*['"]\.[^'"]*['"]|^\s*import\s*['"]\.[^'"]*['"]/m;
    if (!staticRelativeImport.test(liveSource)) {
      pass('update-system.mjs has no static relative imports — self-loading (#1706)');
    } else {
      fail('update-system.mjs has a static relative import that breaks old→new re-exec (#1706)');
    }
  } catch (e) {
    fail(`relativeImportSpecifiers test crashed: ${e.message}`);
  }
}

{
  // #1706 end-to-end regression: reproduce the old→new re-exec by checking out
  // ONLY update-system.mjs into an otherwise-empty dir (no src/lib/) and
  // importing it. Before the lazy-import fix this threw ERR_MODULE_NOT_FOUND at
  // module load; it must now load standalone.
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'frontrunner-updater-standalone-'));
  try {
    const updaterSource = readFileSync(join(ROOT, 'update-system.mjs'), 'utf-8');
    const isolatedUpdater = join(isolatedRoot, 'update-system.mjs');
    writeFileSync(isolatedUpdater, updaterSource);
    try {
      await import(pathToFileURL(isolatedUpdater).href);
      pass('update-system.mjs imports standalone without src/lib/ present (#1706)');
    } catch (err) {
      fail(`update-system.mjs failed to import standalone (old→new re-exec crash, #1706): ${err.code || err.message}`);
    }
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-skills-unreadable-'));
  try {
    const canonicalDir = join(fixtureRoot, '.agents', 'skills', 'frontrunner');
    const claudeDir = join(fixtureRoot, '.claude', 'skills', 'frontrunner');
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });

    const pointer = '../../../.agents/skills/frontrunner/SKILL.md';
    mkdirSync(join(canonicalDir, 'SKILL.md'));
    writeFileSync(join(claudeDir, 'SKILL.md'), pointer);

    const skills = await import(pathToFileURL(join(ROOT, 'src/lib/skill-entrypoints.mjs')).href);
    const materialized = skills.materializeSkillEntrypoints(fixtureRoot);
    const claudeSkill = readFileSync(join(claudeDir, 'SKILL.md'), 'utf-8');
    if (materialized.length === 0 && claudeSkill === pointer) {
      pass('update-system skips skill materialization when canonical entrypoint is unreadable');
    } else {
      fail(`unreadable canonical skill unexpectedly materialized: ${JSON.stringify(materialized)}`);
    }
  } catch (e) {
    fail(`unreadable canonical skill test crashed: ${e.message}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-skills-entry-dir-'));
  try {
    const canonicalDir = join(fixtureRoot, '.agents', 'skills', 'frontrunner');
    const claudeDir = join(fixtureRoot, '.claude', 'skills', 'frontrunner');
    const antigravityDir = join(fixtureRoot, '.antigravitycli', 'skills', 'frontrunner');
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(antigravityDir, { recursive: true });

    const fixtureSkill = '---\nname: frontrunner\n---\n\n# canonical skill\n';
    const pointer = '../../../.agents/skills/frontrunner/SKILL.md';
    writeFileSync(join(canonicalDir, 'SKILL.md'), fixtureSkill);
    mkdirSync(join(claudeDir, 'SKILL.md'));
    writeFileSync(join(antigravityDir, 'SKILL.md'), pointer);

    const skills = await import(pathToFileURL(join(ROOT, 'src/lib/skill-entrypoints.mjs')).href);
    const materialized = skills.materializeSkillEntrypoints(fixtureRoot);
    const antigravitySkill = readFileSync(join(antigravityDir, 'SKILL.md'), 'utf-8');
    if (JSON.stringify(materialized) === JSON.stringify(['.antigravitycli/skills/frontrunner/SKILL.md']) && antigravitySkill === fixtureSkill) {
      pass('update-system skips non-file skill entrypoints while materializing valid pointers');
    } else {
      fail(`non-file skill entrypoint handling was unexpected: ${JSON.stringify(materialized)}`);
    }
  } catch (e) {
    fail(`non-file skill entrypoint test crashed: ${e.message}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

console.log('\n12c. Materialized skill index mode');

{
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'frontrunner-skill-git-'));
  const gitRun = (args, opts = {}) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf-8',
    timeout: 30000,
    ...opts,
  }).trim();
  const gitRaw = (args) => execFileSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf-8',
    timeout: 30000,
  });

  try {
    const canonicalDir = join(fixtureRoot, '.agents', 'skills', 'frontrunner');
    const claudeDir = join(fixtureRoot, '.claude', 'skills', 'frontrunner');
    const antigravityDir = join(fixtureRoot, '.antigravitycli', 'skills', 'frontrunner');
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(antigravityDir, { recursive: true });

    const fixtureSkill = '---\nname: frontrunner\n---\n\n# canonical skill\n';
    const pointer = '../../../.agents/skills/frontrunner/SKILL.md';

    gitRun(['init']);
    gitRun(['config', 'core.symlinks', 'false']);
    gitRun(['config', 'user.email', 'test@example.com']);
    gitRun(['config', 'user.name', 'Test User']);

    writeFileSync(join(canonicalDir, 'SKILL.md'), fixtureSkill);
    writeFileSync(join(claudeDir, 'SKILL.md'), pointer);
    writeFileSync(join(antigravityDir, 'SKILL.md'), pointer);
    gitRun(['add', '--', '.agents/skills/frontrunner/SKILL.md']);

    const pointerBlob = gitRun(['hash-object', '-w', '--stdin'], { input: pointer });
    gitRun(['update-index', '--add', '--cacheinfo', `120000,${pointerBlob},.claude/skills/frontrunner/SKILL.md`]);
    gitRun(['update-index', '--add', '--cacheinfo', `120000,${pointerBlob},.antigravitycli/skills/frontrunner/SKILL.md`]);

    const updater = await import(pathToFileURL(join(ROOT, 'update-system.mjs')).href);
    const skills = await import(pathToFileURL(join(ROOT, 'src/lib/skill-entrypoints.mjs')).href);
    const materialized = skills.materializeSkillEntrypoints(fixtureRoot);
    updater.prepareMaterializedSkillEntrypointsForStage(materialized, fixtureRoot);
    gitRun(['add', '--', '.claude/skills/', '.antigravitycli/skills/']);

    const claudeIndex = gitRun(['ls-files', '-s', '--', '.claude/skills/frontrunner/SKILL.md']);
    const antigravityIndex = gitRun(['ls-files', '-s', '--', '.antigravitycli/skills/frontrunner/SKILL.md']);
    if (claudeIndex.startsWith('100644 ') && antigravityIndex.startsWith('100644 ')) {
      pass('materialized skill entrypoints stage as regular files, not symlink blobs');
    } else {
      fail(`materialized skill entrypoints staged with wrong modes: ${JSON.stringify([claudeIndex, antigravityIndex])}`);
    }

    const claudeBlob = gitRaw(['show', ':.claude/skills/frontrunner/SKILL.md']);
    const antigravityBlob = gitRaw(['show', ':.antigravitycli/skills/frontrunner/SKILL.md']);
    if (claudeBlob === fixtureSkill && antigravityBlob === fixtureSkill) {
      pass('materialized skill blobs contain canonical skill content');
    } else {
      fail('materialized skill blobs do not contain canonical skill content');
    }
  } catch (e) {
    fail(`skill entrypoint index-mode test crashed: ${e.message}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ── 14. VERSION FILE ─────────────────────────────────────────────

console.log('\n14. Version file');

if (fileExists('VERSION')) {
  // Validate the first whitespace-delimited token, mirroring
  // update-system.mjs parseVersionFile(), which tolerates a trailing comment
  // in a VERSION restored from an older backup.
  const version = readFile('VERSION').trim().split(/\s+/)[0];
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    pass(`VERSION is valid semver: ${version}`);
  } else {
    fail(`VERSION is not valid semver: "${version}"`);
  }
} else {
  fail('VERSION file missing');
}

// ── 12. ARCHIVE-POSTING ─────────────────────────────────────────

console.log('\n12. src/scan/archive-posting.mjs');

const todayStr = new Date().toISOString().split('T')[0];

// dry-run: URL-based company detection across each supported ATS
for (const [url, expected] of [
  ['https://boards.greenhouse.io/openai/jobs/123', 'openai'],
  ['https://jobs.ashbyhq.com/ElevenLabs/abc',      'elevenlabs'],
  ['https://jobs.lever.co/retool/xyz',              'retool'],
  ['https://jobs.eu.lever.co/retool-eu/xyz',         'retool-eu'],
]) {
  const out = run(NODE, ['src/scan/archive-posting.mjs', '--dry-run', url]);
  const { hostname } = new URL(url);
  out?.toLowerCase().includes(expected)
    ? pass(`dry-run: company detected from ${hostname}`)
    : fail(`dry-run: company not detected from ${hostname}`);
}

// dry-run: --company / --role overrides win over URL detection
const overrideOut = run(NODE, [
  'src/scan/archive-posting.mjs', '--dry-run',
  'https://jobs.lever.co/retool/xyz', '--company=Acme', '--role=Staff Engineer',
]);
overrideOut?.includes('Acme') && overrideOut?.includes('staff-engineer')
  ? pass('dry-run: --company and --role overrides respected')
  : fail('dry-run: --company / --role overrides not reflected in output');

// dry-run: output always contains a local:workspace/jobs/descriptions/ reference and today's date
const refOut = run(NODE, ['src/scan/archive-posting.mjs', '--dry-run', 'https://boards.greenhouse.io/openai/jobs/123']);
refOut?.includes('local:workspace/jobs/descriptions/') && refOut?.includes(todayStr)
  ? pass('dry-run: local:workspace/jobs/descriptions/ reference and date emitted')
  : fail('dry-run: reference or date missing from output');

// argument validation: no args → shows help, exits 0
run(NODE, ['src/scan/archive-posting.mjs']) !== null
  ? pass('no-args: exits 0 (shows help)')
  : fail('no-args: should exit 0 and print help');

// argument validation: flag without URL → exits non-zero
run(NODE, ['src/scan/archive-posting.mjs', '--dry-run']) === null
  ? pass('flag-without-url: exits non-zero (URL required)')
  : fail('flag-without-url: should exit non-zero when URL is missing');

// argument validation: --company without URL → exits non-zero
run(NODE, ['src/scan/archive-posting.mjs', '--company=Acme']) === null
  ? pass('--company without URL: exits non-zero')
  : fail('--company without URL: should exit non-zero');

// Deterministic render integration: the browser page and PDF bytes are local
// fixtures. This exercises navigation hardening, metadata extraction and the
// crash-safe PDF publisher without depending on Chromium or a live job board.
try {
  const { archiveUrl } = await import(
    `${pathToFileURL(join(ROOT, 'src/scan/archive-posting.mjs')).href}?hermetic-archive=1`
  );
  const fakePdf = Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'ascii'),
    Buffer.alloc(64 * 1024, 0x20),
  ]);
  let closed = false;
  const page = {
    async route() {},
    async goto() { return { status: () => 200 }; },
    async waitForTimeout() {},
    async title() { return 'Staff Engineer at Fixture Co'; },
    async $eval() { return 'Staff Engineer'; },
    async pdf() { return fakePdf; },
    async close() { closed = true; },
    url() { return 'https://93.184.216.34/jobs/fixture'; },
  };
  const result = await archiveUrl(
    { async newPage() { return page; } },
    'https://93.184.216.34/jobs/fixture',
    {
      company: 'Fixture Co',
      role: 'Staff Engineer',
      resolveHostname: async () => ['93.184.216.34'],
    },
  );
  const pdf = join(ROOT, 'workspace', 'jobs', 'descriptions', result.filename);
  const bytes = readFileSync(pdf);
  if (closed && bytes.length === fakePdf.length && bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    pass(`fixture archive: complete PDF published locally (${(bytes.length / 1024).toFixed(0)} KB)`);
  } else {
    fail('fixture archive: page cleanup or published bytes were incomplete');
  }
  unlinkSync(pdf);
} catch (error) {
  fail(`fixture archive failed: ${error.message}`);
}

// ── 13. LOCATION FILTER — always_allow tier ───────────────────────

console.log('\n13. Location filter — always_allow tier');

try {
  const {
    buildLocationFilter,
    locationHintFromUrl,
    buildContentFilter,
    buildPostingAgeFilter,
    buildPostedDateFilter,
    buildVisaFilter,
    buildCountryEligibilityFilter,
    shouldDedupScanHistoryRow,
    formatPipelineOffer,
    formatScanHistoryRow,
  } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);

  // ── posting-age filter (max_posting_age_days) ──
  // Opt-in freshness gate. `now` is injected so the boundary math is deterministic.
  const NOW = Date.parse('2026-07-09T00:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;
  const ageFilter = buildPostingAgeFilter(45, NOW);
  if (
    ageFilter(NOW - 10 * DAY) === true && // fresh → pass
    ageFilter(NOW - 60 * DAY) === false && // older than 45d → skip
    ageFilter(NOW - 45 * DAY) === true && // exactly at the cutoff → kept (>=)
    ageFilter(undefined) === true && // no provider date → pass (don't penalize missing data)
    ageFilter(Number.NaN) === true && // malformed date → pass
    ageFilter('2026-01-01') === true // non-number → pass
  ) {
    pass('posting-age filter skips only dated offers older than N days; missing/invalid dates pass');
  } else {
    fail('posting-age filter did not gate on age / missing-date correctly');
  }
  // Absent or non-positive config → pass-all (opt-in, disabled by default).
  if (
    buildPostingAgeFilter(undefined, NOW)(NOW - 9999 * DAY) === true &&
    buildPostingAgeFilter(0, NOW)(NOW - 9999 * DAY) === true &&
    buildPostingAgeFilter(-5, NOW)(NOW - 9999 * DAY) === true &&
    buildPostingAgeFilter(3.5, NOW)(NOW - 9999 * DAY) === true // non-integer → disabled
  ) {
    pass('posting-age filter is opt-in: absent / 0 / negative / non-integer config disables it');
  } else {
    fail('posting-age filter should be a pass-all no-op when unconfigured or misconfigured');
  }

  // ── absolute posted-date filter (--posted-after / --posted-before) ──
  const JUL17 = Date.parse('2026-07-17T12:00:00Z');
  const JUL18 = Date.parse('2026-07-18T12:00:00Z');
  const JUL20 = Date.parse('2026-07-20T12:00:00Z');
  const JUL21 = Date.parse('2026-07-21T12:00:00Z');
  if (
    buildPostedDateFilter(null, null)(JUL17) === true && // no bounds → pass-all
    buildPostedDateFilter('2026-07-17', '2026-07-20')(JUL18) === true && // inside window
    buildPostedDateFilter('2026-07-17', '2026-07-20')(JUL17) === true && // on the after-bound (inclusive)
    buildPostedDateFilter('2026-07-17', '2026-07-20')(Date.parse('2026-07-20T23:59:59.000Z')) === true && // before-bound is end-of-day inclusive
    buildPostedDateFilter('2026-07-17', '2026-07-20')(JUL21) === false && // after the window
    buildPostedDateFilter('2026-07-18', null)(JUL17) === false && // after-only bound
    buildPostedDateFilter('2026-07-18', null)(JUL20) === true &&
    buildPostedDateFilter(null, '2026-07-18')(JUL20) === false && // before-only bound
    buildPostedDateFilter('2026-07-17', '2026-07-20')(undefined) === true && // no provider date → pass (don't penalize missing data)
    buildPostedDateFilter('2026-07-17', '2026-07-20')(Number.NaN) === true
  ) {
    pass('posted-date filter gates on an absolute after/before window; missing dates always pass');
  } else {
    fail('posted-date filter did not gate on absolute posted-date bounds correctly');
  }

  const filter = buildLocationFilter({
    always_allow: ['belgium', 'brussels'],
    allow: ['europe', 'emea', 'remote'],
    block: ['france', 'germany', 'united states'],
  });

  // Case 1: home-region passes regardless of other text
  if (filter('Brussels, Belgium') === true) pass('Brussels, Belgium passes (always_allow hit)');
  else fail('Brussels, Belgium should pass');

  // Case 2: always_allow wins over block (THE motivating case for this tier)
  if (filter('Remote, Belgium or France') === true) pass('Remote, Belgium or France passes (always_allow beats block)');
  else fail('Remote, Belgium or France should pass — always_allow must win over block');

  // Case 3: no always_allow hit, block still rejects
  if (filter('Paris, France') === false) pass('Paris, France is rejected (block still applies)');
  else fail('Paris, France should be rejected');

  // Case 4: empty location → pass (existing semantics, unchanged)
  if (filter('') === true) pass('empty location passes (unchanged semantics)');
  else fail('empty location should pass');

  // Case 5: case-insensitivity
  if (filter('BRUSSELS, BELGIUM') === true) pass('case-insensitive match works');
  else fail('case-insensitive match failed');

  // Case 6: backward compatibility — no always_allow key behaves like stock allow/block
  const stockFilter = buildLocationFilter({
    allow: ['europe', 'remote'],
    block: ['france'],
  });
  if (stockFilter('Remote, Belgium or France') === false) pass('without always_allow, block still wins (backward compatible)');
  else fail('without always_allow, behaviour must match stock allow/block (block wins)');

  // Case 7: null/missing locationFilter → pass-all filter (early-return path)
  const nullFilter = buildLocationFilter(null);
  if (nullFilter('Anywhere on Earth') === true && nullFilter('') === true) {
    pass('null locationFilter returns a pass-all filter (early-return path)');
  } else {
    fail('null locationFilter should return a pass-all filter');
  }

  // Case 8: string-instead-of-array → wrapped to a 1-item list
  const stringFilter = buildLocationFilter({ always_allow: 'belgium', block: ['france'] });
  if (stringFilter('Remote, Belgium or France') === true) {
    pass('always_allow as a bare string is wrapped to a single-item list');
  } else {
    fail('always_allow as a bare string should still work');
  }

  // Case 9: null/non-string items are filtered out (no crash, no false matches)
  const messyFilter = buildLocationFilter({
    always_allow: [null, 'belgium', 42, undefined],
    block: ['france', null, 7],
  });
  if (messyFilter('Brussels, Belgium') === true && messyFilter('Paris, France') === false) {
    pass('non-string entries (null, numbers, undefined) are filtered out without crashing');
  } else {
    fail('mixed-type keyword lists should not crash and should still match string entries');
  }

  // Case 10: all-null/non-string list → empty after normalization (no false rejects)
  const allBadFilter = buildLocationFilter({ block: [null, 42, undefined], allow: ['remote'] });
  if (allBadFilter('Remote') === true) {
    pass('a block list with only non-string entries normalizes to [] (no false rejects)');
  } else {
    fail('non-string-only block list should not cause rejection');
  }

  // Case 11: empty / whitespace-only entries are dropped (would otherwise pass-all via includes(''))
  const emptyKeywordFilter = buildLocationFilter({
    always_allow: ['', '  '],
    allow: ['remote'],
    block: ['france'],
  });
  if (emptyKeywordFilter('Paris, France') === false) {
    pass('empty/whitespace always_allow entries are dropped (no pass-all via includes(""))');
  } else {
    fail('empty always_allow entries should NOT bypass block — would have made the filter pass-all');
  }

  // Case 12: surrounding whitespace is trimmed so the keyword still matches
  const whitespaceFilter = buildLocationFilter({
    always_allow: ['  Belgium  ', '\tBrussels\n'],
    block: ['france'],
  });
  if (whitespaceFilter('Remote, Belgium or France') === true) {
    pass('whitespace-padded keywords still match after trim');
  } else {
    fail('"  Belgium  " should be trimmed and still match "Remote, Belgium or France"');
  }

  // Case 13: whitespace-only location is treated as missing (pass-all-tiers)
  if (filter('   \t  ') === true) pass('whitespace-only location passes (treated as missing)');
  else fail('whitespace-only location should pass');

  // Case 14: non-string location (number/object/null) → pass without throwing
  let crashed = false;
  try {
    const r1 = filter(42);
    const r2 = filter({ city: 'Brussels' });
    const r3 = filter(null);
    const r4 = filter(undefined);
    if (r1 === true && r2 === true && r3 === true && r4 === true) {
      pass('non-string location values (number, object, null, undefined) pass without throwing');
    } else {
      fail(`non-string location results: number=${r1}, object=${r2}, null=${r3}, undefined=${r4}`);
    }
  } catch (e) {
    crashed = true;
    fail(`non-string location crashed: ${e.message}`);
  }

  // Case 15: a malformed location (e.g. legacy object) does NOT bypass block when interpreted naively —
  // the guard returns true (pass) BEFORE block/allow even run, which is correct: scoring/eval happens
  // downstream from the scan filter, so malformed locations should fall through to the manual evaluation
  // step rather than being silently dropped here.
  if (filter(42) === true) pass('non-string locations are passed through to downstream evaluation, not silently dropped');
  else fail('non-string locations should pass through');

  // Case 16: URL location hint — rolled-up display strings ("5 Locations") hide the
  // real location, which the Workday URL still names. Motivating real case: Kyndryl
  // postings that render as "5 Locations" with a .../job/Hyderabad-Telangana-India/... URL.
  const urlFilter = buildLocationFilter({
    always_allow: ['united states'],
    block: ['india', 'hyderabad', 'germany'],
  });
  if (urlFilter('5 Locations', 'https://kyndryl.wd5.myworkdayjobs.com/careers/job/Hyderabad-Telangana-India/Network-Engineer_R-65193-1') === false) {
    pass('URL hint rejects a rolled-up "5 Locations" row whose canonical URL is India');
  } else {
    fail('"5 Locations" + Hyderabad URL should be rejected via the URL location hint');
  }

  // Case 17: always_allow still wins over a blocked URL hint — a genuinely US role is
  // never dropped because of what its URL happens to contain.
  if (urlFilter('New York, United States', 'https://x.wd5.myworkdayjobs.com/c/job/Hyderabad-Telangana-India/Eng_R1') === true) {
    pass('always_allow on the display string beats a blocked URL hint');
  } else {
    fail('an explicit "United States" location must survive a blocked URL hint');
  }

  // Case 18: providers without the /job/{location}/ convention are unaffected
  if (
    locationHintFromUrl('https://jobs.ashbyhq.com/snowflake/4fe8d816') === '' &&
    locationHintFromUrl('https://boards.greenhouse.io/acme/jobs/12345') === '' &&
    locationHintFromUrl('not a url') === '' &&
    locationHintFromUrl('') === '' &&
    locationHintFromUrl(null) === ''
  ) {
    pass('locationHintFromUrl yields no hint for non-Workday, malformed, and empty URLs');
  } else {
    fail('locationHintFromUrl should return "" for URLs without a /job/{location}/ segment');
  }

  // Case 19: hint normalization — separators become spaces so multi-word keywords match
  if (
    locationHintFromUrl('https://x.wd1.myworkdayjobs.com/c/job/Hyderabad-Telangana-India/Eng_R1') === 'hyderabad telangana india' &&
    locationHintFromUrl('https://x.wd1.myworkdayjobs.com/c/job/USA---El-Segundo-CA/Eng_R1') === 'usa el segundo ca'
  ) {
    pass('URL hint normalizes separators to spaces and lowercases');
  } else {
    fail(`URL hint normalization wrong: got "${locationHintFromUrl('https://x.wd1.myworkdayjobs.com/c/job/Hyderabad-Telangana-India/Eng_R1')}"`);
  }

  // Case 20: omitting the url argument preserves the original location-only behaviour
  if (urlFilter('Bengaluru, India') === false && urlFilter('Austin, TX') === true) {
    pass('calling the filter without a url keeps original location-only semantics');
  } else {
    fail('single-argument calls must behave exactly as before the url-hint change');
  }

  // Case 21: keywords match on word boundaries, not raw substrings. Blocking "india"
  // must NOT reject the US locations Indian Head MD, Indiana, or Indianapolis — the
  // substring bug that silently dropped real US roles from every scan.
  const boundaryFilter = buildLocationFilter({ block: ['india', 'china', 'uk -'] });
  if (
    boundaryFilter('Indian Head, MD') === true &&
    boundaryFilter('Indianapolis, IN') === true &&
    boundaryFilter('West Lafayette, Indiana') === true &&
    boundaryFilter('Chinatown, San Francisco') === true &&
    boundaryFilter('Truck - Depot') === true
  ) {
    pass('block keywords honour word boundaries (Indiana/Indian Head/Indianapolis/Chinatown not rejected)');
  } else {
    fail('word-boundary matching failed — a substring match is silently dropping US locations');
  }

  // Case 22: ...while the genuine country matches still get blocked
  if (
    boundaryFilter('Hyderabad, India') === false &&
    boundaryFilter('India') === false &&
    boundaryFilter('Beijing, China') === false &&
    boundaryFilter('UK - London') === false
  ) {
    pass('word-boundary matching still blocks the real country/region hits');
  } else {
    fail('word-boundary matching must not weaken genuine block hits');
  }

  // Case 23: boundary matching applies to the URL hint too
  if (
    boundaryFilter('5 Locations', 'https://x.wd1.myworkdayjobs.com/c/job/Hyderabad-Telangana-India/Eng_R1') === false &&
    boundaryFilter('5 Locations', 'https://x.wd1.myworkdayjobs.com/c/job/Indianapolis-Indiana/Eng_R1') === true
  ) {
    pass('URL hint is boundary-matched as well (Indianapolis URL survives, India URL does not)');
  } else {
    fail('URL hint must use the same word-boundary matching as the location string');
  }

  if (
    shouldDedupScanHistoryRow({ firstSeen: '2026-06-01', status: 'added' }, { recheckAfterDays: 30, today: '2026-06-10' }) === true &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-05-01', status: 'added' }, { recheckAfterDays: 30, today: '2026-06-10' }) === false &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-02-31', status: 'added' }, { recheckAfterDays: 30, today: '2026-06-10' }) === true &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-05-01', status: 'skipped_blocked_host' }, { recheckAfterDays: 30, today: '2026-06-10' }) === true &&
    shouldDedupScanHistoryRow({ firstSeen: '2026-05-01', status: 'added' }, { today: '2026-06-10' }) === true &&
    scanScript.includes('Recheck eligible:')
  ) {
    pass('scan-history TTL rechecks old added URLs while permanent statuses stay deduped');
  } else {
    fail('scan-history TTL policy did not match expected recheck/permanent behavior');
  }

  const hostileOffer = {
    url: 'https://jobs.example.com/123|evil\nhttps://evil.example/later',
    source: 'local-parser',
    title: 'Senior Engineer | Growth\n- [ ] https://evil.example/job | EvilCorp | Injected',
    company: '=ACME\\Corp\t| R&D',
    location: '@Remote\nEU',
  };
  const pipelineRow = formatPipelineOffer(hostileOffer);
  const pendingLines = pipelineRow.split('\n').filter(line => /^\s*- \[ \] https?:\/\//.test(line));
  const pipelineFields = pipelineRow.split('|').map(part => part.trim());
  if (
    pendingLines.length === 1 &&
    pipelineFields.length === 4 &&
    pipelineFields[0] === '- [ ] https://jobs.example.com/123%7Cevil' &&
    pipelineFields[3] === '@Remote EU' &&
    !pipelineRow.includes('\n') &&
    !pipelineRow.includes('\t') &&
    !pipelineRow.includes('\\|') &&
    pipelineRow.includes('=ACME\\\\Corp / R&D') &&
    pipelineRow.includes('- \\[ \\] https://evil.example/job / EvilCorp / Injected')
  ) {
    pass('scan pipeline writer preserves row shape (optional location 4th col) without injected checkboxes or extra pipes');
  } else {
    fail(`scan pipeline metadata sanitizer produced unsafe row: ${pipelineRow}`);
  }

  const historyRow = formatScanHistoryRow(hostileOffer, '2026-06-18');
  const historyColumns = historyRow.split('\t');
  if (
    historyColumns.length === 12 && // 7 metadata + fingerprint (#1597) + postedAt + trust score/flags (#1743) + normalized_company (#2093)
    historyColumns[8] === '' && // no postedAt on hostileOffer → empty trailing col
    historyColumns[9] === '' && historyColumns[10] === '' && // no trust signal → empty trailing cols
    !historyColumns.some(col => /[\r\n\t]/.test(col)) &&
    historyColumns[0] === 'https://jobs.example.com/123|evil' &&
    historyColumns[3].includes('- [ ] https://evil.example/job') &&
    historyColumns[4] === "'=ACME\\Corp | R&D" &&
    historyColumns[6] === "'@Remote EU"
  ) {
    pass('scan-history writer preserves row shape and neutralizes spreadsheet formulas');
  } else {
    fail(`scan-history metadata sanitizer produced unsafe TSV row: ${JSON.stringify(historyColumns)}`);
  }

  // ── postedAt persistence ──
  // Providers already parse the posting date into `offer.postedAt` (epoch ms).
  // scan-history gets it as a trailing ISO column; pipeline.md gets it as a
  // labeled `posted:` segment. Both are backward-compatible: an offer without a
  // date leaves the column empty / omits the segment (byte-identical output).
  const datedOffer = {
    url: 'https://jobs.example.com/42',
    source: 'greenhouse-api',
    title: 'Staff Engineer',
    company: 'Acme',
    location: 'Remote (US)',
    description: '',
    postedAt: Date.parse('2026-06-18T00:00:00Z'),
  };
  const datedHistory = formatScanHistoryRow(datedOffer, '2026-07-09').split('\t');
  const noDateHistory = formatScanHistoryRow({ ...datedOffer, postedAt: undefined }, '2026-07-09').split('\t');
  if (
    datedHistory.length === 12 &&
    datedHistory[8] === '2026-06-18' && // epoch ms → YYYY-MM-DD in the trailing column
    datedHistory[11] === 'acme' && // normalized company key (#2093), trailing col 12
    noDateHistory.length === 12 &&
    noDateHistory[8] === '' && // missing postedAt → empty trailing column, never a bogus date
    noDateHistory[11] === 'acme'
  ) {
    pass('scan-history writer appends postedAt as an ISO trailing column (empty when absent)');
  } else {
    fail(`scan-history postedAt column wrong: dated=${JSON.stringify(datedHistory)} / noDate=${JSON.stringify(noDateHistory)}`);
  }

  const datedPipeline = formatPipelineOffer(datedOffer);
  const noDatePipeline = formatPipelineOffer({ ...datedOffer, postedAt: undefined });
  const badDatePipeline = formatPipelineOffer({ ...datedOffer, postedAt: -1 });
  const nanDatePipeline = formatPipelineOffer({ ...datedOffer, postedAt: Number.NaN });
  if (
    datedPipeline === '- [ ] https://jobs.example.com/42 | Acme | Staff Engineer | Remote (US) | posted: 2026-06-18' &&
    noDatePipeline === '- [ ] https://jobs.example.com/42 | Acme | Staff Engineer | Remote (US)' &&
    badDatePipeline === noDatePipeline && // negative epoch → no segment (guarded)
    nanDatePipeline === noDatePipeline // NaN → no segment (guarded)
  ) {
    pass('pipeline writer appends a labeled posted: segment (omitted/byte-identical when date missing or invalid)');
  } else {
    fail(`pipeline postedAt segment wrong: dated="${datedPipeline}" / noDate="${noDatePipeline}" / bad="${badDatePipeline}" / nan="${nanDatePipeline}"`);
  }

  // ── trust/legitimacy signal persistence (#1743) ──
  // The scanner computes offer.trustScore/trustFlags on every job; surface it only
  // when flagged (score < 100). scan-history gets trailing score+flags columns
  // (after postedAt); pipeline.md gets a labeled `trust:` segment. Clean/unset
  // trust stays byte-identical (empty column / no segment).
  const trustBase = { url: 'https://jobs.example.com/77', source: 'lever-api', title: 'SRE', company: 'Acme', location: 'Remote', description: '' };
  const flaggedOffer = { ...trustBase, trustScore: 60, trustFlags: ['missing_apply_url', 'suspicious_domain'] };
  const cleanOffer = { ...trustBase, trustScore: 100, trustFlags: [] };
  const untrustedOffer = { ...trustBase }; // no trust fields (trust_filter disabled)
  const flaggedHist = formatScanHistoryRow(flaggedOffer, '2026-07-09').split('\t');
  const cleanHist = formatScanHistoryRow(cleanOffer, '2026-07-09').split('\t');
  if (
    flaggedHist.length === 12 &&
    flaggedHist[9] === '60' && flaggedHist[10] === 'missing_apply_url,suspicious_domain' &&
    flaggedHist[11] === 'acme' && // normalized company key (#2093), after the trust cols
    cleanHist.length === 12 && cleanHist[9] === '' && cleanHist[10] === '' // score 100 → not flagged → empty
  ) {
    pass('scan-history writer appends trust score + flags trailing columns when flagged, empty otherwise (#1743)');
  } else {
    fail(`scan-history trust columns wrong: flagged=${JSON.stringify(flaggedHist)} / clean=${JSON.stringify(cleanHist)}`);
  }

  const flaggedPipeline = formatPipelineOffer(flaggedOffer);
  const cleanPipeline = formatPipelineOffer(cleanOffer);
  const untrustedPipeline = formatPipelineOffer(untrustedOffer);
  const flaggedNoFlags = formatPipelineOffer({ ...trustBase, trustScore: 80, trustFlags: [] });
  const withDateAndTrust = formatPipelineOffer({ ...trustBase, postedAt: Date.parse('2026-06-18T00:00:00Z'), trustScore: 70, trustFlags: ['invalid_url'], note: 'pick' });
  if (
    flaggedPipeline === '- [ ] https://jobs.example.com/77 | Acme | SRE | Remote | trust: 60 missing_apply_url,suspicious_domain' &&
    cleanPipeline === '- [ ] https://jobs.example.com/77 | Acme | SRE | Remote' && // score 100 → no segment
    untrustedPipeline === cleanPipeline && // no trust fields → byte-identical
    flaggedNoFlags === '- [ ] https://jobs.example.com/77 | Acme | SRE | Remote | trust: 80' && // score-only when no flags
    withDateAndTrust === '- [ ] https://jobs.example.com/77 | Acme | SRE | Remote | posted: 2026-06-18 | trust: 70 invalid_url | note: pick' // stable order posted→trust→note
  ) {
    pass('pipeline writer appends a labeled trust: segment ordered posted→trust→note, byte-identical when clean/unset (#1743)');
  } else {
    fail(`pipeline trust segment wrong: flagged="${flaggedPipeline}" / clean="${cleanPipeline}" / untrusted="${untrustedPipeline}" / noFlags="${flaggedNoFlags}" / combo="${withDateAndTrust}"`);
  }

  // ── content_filter (#734) ──
  // Absent config → all jobs pass.
  const noContentFilter = buildContentFilter(null);
  if (noContentFilter('any description') === true && noContentFilter('') === true) {
    pass('content_filter absent → all jobs pass');
  } else {
    fail('content_filter absent should pass all jobs');
  }

  // Empty / missing description always passes (providers without descriptions
  // must never be silently dropped).
  const cf = buildContentFilter({ positive: ['rust'], negative: ['php'] });
  if (cf('') === true && cf('   ') === true && cf(undefined) === true && cf(null) === true && cf(42) === true) {
    pass('content_filter passes empty/missing/non-string descriptions');
  } else {
    fail('content_filter should pass empty/missing/non-string descriptions');
  }

  // Negative keyword present → reject (even if a positive also matches).
  if (cf('We build in PHP and Rust') === false && cf('Legacy PHP shop') === false) {
    pass('content_filter rejects descriptions containing a negative keyword');
  } else {
    fail('content_filter should reject negative-keyword descriptions');
  }

  // Positive required when positive list is non-empty.
  if (cf('We write everything in Rust') === true && cf('A Python and Go team') === false) {
    pass('content_filter requires a positive keyword when positives are set');
  } else {
    fail('content_filter should require a positive keyword');
  }

  // Positive empty → pass after clearing negatives.
  const negOnly = buildContentFilter({ negative: ['wordpress'] });
  if (negOnly('Modern TypeScript stack') === true && negOnly('WordPress maintenance') === false) {
    pass('content_filter with only negatives blocks them and passes the rest');
  } else {
    fail('content_filter negative-only behavior wrong');
  }

  // Case-insensitive.
  const caseCf = buildContentFilter({ positive: ['Kubernetes'] });
  if (caseCf('deploys on KUBERNETES daily') === true) {
    pass('content_filter matches case-insensitively');
  } else {
    fail('content_filter should be case-insensitive');
  }

  // ── content_filter.by_title_keyword (#1636) ──
  const { matchedTitleKeywords } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);

  // matchedTitleKeywords returns the raw positive keywords that matched a title.
  const tf = { positive: ['AI Engineer', 'Instructional Designer'] };
  if (
    JSON.stringify(matchedTitleKeywords('Senior AI Engineer', tf)) === JSON.stringify(['AI Engineer']) &&
    matchedTitleKeywords('Instructional Designer II', tf).length === 1 &&
    matchedTitleKeywords('HR Coordinator', tf).length === 0
  ) {
    pass('matchedTitleKeywords returns the title_filter.positive keyword(s) that matched');
  } else {
    fail('matchedTitleKeywords did not return expected matches');
  }

  const scopedCf = buildContentFilter({
    by_title_keyword: {
      'AI Engineer': { positive: ['gpt', 'llm', 'claude'] },
    },
  });

  // A job matched via "AI Engineer" is held to the stricter override — no
  // AI-tool mention in the description → rejected, even with no global positive set.
  if (
    scopedCf('Build internal tools, no ML involved', ['AI Engineer']) === false &&
    scopedCf('Fine-tune LLM pipelines with GPT-4', ['AI Engineer']) === true
  ) {
    pass('content_filter.by_title_keyword applies its stricter rule only to jobs matched via that keyword');
  } else {
    fail('content_filter.by_title_keyword override did not gate AI Engineer jobs correctly');
  }

  // A job matched via a keyword with NO override (e.g. Instructional Designer)
  // must NOT inherit the AI Engineer override — falls back to the global rule
  // (absent here, so it passes).
  if (scopedCf('Designs onboarding curricula', ['Instructional Designer']) === true) {
    pass('content_filter.by_title_keyword does not leak onto unrelated title keywords');
  } else {
    fail('content_filter.by_title_keyword leaked its override onto an unrelated keyword');
  }

  // Global negative still applies as a backstop even when overrides exist,
  // for jobs whose matched keyword has no override entry.
  const scopedCfWithGlobal = buildContentFilter({
    negative: ['wordpress'],
    by_title_keyword: { 'AI Engineer': { positive: ['gpt'] } },
  });
  if (scopedCfWithGlobal('WordPress plugin maintenance', ['Instructional Designer']) === false) {
    pass('content_filter global negative still applies to jobs without a matching override');
  } else {
    fail('content_filter global negative should still gate jobs with no by_title_keyword override');
  }

  // A malformed by_title_keyword (an array instead of an object) must not be
  // silently iterated via Object.entries as if it were a keyed map — it
  // should be treated as absent (no overrides), same as the validator rejects it.
  const arrayGuardCf = buildContentFilter({
    positive: ['rust'],
    by_title_keyword: ['not', 'an', 'object'],
  });
  if (
    arrayGuardCf('We write everything in Rust', ['AI Engineer']) === true &&
    arrayGuardCf('A Python and Go team', ['AI Engineer']) === false
  ) {
    pass('content_filter.by_title_keyword as an array is ignored (falls back to global rule), not silently iterated');
  } else {
    fail('content_filter.by_title_keyword array should be ignored, not treated as a keyed override map');
  }

  // ── visa_filter (US work-authorization sponsorship) ──
  // Absent config (or enabled: false) → all jobs pass.
  const noVisaFilter = buildVisaFilter(null);
  const offVisaFilter = buildVisaFilter({ enabled: false, negative: ['no sponsorship'] });
  if (
    noVisaFilter('no visa sponsorship, must be authorized') === true &&
    noVisaFilter('') === true &&
    offVisaFilter('no sponsorship offered') === true
  ) {
    pass('visa_filter absent or disabled → all jobs pass');
  } else {
    fail('visa_filter absent/disabled should pass all jobs');
  }

  // Default mode (require_mention: false): drop only explicit rejections,
  // keep everything else — including jobs with no description.
  const visa = buildVisaFilter({ enabled: true });
  if (
    visa('We are unable to sponsor visas for this role') === false &&
    visa('This role does not offer visa sponsorship') === false &&
    visa('Applicants must be authorized to work with no sponsorship') === false
  ) {
    pass('visa_filter rejects postings that explicitly refuse sponsorship');
  } else {
    fail('visa_filter should reject explicit no-sponsorship postings');
  }
  if (
    visa('We happily provide visa sponsorship including H-1B') === true &&
    visa('A generic engineering role with a collaborative team') === true &&
    visa('') === true &&
    visa(undefined) === true
  ) {
    pass('visa_filter default keeps sponsoring and unstated postings');
  } else {
    fail('visa_filter default should keep sponsoring and unstated postings');
  }

  // Strict mode (require_mention: true): keep only postings that advertise
  // sponsorship; unstated / missing descriptions are rejected.
  const strictVisa = buildVisaFilter({ enabled: true, require_mention: true });
  if (
    strictVisa('We sponsor H1B1 and H-1B candidates') === true &&
    strictVisa('Relocation and visa sponsorship provided') === true
  ) {
    pass('visa_filter strict keeps postings that advertise sponsorship');
  } else {
    fail('visa_filter strict should keep sponsoring postings');
  }
  if (
    strictVisa('A generic engineering role with a collaborative team') === false &&
    strictVisa('') === false &&
    strictVisa(null) === false &&
    strictVisa('no visa sponsorship available') === false
  ) {
    pass('visa_filter strict drops unstated, empty, and no-sponsorship postings');
  } else {
    fail('visa_filter strict should drop unstated/empty/no-sponsorship postings');
  }

  // Custom keyword lists override the built-in defaults.
  const customVisa = buildVisaFilter({ enabled: true, require_mention: true, positive: ['tier 2 sponsorship'] });
  if (
    customVisa('We hold a Tier 2 sponsorship licence') === true &&
    customVisa('We sponsor H-1B visas') === false
  ) {
    pass('visa_filter honors custom positive keyword lists over defaults');
  } else {
    fail('visa_filter should honor custom positive keyword lists');
  }

  // ── country_eligibility_filter (#2093) ──
  // Absent config → all jobs pass, regardless of candidate country.
  const noCountryFilter = buildCountryEligibilityFilter(null, 'Canada');
  if (
    noCountryFilter('Must be located in the United States') === true &&
    noCountryFilter('') === true
  ) {
    pass('country_eligibility_filter absent config → all jobs pass');
  } else {
    fail('country_eligibility_filter absent config should pass all jobs');
  }

  const countryCfg = {
    exclusionary: ['must be located in the united states', 'us-based candidates only'],
    inclusive: ['united states or canada', 'north america'],
  };

  // Missing / empty description → pass (no signal to act on).
  const caFilter = buildCountryEligibilityFilter(countryCfg, 'Canada');
  if (
    caFilter('') === true &&
    caFilter(undefined) === true &&
    caFilter(null) === true
  ) {
    pass('country_eligibility_filter passes jobs with no description text');
  } else {
    fail('country_eligibility_filter should pass jobs with no description text');
  }

  // Ambiguous text (no exclusionary or inclusive phrase) → pass unchanged.
  if (caFilter('A generic remote engineering role with a collaborative team') === true) {
    pass('country_eligibility_filter passes ambiguous text with no matched phrases');
  } else {
    fail('country_eligibility_filter should pass ambiguous text unchanged');
  }

  // Exclusionary phrase matched, no inclusive phrase, candidate's own
  // country ("Canada") not named anywhere → rejected.
  if (caFilter('This role is open only to US-based candidates only.') === false) {
    pass('country_eligibility_filter rejects an exclusionary-only US posting for a Canadian candidate');
  } else {
    fail('country_eligibility_filter should reject exclusionary-only postings for a non-US candidate');
  }

  // Exclusionary phrase matched, but an inclusive phrase widens eligibility → pass.
  if (caFilter('Must be located in the United States or Canada to apply.') === true) {
    pass('country_eligibility_filter passes when an inclusive phrase widens eligibility');
  } else {
    fail('country_eligibility_filter should pass when an inclusive phrase is also present');
  }

  // Exclusionary phrase matched, candidate's own country literally named
  // elsewhere in the text (even without a configured "inclusive" phrase) → pass.
  if (caFilter('US-based candidates only. Note: our Canada office handles onboarding.') === true) {
    pass('country_eligibility_filter passes when the candidate\'s own country is literally named in the text');
  } else {
    fail('country_eligibility_filter should pass when the candidate\'s own country is named in the text');
  }

  // Candidate's own location.country is "United States" → filter no-ops
  // entirely, even against an explicit US-only exclusionary phrase.
  const usFilter = buildCountryEligibilityFilter(countryCfg, 'United States');
  if (
    usFilter('US-based candidates only, no exceptions.') === true &&
    usFilter('Must be located in the United States') === true
  ) {
    pass('country_eligibility_filter no-ops for a candidate whose own country is United States');
  } else {
    fail('country_eligibility_filter should no-op entirely for a US-based candidate');
  }

} catch (e) {
  fail(`always_allow tests crashed: ${e.message}`);
}

// ── 11b. TITLE FILTER — acronym word boundaries ──────────────────
console.log('\n11b. Title filter — acronym word boundaries');
try {
  const { buildTitleFilter, compileKeyword } = await import(pathToFileURL(join(ROOT, 'src/scan/scan.mjs')).href);

  // Short all-letter acronyms match on WORD BOUNDARIES, not as substrings.
  const cooFilter = buildTitleFilter({ positive: ['coo'] });
  if (cooFilter('Chief Operating Officer (COO)') === true) pass('"COO" positive matches the standalone token in a title');
  else fail('"COO" should match a title containing the standalone token COO');
  if (cooFilter('Sales Coordinator') === false) pass('"COO" positive does NOT match "Coordinator" (no mid-word match)');
  else fail('"COO" must not match "Coordinator"');

  // An acronym used as a NEGATIVE keyword must not knock out an unrelated word.
  const negFilter = buildTitleFilter({ positive: [], negative: ['coo'] });
  if (negFilter('Marketing Coordinator') === true) pass('negative "COO" does not reject "Coordinator"');
  else fail('negative "COO" wrongly rejected "Coordinator"');
  if (negFilter('Group COO') === false) pass('negative "COO" still rejects a standalone "COO" title');
  else fail('negative "COO" should reject "Group COO"');

  // Multi-word phrases and non-letter keywords keep permissive substring matching.
  const phraseFilter = buildTitleFilter({ positive: ['head of'] });
  if (phraseFilter('Head of Finance & Strategy') === true) pass('multi-word "head of" still matches by substring');
  else fail('"head of" should substring-match "Head of Finance & Strategy"');

  // compileKeyword is exported and directly testable.
  if (compileKeyword('cfo')('group cfo, emea') === true && compileKeyword('cfo')('cfom') === false) {
    pass('compileKeyword("cfo") is word-boundary anchored');
  } else {
    fail('compileKeyword("cfo") boundary behavior wrong');
  }

  // A malformed title_filter (null / numeric / empty entries) must not crash.
  const messyFilter = buildTitleFilter({ positive: ['cfo', null, 123, '', 'head of'] });
  if (messyFilter('Group CFO') === true && messyFilter('Marketing Coordinator') === false) {
    pass('buildTitleFilter ignores non-string/empty keyword entries without crashing');
  } else {
    fail('buildTitleFilter should ignore non-string/empty keyword entries');
  }

  // Whitespace-only keywords must be trimmed away, not compiled into matchers.
  // A bare-spaces negative keyword would otherwise reject any title containing
  // a run of spaces (e.g. "   " matches "Senior   Engineer" via includes()).
  const wsNegFilter = buildTitleFilter({ positive: [], negative: ['   '] });
  if (wsNegFilter('Senior   Engineer') === true) {
    pass('buildTitleFilter drops whitespace-only keywords instead of matching on spaces');
  } else {
    fail('buildTitleFilter should drop whitespace-only keywords');
  }
} catch (e) {
  fail(`title filter acronym tests crashed: ${e.message}`);
}

// ── 12. FOLLOW-UP CADENCE LOGIC ─────────────────────────────────
