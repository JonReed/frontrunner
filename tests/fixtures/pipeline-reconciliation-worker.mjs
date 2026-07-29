#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { publishPipelineReconciliation } from '../../src/tracker/pipeline-reconciliation-write.mjs';

const [pipelineFile, nextFile, mode = 'publish'] = process.argv.slice(2);
const currentContent = readFileSync(pipelineFile, 'utf8');
const nextContent = readFileSync(nextFile, 'utf8');

publishPipelineReconciliation({
  pipelineFile,
  currentContent,
  nextContent,
  afterBackup: mode === 'crash-after-backup'
    ? () => process.kill(process.pid, 'SIGKILL')
    : undefined,
});
