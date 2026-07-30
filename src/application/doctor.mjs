#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for frontrunner
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '#paths';
import {
  createFileExclusive,
  ensureDirectoryProtected,
} from '../lib/locked-file.mjs';
import { resolveExtractorMode } from '../scan/browser-extract.mjs';

const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const projectRoot =
  targetIdx !== -1 && argv[targetIdx + 1] ? argv[targetIdx + 1] : ROOT;
const JSON_OUT = argv.includes('--json');
// --strict adds a live ATS-slug probe of workspace/search/portals.yml (network). Opt-in so the
// default `npm run doctor` stays fast and fully offline.
const STRICT = argv.includes('--strict');

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

function checkNodeVersion() {
  const versionStr = process.versions.node;
  const [major, minor] = versionStr.split('.').map(Number);
  const hasSqlite = major > 22 || (major === 22 && minor >= 5);

  if (hasSqlite) {
    return { pass: true, label: `Node.js >= 22.5.0 (v${versionStr})` };
  }

  return {
    pass: false,
    label: `Node.js >= 22.5.0 (found v${versionStr})`,
    fix: 'Install Node.js 22.5.0 or later from https://nodejs.org',
  };
}

function checkDependencies() {
  if (existsSync(join(projectRoot, 'node_modules'))) {
    return { pass: true, label: 'Dependencies installed' };
  }
  return {
    pass: false,
    label: 'Dependencies not installed',
    fix: 'Run: npm ci',
  };
}

async function checkPlaywright() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npm run browser:install',
    };
  }
  // Validate by launching — chromium.executablePath() points at Chrome for Testing
  // (full binary) but chromium.launch() may use the headless-shell binary, which
  // lives at a different path and requires a separate install. Launching directly
  // tests the exact binary the runtime uses and catches stub-installs (directory
  // present but no binary — just ABOUT + LICENSE files).
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    return { pass: true, label: 'Playwright chromium installed' };
  } catch {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npm run browser:install',
    };
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
  }
}

// The browser tools (`browser_navigate` / `browser_snapshot`) that scan / pipeline /
// apply rely on are provided by the Playwright MCP server, usually registered through a
// project-level MCP config (for example `.mcp.json`, `.claude/settings.json`, or
// `.claude/settings.local.json`). When no common config is detected, SPA job boards can
// silently return empty or stale content (#522), so doctor surfaces a non-fatal warning
// instead of letting it fail invisibly.
const PLAYWRIGHT_MCP_WARNING = 'Playwright MCP tools not detected';

function playwrightMcpConfigured(root) {
  const configFiles = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'];
  for (const rel of configFiles) {
    const file = join(root, ...rel.split('/'));
    if (!existsSync(file)) continue;
    try {
      const servers = JSON.parse(readFileSync(file, 'utf8'))?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const server of Object.values(servers)) {
          if (JSON.stringify(server ?? '').toLowerCase().includes('playwright')) return true;
        }
      }
    } catch {
      // Malformed config — keep scanning the other locations; never crash doctor on it.
    }
  }
  return false;
}

// Report which scan/JD extractor is active (workspace/profile/profile.yml → scan.extractor).
// `mcp` (default) uses the browser MCP; `cli` uses src/scan/browser-extract.mjs. When cli
// is selected but the helper is missing, the modes fall back to MCP — surface
// that as a warning, never a failure.
function checkScanExtractor(root) {
  const mode = resolveExtractorMode(join(root, 'workspace', 'profile', 'profile.yml'));
  if (mode === 'cli') {
    if (existsSync(join(root, 'src/scan/browser-extract.mjs'))) {
      return { pass: true, label: 'Scan extractor: cli (src/scan/browser-extract.mjs)' };
    }
    return {
      warn: true,
      label: 'Scan extractor: cli set, but src/scan/browser-extract.mjs is missing — falls back to MCP',
      fix: ['Restore src/scan/browser-extract.mjs, or set `scan.extractor: mcp` in workspace/profile/profile.yml.'],
    };
  }
  return { pass: true, label: 'Scan extractor: mcp (default)' };
}

