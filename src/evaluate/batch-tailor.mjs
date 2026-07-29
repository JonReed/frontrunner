#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { spawnSync } from 'child_process';

import { ROOT } from '#paths';
const batchStateFile = join(ROOT, 'batch', 'batch-state.tsv');
const reportsDir = join(ROOT, 'reports');

function usage() {
  console.log(`career-ops batch tailor — bulk generate tailored CVs for high-scoring batch jobs

Usage:
  node src/evaluate/batch-tailor.mjs [--min-score=4.0]

Options:
  --min-score=N   Minimum score to tailor (default: 4.0)
`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  usage();
}

let minScore = 4.0;
for (const arg of args) {
  if (arg.startsWith('--min-score=')) {
    minScore = parseFloat(arg.split('=')[1]);
  }
}

if (!existsSync(batchStateFile)) {
  console.error(`ERROR: Batch state file not found at ${batchStateFile}`);
  process.exit(1);
}

const lines = readFileSync(batchStateFile, 'utf-8').split('\n');
const toProcess = [];

for (const line of lines) {
  if (!line || line.startsWith('id\t')) continue;
  const parts = line.split('\t');
  if (parts.length < 7) continue;
  
  const id = parts[0];
  const url = parts[1];
  const status = parts[2];
  const reportNum = parts[5];
  const scoreStr = parts[6];
  
  if (status === 'completed') {
    const score = parseFloat(scoreStr);
    if (!isNaN(score) && score >= minScore) {
      toProcess.push({ id, url, reportNum, score });
    }
  }
}

if (toProcess.length === 0) {
  console.log(`No completed roles found with score >= ${minScore}.`);
  process.exit(0);
}

console.log(`Found ${toProcess.length} roles scoring >= ${minScore}. Beginning bulk tailoring...`);

const reports = existsSync(reportsDir) ? readdirSync(reportsDir) : [];

for (let i = 0; i < toProcess.length; i++) {
  const job = toProcess[i];
  console.log(`\n[${i + 1}/${toProcess.length}] Tailoring CV for Report ${job.reportNum} (Score: ${job.score}) — ${job.url}`);
  
  // Resolve report identity for deterministic PDF/index linkage.
  const matchingReport = reports.find(f => f.startsWith(`${job.reportNum}-`) && f.endsWith('.md'));
  const tailorArgs = [
    join(ROOT, 'src/cv/claude-tailor.mjs'),
    '--url', job.url,
    '--report', matchingReport ?? job.reportNum,
    '--tracker', job.id,
  ];

  const res = spawnSync(process.execPath, tailorArgs, { cwd: ROOT, stdio: 'inherit' });
  if (res.error) {
    console.error(`Error running secure CV tailoring: ${res.error.message}`);
  } else if (res.status !== 0) {
    console.error(`Worker exited with status ${res.status}`);
  } else {
    console.log(`✅ Finished tailoring for Report ${job.reportNum}`);
  }
}

console.log('\nBulk tailoring complete.');
