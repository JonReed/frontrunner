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
  realpathSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { runFetchJds } from '../scan/fetch-jds.mjs';
import { cacheProviderDescriptions, readJdManifest } from '../scan/jd-cache.mjs';
import { createLivenessChecker } from '../scan/liveness-service.mjs';
import { runPrefilter } from '../scan/prefilter.mjs';
import {
  FileLockTimeoutError,
  acquireFileLock,
} from '../lib/file-lock.mjs';
import { withPipelineLock } from '../tracker/pipeline-lock.mjs';

function atomicWrite(file, contents) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

export class PipelineRunBusyError extends FileLockTimeoutError {
  constructor(lockDir, timeoutMs) {
    super(lockDir, timeoutMs);
    this.name = 'PipelineRunBusyError';
    this.message = `pipeline run already active: ${lockDir}`;
  }
}

export function pipelineRunLockTarget(activeInput) {
  return join(dirname(activeInput), '.pipeline-run');
}

export function readPipelineRoles(file) {
  const roles = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const md = line.match(/^-\s*\[\s*\]\s*(\S+)(.*)$/);
    if (md) {
      const fields = md[2].split('|').map((value) => value.trim()).filter((_, index) => index > 0);
      roles.push({
        id: String(roles.length + 1),
        url: md[1],
        company: fields[0] ?? '',
        title: fields[1] ?? '',
        source: 'pipeline',
      });
      continue;
    }
    const cols = line.split('\t');
    if (cols.length >= 4 && /^https?:\/\//.test(cols[1]?.trim() ?? '')) {
      const note = cols[3] ?? '';
      const divider = note.includes('—') ? '—' : note.includes(' - ') ? ' - ' : null;
      const [company = '', title = note] = divider ? note.split(divider, 2).map((s) => s.trim()) : ['', note.trim()];
      roles.push({
        id: cols[0]?.trim() || String(roles.length + 1),
        url: cols[1].trim(),
        company,
        title,
        source: cols[2]?.trim() || 'pipeline',
      });
    }
  }
  return roles;
}

function rolesTsv(roles) {
  return `id\turl\tsource\tnotes\n${roles
    .map((role, index) => `${role.id || index + 1}\t${role.url}\t${role.source || 'pipeline'}\t${role.company} — ${role.title}`)
    .join('\n')}\n`;
}

