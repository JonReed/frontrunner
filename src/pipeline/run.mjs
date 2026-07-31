#!/usr/bin/env node
/**
 * Canonical Frontrunner pipeline.
 *
 * scan -> bulk JD cache -> API-first liveness -> deterministic prefilter ->
 * provider evaluation. This is the supported model-backed entry point.
 */

import {
  existsSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from '#paths';
import { runFetchJds } from '../scan/fetch-jds.mjs';
import { cacheProviderDescriptions, readJdManifest } from '../scan/jd-cache.mjs';
import { createLivenessChecker } from '../scan/liveness-service.mjs';
import { runPrefilter } from '../scan/prefilter.mjs';
import {
  PREFILTER_OVERRIDE_URL_ENV,
  readPrefilterOverrides,
} from '../scan/prefilter-overrides.mjs';
import {
  EVALUATION_RESULT_FD_ENV,
  parseEvaluationExecutionResult,
} from '../evaluate/execution-result.mjs';
import {
  FileLockTimeoutError,
  acquireFileLock,
} from '../lib/file-lock.mjs';
import { withPipelineLock } from '../tracker/pipeline-lock.mjs';
import {
  APPLICATION_RUN_ID_ENV,
  pipelineRunHistoryRecord,
  resolveRunHistoryRunId,
  writeRunHistory,
  writeRunHistorySafely,
} from '../application/run-history.mjs';
import {
  applicationProgress,
  emitApplicationProgress,
} from '../application/progress.mjs';
import { publishPipelineFile } from './pipeline-files.mjs';
import { runCheckedSubprocess } from '../security/subprocess.mjs';

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

export async function markPipelineOutcomes(file, outcomes, options = {}) {
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
    publishPipelineFile(
      file,
      `${kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`,
      options.writeOptions,
    );
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

async function defaultRun(command, args, options = {}) {
  const resultChannel = options.resultChannel === true;
  const result = await runCheckedSubprocess(command, args, {
    cwd: ROOT,
    timeoutMs: 10 * 60 * 1000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    extraPipes: resultChannel ? 1 : 0,
    env: {
      ...process.env,
      ...(options.env ?? {}),
      ...(resultChannel ? { [EVALUATION_RESULT_FD_ENV]: '3' } : {}),
    },
    onStdout: options.capture ? undefined : chunk => process.stdout.write(chunk),
    onStderr: options.capture ? undefined : chunk => process.stderr.write(chunk),
  });
  return {
    ...result,
    output: resultChannel ? { 3: result.extraOutput[0] } : {},
  };
}

export async function runPipelineEvaluations({ engine, kept, jdsDir, run = defaultRun }) {
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
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
  };
  let usageReported = 0;
  let modelRequests = 0;
  for (const role of kept) {
    const file = index.get(role.url);
    if (!file) {
      failed.push({ url: role.url, error: `${engine}: no cached JD` });
      continue;
    }
    try {
      let processResult;
      const evaluatorOptions = {
        resultChannel: true,
        ...(role.overrideRule ? {
          env: { [PREFILTER_OVERRIDE_URL_ENV]: role.url },
        } : {}),
      };
      if (engine === 'claude' || engine === 'batch') {
        processResult = await run(
          process.execPath,
          [join(ROOT, 'src/evaluate/claude-eval.mjs'), '--file', file, '--url', role.url],
          evaluatorOptions,
        );
      } else if (engine === 'openrouter') {
        processResult = await run(
          process.execPath,
          [join(ROOT, 'src/evaluate/openrouter-runner.mjs'), 'evaluate', '--file', file],
          evaluatorOptions,
        );
      } else {
        const evaluator = engine === 'gemini' ? 'gemini-eval.mjs' : 'openai-eval.mjs';
        processResult = await run(
          process.execPath,
          [join(ROOT, 'src/evaluate', evaluator), '--file', file],
          evaluatorOptions,
        );
      }
      const execution = parseEvaluationExecutionResult(
        processResult?.output?.[3] ?? processResult?.evaluationResult,
      );
      if (execution.status === 'skipped') {
        throw new Error(`${engine}: evaluator gate rejected a role retained by the pipeline`);
      }
      modelRequests += execution.requestCount;
      if (execution.usage) {
        usageReported++;
        for (const key of Object.keys(usage)) {
          const next = usage[key] + execution.usage[key];
          if (!Number.isSafeInteger(next)) throw new Error('aggregate evaluator usage overflow');
          usage[key] = next;
        }
      }
      completed.push(role.url);
    } catch (error) {
      failed.push({ url: role.url, error: error.message });
    }
  }
  return {
    attempted: kept.length,
    completed,
    failed,
    modelRequests,
    usageReported,
    usageMissing: completed.length - usageReported,
    ...(usageReported ? { usage } : {}),
  };
}

export async function runCanonicalPipeline({
  input = join(ROOT, 'workspace', 'search', 'pipeline.md'),
  jdsDir = join(ROOT, 'workspace', 'jobs', 'descriptions'),
  activeInput = join(ROOT, 'workspace', '.state', 'liveness-active.tsv'),
  batchInput = join(ROOT, 'workspace', '.state', 'batch-input.tsv'),
  rejects = join(ROOT, 'workspace', '.state', 'prefilter-rejects.tsv'),
  livenessResults = join(ROOT, 'workspace', '.state', 'liveness-results.tsv'),
  engine = 'claude',
  scan = true,
  // Both scan passes, matching the standalone scan operation: the tracked
  // companies for depth, and a bounded sweep of every public ATS board for
  // breadth. Running only the first here would make "Find and assess" and
  // "Search" find different things from the same filters.
  scanRunner = () => defaultRun(process.execPath, [join(ROOT, 'src/scan/scan-all.mjs')]),
  fetchJds = runFetchJds,
  checker = null,
  prefilter = runPrefilter,
  evaluationRunner = runPipelineEvaluations,
  runLock = pipelineRunLockTarget(activeInput),
  runLockOptions = {},
  onStage = () => {},
  now = () => Date.now(),
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

  const stageMetrics = [];
  let activeStage = null;
  const publishStage = (stage, state, counts) => {
    const at = now();
    if (state === 'started') {
      activeStage = { stage, startedAt: at };
    } else if (activeStage?.stage === stage) {
      stageMetrics.push(Object.freeze({
        stage,
        status: state === 'completed' ? 'succeeded' : 'failed',
        startedAt: activeStage.startedAt,
        finishedAt: at,
        durationMs: Math.max(0, at - activeStage.startedAt),
        ...(counts ? { counts: Object.freeze({ ...counts }) } : {}),
      }));
      activeStage = null;
    }
    try {
      onStage(Object.freeze({
        stage,
        state,
        at,
        ...(counts ? { counts: Object.freeze({ ...counts }) } : {}),
      }));
    } catch {
      // Progress has no authority over pipeline execution.
    }
  };
  const finishStage = (stage, counts) => publishStage(stage, 'completed', counts);

  try {
    if (scan) {
      publishStage('scan', 'started');
      await scanRunner();
      finishStage('scan');
    }
    if (!existsSync(input)) throw new Error(`pipeline input not found: ${input}`);

    const roles = readPipelineRoles(input);
    const activeChecker = checker ?? createLivenessChecker();
    let cache;
    let manifest;
    publishStage('cache', 'started');
    try {
      cache = await fetchJds({ input, outDir: jdsDir });
      manifest = readJdManifest(jdsDir);
      finishStage('cache', {
        urls: cache.urls ?? roles.length,
        requests: cache.requests ?? 0,
        available: cache.available ?? 0,
        written: cache.written ?? 0,
        cached: cache.cached ?? 0,
      });
    } catch (error) {
      await activeChecker.close();
      throw error;
    }
    const live = [];
    const livenessRejected = [];
    const livenessRows = [];
    const fallbackDescriptions = [];

    publishStage('liveness', 'started');
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

    publishPipelineFile(activeInput, rolesTsv(live));
    publishPipelineFile(
      livenessResults,
      `url\tcompany\ttitle\tresult\tsource\treason\n${livenessRows
        .map((row) => [row.url, row.company, row.title, row.result, row.source, row.reason]
          .map((value) => String(value ?? '').replace(/[\t\r\n]+/g, ' '))
          .join('\t'))
        .join('\n')}\n`,
    );
    finishStage('liveness', {
      active: livenessRows.filter((r) => r.result === 'active').length,
      uncertain: livenessRows.filter((r) => r.result === 'uncertain').length,
      expired: livenessRejected.length,
      api: livenessRows.filter((r) => r.source === 'api').length,
      browser: livenessRows.filter((r) => r.source === 'browser').length,
      fallbackCached: fallbackCache.cached,
    });

    publishStage('prefilter', 'started');
    const filtered = prefilter({
      input: activeInput,
      jdsDir,
      out: batchInput,
      rejects,
      overrides: readPrefilterOverrides(),
    });
    if (livenessRejected.length) {
      const existing = readFileSync(rejects, 'utf8').trimEnd();
      const extra = livenessRejected.map((row) =>
        [row.url, row.company, row.title, 'posting_expired', row.reason]
          .map((value) => String(value ?? '').replace(/[\t\r\n]+/g, ' '))
          .join('\t'));
      publishPipelineFile(rejects, `${existing}\n${extra.join('\n')}\n`);
    }

    await markPipelineOutcomes(input, new Map([
      ...livenessRejected.map((role) => [role.url, 'posting expired']),
      ...filtered.rejected.map((role) => [role.url, `prefilter rejected (${role.rule})`]),
    ]));
    finishStage('prefilter', {
      kept: filtered.result.kept,
      rejected: filtered.result.rejected,
    });

    publishStage('evaluation', 'started');
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
    finishStage('evaluation', {
      attempted: evaluation.attempted ?? 0,
      completed: evaluation.completed?.length ?? 0,
      failed: evaluation.failed?.length ?? 0,
      modelRequests: evaluation.modelRequests ?? 0,
      usageReported: evaluation.usageReported ?? 0,
      usageMissing: evaluation.usageMissing ?? 0,
    });

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
      stageMetrics,
    };
  } catch (error) {
    if (activeStage) publishStage(activeStage.stage, 'failed');
    try {
      Object.defineProperty(error, 'pipelineStageMetrics', {
        configurable: true,
        value: Object.freeze([...stageMetrics]),
      });
    } catch {
      // Preserve the original exception even if a non-extensible value was
      // thrown. Failed-stage accounting is operational evidence, not authority.
    }
    throw error;
  } finally {
    lease.release();
  }
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

export function resolvePipelineRunId({
  applicationRunId = process.env[APPLICATION_RUN_ID_ENV],
  runIdFactory = randomUUID,
} = {}) {
  return resolveRunHistoryRunId(applicationRunId, runIdFactory);
}

export async function main({
  auditWriter = null,
  now = () => Date.now(),
  runIdFactory = randomUUID,
  applicationRunId = process.env[APPLICATION_RUN_ID_ENV],
} = {}) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`frontrunner pipeline — scan -> cache -> liveness -> prefilter -> evaluation

Usage:
  npm run pipeline
  node src/pipeline/run.mjs [--engine claude|openrouter|openai|gemini|none]

Options:
  --input <file>       Input pipeline/TSV (default workspace/search/pipeline.md)
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
  const startedAt = now();
  const runId = resolvePipelineRunId({ applicationRunId, runIdFactory });
  let result;
  try {
    result = await runCanonicalPipeline({
      input: resolve(ROOT, argValue(args, '--input', 'workspace/search/pipeline.md')),
      engine,
      scan: !args.includes('--skip-scan'),
      now,
      onStage(event) {
        emitApplicationProgress(applicationProgress(event));
      },
    });
  } catch (error) {
    await writeRunHistorySafely(
      auditWriter,
      pipelineRunHistoryRecord({
        stageMetrics: error?.pipelineStageMetrics,
      }, {
        runId,
        operation: engine === 'none' ? 'pipeline.prepare' : 'pipeline.run',
        status: 'failed',
        startedAt,
        finishedAt: now(),
        engine,
        costsTokens: engine !== 'none',
        error: error?.message,
      }),
      auditError => console.warn(`run history warning: ${auditError.message}`),
    );
    throw error;
  }
  await writeRunHistorySafely(
    auditWriter,
    pipelineRunHistoryRecord(result, {
      runId,
      operation: engine === 'none' ? 'pipeline.prepare' : 'pipeline.run',
      startedAt,
      finishedAt: now(),
      engine,
    }),
    error => console.warn(`run history warning: ${error.message}`),
  );
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('\n=== Frontrunner pipeline complete ===');
    console.log(`roles: ${result.inputRoles}`);
    console.log(`liveness: ${result.liveness.active} active, ${result.liveness.uncertain} uncertain, ${result.liveness.expired} expired`);
    console.log(`prefilter: ${result.prefilter.kept} kept, ${result.prefilter.rejected} rejected`);
    console.log(`model evaluations attempted: ${result.evaluation.attempted}`);
    if (result.evaluation.attempted > 0) {
      console.log(`model API requests: ${result.evaluation.modelRequests}`);
      if (result.evaluation.usage) {
        console.log(
          `model usage: ${result.evaluation.usage.promptTokens} input, `
          + `${result.evaluation.usage.completionTokens} output, `
          + `${result.evaluation.usage.cachedTokens} cached `
          + `(${result.evaluation.usageReported}/${result.evaluation.completed.length} evaluations reported usage)`,
        );
      } else {
        console.log(`model usage: unavailable (0/${result.evaluation.completed.length} evaluations reported usage)`);
      }
    }
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
  main({ auditWriter: writeRunHistory }).catch((error) => {
    console.error(`pipeline failed: ${error.message}`);
    process.exitCode = 1;
  });
}
