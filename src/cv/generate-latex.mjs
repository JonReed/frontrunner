#!/usr/bin/env node

/**
 * generate-latex.mjs — Validate and compile a generated .tex CV file to PDF
 *
 * Usage:
 *   node src/cv/generate-latex.mjs <input.tex> [output.pdf]
 *   node src/cv/generate-latex.mjs <input.tex> [output.pdf] --compile-only
 *
 * Default: validates frontrunner template structure (from templates/cv-template.tex).
 * --compile-only: skip template validation; compile any user-owned .tex (latex-tex mode).
 *
 * Requires: tectonic (preferred) or pdflatex on PATH.
 */

import { readFile, stat } from 'fs/promises';
import { resolve, basename, dirname, join } from 'path';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { tmpdir } from 'os';
import { replaceFileAtomic } from '../lib/locked-file.mjs';
import { runCheckedSubprocess } from '../security/subprocess.mjs';

const MIN_SECTIONS = 4;

const REQUIRED_COMMANDS = [
  '\\\\resumeSubheading',
  '\\\\resumeItem',
  '\\\\resumeProjectHeading',
];

const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ가-힯ᄀ-ᇿ]/;

/**
 * @param {string} content
 * @param {boolean} compileOnly
 * @returns {{ issues: string[], counts: object }}
 */