export async function markPipelineOutcomes(file, outcomes) {
  if (!outcomes?.size || !existsSync(file)) return 0;
  return withPipelineLock(file, async () => {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const moved = [];
    const kept = [];
    let changed = 0;
    for (const line of lines) {
      const match = line.match(/^-\s*\[\s*\]\s*(\S+)/);
      const outcome = match ? outcomes.get(match[1]) : null;
      if (!outcome) {
        kept.push(line);
        continue;
      }
      moved.push(`${line.replace(/\[\s*\]/, '[x]')} | result: ${outcome}`);
      changed++;
    }
    if (!changed) return 0;

    let processed = kept.findIndex((line) => /^##\s+(Processed|Procesadas)\s*$/i.test(line));
    if (processed < 0) {
      while (kept.length && kept.at(-1) === '') kept.pop();
      kept.push('', '## Processed', '');
      processed = kept.length - 2;
    }
    kept.splice(processed + 1, 0, '', ...moved);
    atomicWrite(file, `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
    return changed;
  });
}

function readLocalDescription(url) {
  if (!url.startsWith('local:')) return null;
  const file = resolve(ROOT, url.slice('local:'.length));
  if (!existsSync(file)) return { error: 'local JD file not found' };
  const rootReal = realpathSync(ROOT);
  const fileReal = realpathSync(file);
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${sep}`)) {
    return { error: 'local JD path escapes the repository' };
  }
  const text = readFileSync(fileReal, 'utf8').trim();
  return text ? { text } : { error: 'local JD file is empty' };
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
  if (engine === 'none' || kept.length === 0) return { attempted: 0, completed: [], failed: [] };
  const index = new Map();
  const indexFile = join(jdsDir, 'index.tsv');
  if (existsSync(indexFile)) {
    for (const line of readFileSync(indexFile, 'utf8').split('\n').slice(1)) {
      const [url, file] = line.split('\t');
      if (url && file) index.set(url.trim(), file.trim());
    }
  }
  const completed = [];
  const failed = [];
  for (const role of kept) {
    const file = index.get(role.url);
    if (!file) {
      failed.push({ url: role.url, error: `${engine}: no cached JD` });
      continue;
    }
    try {
      if (engine === 'claude' || engine === 'batch') {
        run(process.execPath, [join(ROOT, 'src/evaluate/claude-eval.mjs'), '--file', file, '--url', role.url]);
      } else if (engine === 'openrouter') {
        run(process.execPath, [join(ROOT, 'src/evaluate/openrouter-runner.mjs'), 'evaluate', '--file', file]);
      } else {
        const evaluator = engine === 'gemini' ? 'gemini-eval.mjs' : 'openai-eval.mjs';
        run(process.execPath, [join(ROOT, 'src/evaluate', evaluator), '--file', file]);
      }
      completed.push(role.url);
    } catch (error) {
      failed.push({ url: role.url, error: error.message });
    }
  }
  return { attempted: kept.length, completed, failed };
}

export async function runCanonicalPipeline({
  input = join(ROOT, 'data', 'pipeline.md'),
  jdsDir = join(ROOT, 'jds'),
  activeInput = join(ROOT, 'batch', 'liveness-active.tsv'),
  batchInput = join(ROOT, 'batch', 'batch-input.tsv'),
  rejects = join(ROOT, 'batch', 'prefilter-rejects.tsv'),
  livenessResults = join(ROOT, 'batch', 'liveness-results.tsv'),
  engine = 'claude',
  scan = true,
  scanRunner = () => defaultRun(process.execPath, [join(ROOT, 'src/scan/scan.mjs')]),
  fetchJds = runFetchJds,
  checker = null,
  prefilter = runPrefilter,
  evaluationRunner = defaultEvaluationRunner,
  runLock = pipelineRunLockTarget(activeInput),
  runLockOptions = {},
} = {}) {
  const lease = await acquireFileLock(runLock, {
    timeoutMs: 0,
    ...runLockOptions,
    ownerFields: {
      operation: 'canonical-pipeline',
      input,
      ...(runLockOptions.ownerFields ?? {}),
    },
    createTimeoutError: (lockDir, timeoutMs) =>
      new PipelineRunBusyError(lockDir, timeoutMs),
  });

  try {
    if (scan) await scanRunner();
    if (!existsSync(input)) throw new Error(`pipeline input not found: ${input}`);

    const roles = readPipelineRoles(input);
    const activeChecker = checker ?? createLivenessChecker();
    let cache;
    let manifest;
    try {
      cache = await fetchJds({ input, outDir: jdsDir });
      manifest = readJdManifest(jdsDir);
    } catch (error) {
      await activeChecker.close();
      throw error;
    }
    const live = [];
    const livenessRejected = [];
    const livenessRows = [];
    const fallbackDescriptions = [];

    try {
      for (const role of roles) {
        const local = readLocalDescription(role.url);
        let result;
        if (local) {
          if (local.error) {
            result = { result: 'expired', source: 'local', reason: local.error };
          } else {
            const heading = local.text.match(/^#\s+(.+)$/m)?.[1]?.trim();
            if (!role.title && heading) role.title = heading;
            fallbackDescriptions.push({ ...role, description: local.text });
            result = { result: 'active', source: 'local', reason: 'local JD file is readable' };
          }
        } else {
          result = await activeChecker.check(role.url);
          if (result.result !== 'expired' && !manifest.has(role.url) && typeof activeChecker.extract === 'function') {
            try {
              const extracted = await activeChecker.extract(role.url);
              if (extracted?.text) {
                if (!role.title && extracted.title) role.title = extracted.title;
                fallbackDescriptions.push({ ...role, description: extracted.text });
              }
            } catch (error) {
              result = {
                ...result,
                reason: `${result.reason ?? result.result}; description fallback failed: ${error.message}`,
              };
            }
          }
        }
        livenessRows.push({ ...role, ...result });
        if (result.result === 'expired') livenessRejected.push({ ...role, ...result });
        else live.push(role); // uncertainty keeps the role: false rejects cost opportunities
      }
    } finally {
      await activeChecker.close();
    }

    const fallbackCache = fallbackDescriptions.length
      ? await cacheProviderDescriptions(fallbackDescriptions, { outDir: jdsDir })
      : { cached: 0, manifestSize: manifest.size };

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

    await markPipelineOutcomes(input, new Map([
      ...livenessRejected.map((role) => [role.url, 'posting expired']),
      ...filtered.rejected.map((role) => [role.url, `prefilter rejected (${role.rule})`]),
    ]));

    const evaluation = await evaluationRunner({
      engine,
      kept: filtered.kept,
      jdsDir,
    });
    if (engine !== 'none' && evaluation.completed?.length) {
      await markPipelineOutcomes(
        input,
        new Map(evaluation.completed.map((url) => [url, 'evaluated'])),
      );
    }

    return {
      stages: [...(scan ? ['scan'] : []), 'cache', 'liveness', 'prefilter', 'evaluation'],
      inputRoles: roles.length,
      cache: { ...cache, fallbackCached: fallbackCache.cached },
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
  } finally {
    lease.release();
  }
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
  node src/pipeline/run.mjs [--engine claude|openrouter|openai|gemini|none]

Options:
  --input <file>       Input pipeline/TSV (default data/pipeline.md)
  --engine <name>      Tool-less evaluation provider (default claude)
  --skip-scan          Use the existing input without running scan first
  --prepare-only       Alias for --engine none
  --json               Print the machine-readable run summary
`);
    return;
  }
  const engine = args.includes('--prepare-only') ? 'none' : argValue(args, '--engine', 'claude');
  if (!['claude', 'batch', 'openrouter', 'openai', 'gemini', 'none'].includes(engine)) {
    throw new Error(`unsupported engine: ${engine}`);
  }
  if (engine === 'batch') {
    console.warn('Warning: --engine batch is deprecated; using the tool-less Claude evaluator.');
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
    if (result.evaluation.failed?.length) {
      console.error(`model evaluations failed: ${result.evaluation.failed.length}`);
      for (const failure of result.evaluation.failed) {
        console.error(`  - ${failure.url}: ${failure.error}`);
      }
      process.exitCode = 1;
    }
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirect) {
  main().catch((error) => {
    console.error(`pipeline failed: ${error.message}`);
    process.exitCode = 1;
  });
}