function checkPlaywrightMcp(root) {
  if (playwrightMcpConfigured(root)) {
    return { pass: true, label: 'Playwright MCP server configured' };
  }
  return {
    warn: true,
    label: PLAYWRIGHT_MCP_WARNING,
    fix: [
      'Browser-driven JD fetching and liveness checks (scan / pipeline / apply) need the',
      'Playwright MCP server. No project-level MCP config was detected in `.mcp.json`',
      'or `.claude/settings*.json`, so SPA job boards may return empty or stale content.',
      'Tracking: https://github.com/Furls-Digital/frontrunner/issues',
    ],
  };
}

// Single source of truth for the four user-layer prerequisites (the list
// AGENTS.md "First Run" documents). BOTH the human checklist (`checkPrereq`)
// and the machine-readable cold-start state (`onboardingState`) derive from
// THIS array, so they cannot drift. Paths use "/" and are split for join().
const USER_LAYER_PREREQS = [
  {
    path: 'workspace/profile/cv.md',
    fix: [
      'Create workspace/profile/cv.md with your CV in markdown',
      'See docs/examples/ for reference CVs',
    ],
  },
  {
    path: 'workspace/profile/profile.yml',
    fix: [
      'Run: cp config/profile.example.yml workspace/profile/profile.yml',
      'Then edit it with your details',
    ],
  },
  {
    path: 'workspace/profile/targeting.md',
    fix: [
      'Run: cp modes/_profile.template.md workspace/profile/targeting.md',
      'Then customize your archetypes / targeting narrative',
    ],
  },
  {
    path: 'workspace/search/portals.yml',
    fix: [
      'Run: cp templates/portals.example.yml workspace/search/portals.yml',
      'Then customize with your target companies',
    ],
  },
];

function prereqPresent(root, path) {
  return existsSync(join(root, ...path.split('/')));
}

function checkPrereq({ path, fix }) {
  if (prereqPresent(projectRoot, path)) {
    return { pass: true, label: `${path} found` };
  }
  return { warn: true, label: `${path} not found (user setup required)`, fix };
}

function checkFonts() {
  const fontsDir = join(projectRoot, 'templates', 'fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      label: 'templates/fonts/ directory not found',
      fix: 'The templates/fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        label: 'templates/fonts/ directory is empty',
        fix: 'The templates/fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      label: 'templates/fonts/ directory not readable',
      fix: 'Check permissions on the templates/fonts/ directory',
    };
  }
  return { pass: true, label: 'Fonts directory ready' };
}

function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${name}/ directory ready` };
  }
  try {
    ensureDirectoryProtected(dirPath);
    return { pass: true, label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

// --strict only: probe the ATS slug of every tracked company in workspace/search/portals.yml so
// a typo'd slug (which 404s silently on scans) surfaces here. Skipped gracefully
// when workspace/search/portals.yml is absent. Delegates to src/scan/verify-portals.mjs so there is one
// slug-probing implementation. Network-bound, hence opt-in.
async function checkPortalSlugs(root) {
  const portalsPath = join(root, 'workspace/search/portals.yml');
  if (!existsSync(portalsPath)) {
    return { pass: true, label: 'ATS slugs: no workspace/search/portals.yml yet (skipped)' };
  }
  try {
    const { verifyPortalsFile } = await import('../scan/verify-portals.mjs');
    const { results } = await verifyPortalsFile(portalsPath);
    const unresolved = results.filter((r) => r.status === 'missing');
    if (unresolved.length === 0) {
      return { pass: true, label: 'All ATS slugs in workspace/search/portals.yml resolve' };
    }
    return {
      pass: false,
      label: `${unresolved.length} ATS slug(s) in workspace/search/portals.yml do not resolve`,
      fix: [
        ...unresolved.map((r) => {
          let line = `${r.name}: ${r.ats || '?'}/${r.slug || '?'} — ${r.reason || 'unresolved'}`;
          if (r.suggested) line += ` → try ${r.suggested.ats}/${r.suggested.slug}`;
          return line;
        }),
        'Probe variants with: node src/scan/verify-portals.mjs --add "<company>"',
      ],
    };
  } catch (err) {
    return { warn: true, label: `ATS slug check skipped: ${err.message}` };
  }
}

const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/frontrunner pipeline\`.

## Pending

## Processed
`;