export function validateLatexContent(content, compileOnly) {
  const issues = [];
  let resumeItemCount = 0;
  let subheadingCount = 0;
  let projectHeadingCount = 0;

  if (!content.includes('\\begin{document}')) {
    issues.push('Missing \\begin{document}');
  }
  if (!content.includes('\\end{document}')) {
    issues.push('Missing \\end{document}');
  }

  if (compileOnly) {
    return {
      issues,
      counts: { resumeItems: 0, subheadings: 0, projectHeadings: 0 },
    };
  }

  const sectionCount = (content.match(/\\section\{/g) || []).length;
  if (sectionCount < MIN_SECTIONS) {
    issues.push(`Expected at least ${MIN_SECTIONS} \\section{} blocks (Education, Work Experience, Projects, Skills — or localized equivalents), found ${sectionCount}`);
  }

  if (CJK_RE.test(content)) {
    issues.push('CJK characters detected. The LaTeX template does not support Japanese/Chinese/Korean yet (pdfLaTeX setup with no CJK font). Use `pdf` mode (HTML to PDF, which renders CJK) for these CVs.');
  }

  for (const cmd of REQUIRED_COMMANDS) {
    if (!new RegExp(cmd).test(content)) {
      issues.push(`Missing command: ${cmd}`);
    }
  }

  const unresolvedMatch = content.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolvedMatch) {
    issues.push(`Unresolved placeholders: ${[...new Set(unresolvedMatch)].join(', ')}`);
  }

  const lines = content.split('\n');
  for (const line of lines) {
    if (/\\resumeItem\{/.test(line)) resumeItemCount++;
    if (/\\resumeSubheading(?!Continue)/.test(line)) subheadingCount++;
    if (/\\resumeProjectHeading/.test(line)) projectHeadingCount++;
  }

  if (!content.includes('\\pdfgentounicode=1')) {
    issues.push('Missing \\pdfgentounicode=1 (ATS compatibility)');
  }

  return {
    issues,
    counts: {
      resumeItems: resumeItemCount,
      subheadings: subheadingCount,
      projectHeadings: projectHeadingCount,
    },
  };
}

/**
 * @param {string} absPath
 * @param {string} content
 * @param {string|null} outputPath
 * @param {boolean} compileOnly
 * @returns {Promise<object>}
 */
export async function compileLatexFile(absPath, content, outputPath, compileOnly) {
  const { issues, counts } = validateLatexContent(content, compileOnly);
  const fileInfo = await stat(absPath);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  const report = {
    file: basename(absPath),
    path: absPath,
    sizeKB: parseFloat(sizeKB),
    counts,
    issues,
    valid: issues.length === 0,
    compileOnly,
  };

  if (issues.length > 0) {
    return report;
  }

  const texDir = dirname(absPath);
  const texBase = basename(absPath, '.tex');
  const defaultPdf = join(texDir, `${texBase}.pdf`);
  const targetPdf = outputPath ? resolve(outputPath) : defaultPdf;

  let engine = null;
  for (const candidate of ['tectonic', 'pdflatex']) {
    try {
      await runCheckedSubprocess(candidate, ['--version'], {
        timeoutMs: 10_000,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 256 * 1024,
      });
      engine = candidate;
      break;
    } catch { /* not found */ }
  }

  if (!engine) {
    report.compiled = false;
    report.compileError = 'No LaTeX engine found. Install tectonic (brew install tectonic) or pdflatex.';
    return report;
  }

  report.engine = engine;

  // Compilers create PDFs, logs and auxiliary files themselves, outside our
  // JavaScript mutation boundary. Keep every compiler-owned write in a private
  // temporary directory and publish only the finished PDF atomically.
  const compileDir = mkdtempSync(join(tmpdir(), 'frontrunner-latex-'));
  try {
    let compilePath = absPath;
    if (engine === 'tectonic') {
      const patched = content
        .replace(/\\pdfgentounicode\s*=\s*\d+[^\n]*\n?/g, '')
        .replace(/\\input\{glyphtounicode\}[^\n]*\n?/g, '');
      compilePath = join(compileDir, `${texBase}.tex`);
      replaceFileAtomic(compilePath, patched, { mode: 0o600 });
    }

    try {
      if (engine === 'tectonic') {
        await runCheckedSubprocess('tectonic', ['--outdir', compileDir, compilePath], {
          cwd: texDir,
          timeoutMs: 120_000,
          maxStdoutBytes: 2 * 1024 * 1024,
          maxStderrBytes: 2 * 1024 * 1024,
        });
      } else {
        const pdflatexArgs = [
          '-no-shell-escape',
          '-interaction=nonstopmode',
          '-halt-on-error',
          `-output-directory=${compileDir}`,
          absPath,
        ];
        const compileOptions = {
          cwd: texDir,
          timeoutMs: 120_000,
          maxStdoutBytes: 2 * 1024 * 1024,
          maxStderrBytes: 2 * 1024 * 1024,
        };
        await runCheckedSubprocess('pdflatex', pdflatexArgs, compileOptions);
        await runCheckedSubprocess('pdflatex', pdflatexArgs, compileOptions);
      }

      report.compiled = true;
    } catch (err) {
      const logPath = join(compileDir, `${texBase}.log`);
      let latexError = err.message;
      try {
        const log = await readFile(logPath, 'utf-8');
        const errorLines = log.split('\n').filter(l => l.startsWith('!'));
        if (errorLines.length > 0) {
          latexError = errorLines.join('\n');
        }
      } catch { /* no log */ }

      report.compiled = false;
      report.compileError = latexError;
    }

    if (report.compiled) {
      const compiledPdf = join(compileDir, `${texBase}.pdf`);

      try {
        replaceFileAtomic(targetPdf, await readFile(compiledPdf), { mode: 0o600 });

        const pdfStat = await stat(targetPdf);
        report.pdf = {
          path: targetPdf,
          sizeKB: parseFloat((pdfStat.size / 1024).toFixed(1)),
        };
      } catch (err) {
        report.postCompileError = `Failed to finalize PDF: ${err.message}`;
      }
    }

    return report;
  } finally {
    rmSync(compileDir, { recursive: true, force: true });
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const compileOnly = rawArgs.includes('--compile-only');
  const args = rawArgs.filter(a => a !== '--compile-only');
  const inputPath = args[0];
  const outputPath = args[1];

  if (!inputPath) {
    console.error('Usage: node src/cv/generate-latex.mjs <input.tex> [output.pdf] [--compile-only]');
    process.exit(1);
  }

  const absPath = resolve(inputPath);
  let content;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch (err) {
    console.error(`Error reading ${absPath}: ${err.message}`);
    process.exit(1);
  }

  const report = await compileLatexFile(absPath, content, outputPath || null, compileOnly);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.compiled ? 0 : (report.valid ? 1 : 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
