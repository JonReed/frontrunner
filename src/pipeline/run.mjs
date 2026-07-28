#!/usr/bin/env node
/**
 * Canonical Frontrunner pipeline.
 *
 * scan -> bulk JD cache -> API-first liveness -> deterministic prefilter ->
 * provider evaluation. This is the supported model-backed entry point.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { runFetchJds } from '../scan/fetch-jds.mjs';
import { createLivenessChecker } from '../scan/liveness-service.mjs';
import { runPrefilter } from '../scan/prefilter.mjs';

function atomicWrite(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

export function readPipelineRoles(file) {
  const roles = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const md = line.match(/^-\s*\[\s*\]\s*(\S+)\s*\|\s*([^|]*)\|\s*([^|]*)/);
    if (md) {
      roles.push({ url: md[1], company: md[2].trim(), title: md[3].trim(), source: 'pipeline' });
      continue;
    }
    const cols = line.split('\t');
    if (cols.length >= 4 && /^https?:\/\//.test(cols[1]?.trim() ?? '')) {
      const note = cols[3] ?? '';
      const divider = note.includes('—') ? '—' : note.includes(' - ') ? ' - ' : null;
      const [company = '', title = note] = divider ? note.split(divider, 2).map((s) => s.trim()) : ['', note.trim()];
      roles.push({ url: cols[1].trim(), company, title, source: cols[2]?.trim() || 'pipeline' });
    }
  }
  return roles;
}

function rolesTsv(roles) {
  return `id\turl\tsource\tnotes\n${roles
    .map((role, index) => `${index + 1}\t${role.url}\t${role.source || 'pipeline'}\t${role.company} — ${role.title}`)
    .join('\n')}\n`;
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result;
}

async function defaultEvaluationRunner({ engine, kept, jdsDir, run = defaultRun }) {
  if (engine === 'none' || kept.length === 0) return { attempted: 0 };
  if (engine === 'batch') {
    run(join(ROOT, 'batch', 'batch-runner.sh'), []);
    return { attempted: kept.length };
  }

  const index = new Map();
  const indexFile = join(jdsDir, 'index.tsv');
  if (existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, 'utf8').split('\n').slice(1)) {
      const [url, file] = line.split('\t');
      if (url && file) index.set(url.trim(), file.trim());
    }
  }
  for (const role of kept) {
    if (engine === 'openrouter') {
      run(process.execPath, [join(ROOT, 'src/evaluate/openrouter-runner.mjs'), 'evaluate', role.url]);
      continue;
    }
    const file = index.get(role.url);
    if (!file) throw new Error(`${engine}: no cached JD for ${role.url}`);
    const evaluator = engine === 'gemini' ? 'gemini-eval.mjs' : 'openai-eval.mjs';
    run(process.execPath, [join(ROOT, 'src/evaluate', evaluator), '--file', file]);
  }
  return { attempted: kept.length };
}

export async function runCanonicalPipeline({
  input = join(ROOT, 'data', 'pipeline.md'),
  jdsDir = join(ROOT, 'jds'),
  activeInput = join(ROOT, 'batch', 'liveness-active.tsv'),
  batchInput = join(ROOT, 'batch', 'batch-input.tsv'),
  rejects = join(ROOT, 'batch', 'prefilter-rejects.tsv'),
  livenessResults = join(ROOT, 'batch', 'liveness-results.tsv'),
  engine = 'batch',
  scan = true,
  scanRunner = () => defaultRun(process.execPath, [join(ROOT, 'src/scan/scan.mjs')]),
  fetchJds = runFetchJds,
  checker = createLivenessChecker(),
  prefilter = runPrefilter,
  evaluationRunner = defaultEvaluationRunner,
} = {}) {
  if (scan) await scanRunner();
  if (!existsSync(input)) throw new Error(`pipeline input not found: ${input}`);

  const roles = readPipelineRoles(input);
  const cache = await fetchJds({ input, outDir: jdsDir });
  const live = [];
  const livenessRejected = [];
  const livenessRows = [];

  try {
    for (const role of roles) {
      const result = await checker.check(role.url);
      livenessRows.push({ ...role, ...result });
      if (result.result === 'expired') livenessRejected.push({ ...role, ...result });
      else live.push(role); // uncertainty keeps the role: false rejects cost opportunities
    }
  } finally {
    await checker.close();
  }

  atomicWrite(activeInput, rolesTsv(live));
  atomicWrite(
    livenessResults,
    `url\tcompany\ttitle\tresult\tsource\treason\n${livenessRows
      .map((row) => [row.url, row.company, row.title, row.result, row.source, row.reason]
        .map((value) => String(value ?? '').replace(/[\t\r\n]+/g, ' '))
        .join('\t'))
      .join('\n')}\n`,
  );

  const filtered = prefilter({
    input: activeInput,
    jdsDir,
    out: batchInput,
    rejects,
  });
  if (livenessRejected.length) {
    const existing = readFileSync(rejects, 'utf8').trimEnd();
    const extra = livenessRejected.map((row) =>
      [row.url, row.company, row.title, 'posting_expired', row.reason]
        .map((value) => String(value ?? '').replace(/[\t\r\n]+/g, ' '))
        .join('\t'));
    atomicWrite(rejects, `${existing}\n${extra.join('\n')}\n`);
  }

  const evaluation = await evaluationRunner({
    engine,
    kept: filtered.kept,
    jdsDir,
  });

  return {
    stages: ['scan', 'cache', 'liveness', 'prefilter', 'evaluation'],
    inputRoles: roles.length,
    cache,
    liveness: {
      active: livenessRows.filter((r) => r.result === 'active').length,
      uncertain: livenessRows.filter((r) => r.result === 'uncertain').length,
      expired: livenessRejected.length,
      api: livenessRows.filter((r) => r.source === 'api').length,
      browser: livenessRows.filter((r) => r.source === 'browser').length,
    },
    prefilter: filtered.result,
    evaluation,
  };
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`frontrunner pipeline — scan -> cache -> liveness -> prefilter -> evaluation

Usage:
  npm run pipeline
  node src/pipeline/run.mjs [--engine batch|openrouter|openai|gemini|none]

Options:
  --input <file>       Input pipeline/TSV (default data/pipeline.md)
  --engine <name>      Evaluation provider (default batch)
  --skip-scan          Use the existing input without running scan first
  --prepare-only       Alias for --engine none
  --json               Print the machine-readable run summary
`);
    return;
  }
  const engine = args.includes('--prepare-only') ? 'none' : argValue(args, '--engine', 'batch');
  if (!['batch', 'openrouter', 'openai', 'gemini', 'none'].includes(engine)) {
    throw new Error(`unsupported engine: ${engine}`);
  }
  const result = await runCanonicalPipeline({
    input: resolve(ROOT, argValue(args, '--input', 'data/pipeline.md')),
    engine,
    scan: !args.includes('--skip-scan'),
  });
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('\n=== Frontrunner pipeline complete ===');
    console.log(`roles: ${result.inputRoles}`);
    console.log(`liveness: ${result.liveness.active} active, ${result.liveness.uncertain} uncertain, ${result.liveness.expired} expired`);
    console.log(`prefilter: ${result.prefilter.kept} kept, ${result.prefilter.rejected} rejected`);
    console.log(`model evaluations attempted: ${result.evaluation.attempted}`);
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  main().catch((error) => {
    console.error(`pipeline failed: ${error.message}`);
    process.exitCode = 1;
  });
}