function checkPipelineFile() {
  const filePath = join(projectRoot, 'workspace', 'search', 'pipeline.md');
  if (existsSync(filePath)) {
    return { pass: true, label: 'workspace/search/pipeline.md ready' };
  }
  try {
    createFileExclusive(filePath, PIPELINE_SKELETON);
    return { pass: true, label: 'workspace/search/pipeline.md ready (auto-created)' };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return { pass: true, label: 'workspace/search/pipeline.md ready' };
    }
    return {
      pass: false,
      label: 'workspace/search/pipeline.md could not be created',
      fix: 'Run: mkdir -p workspace/search && touch workspace/search/pipeline.md',
    };
  }
}

async function main() {
  console.log('\nfrontrunner doctor');
  console.log('================\n');

  const checks = [
    checkNodeVersion(),
    checkDependencies(),
    await checkPlaywright(),
    checkPlaywrightMcp(projectRoot),
    checkScanExtractor(projectRoot),
    ...USER_LAYER_PREREQS.map(checkPrereq),
    checkFonts(),
    checkPipelineFile(),
    checkAutoDir('workspace/documents'),
    checkAutoDir('workspace/reports/evaluations'),
  ];

  // Network-bound ATS slug probe — only under --strict.
  if (STRICT) {
    checks.push(await checkPortalSlugs(projectRoot));
  }

  let failures = 0;
  let warnings = 0;

  for (const result of checks) {
    const fixes = Array.isArray(result.fix) ? result.fix : result.fix ? [result.fix] : [];
    if (result.warn) {
      warnings++;
      console.log(`${yellow('⚠')} ${result.label}`);
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    } else if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
    } else {
      failures++;
      console.log(`${red('✗')} ${result.label}`);
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else {
    const warnNote = warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'} — see above)` : '';
    console.log(`Result: All checks passed${warnNote}. You're ready to go! Run \`npm run ui\` or open a supported agent host.`);
    process.exit(0);
  }
}

// Single source of truth for the cold-start state: the same four user-layer
// prerequisites that AGENTS.md "First Run" lists. `--json` turns the trigger into
// a deterministic mechanism the agent runs (instead of re-deriving it from prose),
// and `--target <dir>` lets the test suite point it at a simulated virgin env.
function onboardingState(root) {
  const autoCopied = [];
  const templates = [
    { target: 'workspace/profile/targeting.md', template: 'modes/_profile.template.md' },
    { target: 'workspace/profile/preferences.md', template: 'modes/_custom.template.md' },
  ];
  for (const { target, template } of templates) {
    const targetPath = join(root, ...target.split('/'));
    const templatePath = join(root, ...template.split('/'));
    if (!existsSync(targetPath) && existsSync(templatePath)) {
      try {
        createFileExclusive(targetPath, readFileSync(templatePath));
        autoCopied.push(target);
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        // Gracefully handle read-only filesystems (e.g., CI/CD or containerized environments)
        // by leaving the file uncopied and letting onboardingNeeded/prereq checks handle it.
      }
    }
  }
  const missing = USER_LAYER_PREREQS
    .filter(({ path }) => !prereqPresent(root, path))
    .map(({ path }) => path);
  const warnings = playwrightMcpConfigured(root) ? [] : [PLAYWRIGHT_MCP_WARNING];
  return { onboardingNeeded: missing.length > 0, missing, warnings, autoCopied };
}

if (JSON_OUT) {
  console.log(JSON.stringify(onboardingState(projectRoot)));
  process.exit(0);
} else {
  main().catch((err) => {
    console.error('doctor.mjs failed:', err.message);
    process.exit(1);
  });
}
