import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  PipelineRunBusyError,
  runCanonicalPipeline,
} from '../../src/pipeline/run.mjs';

const [input, batchDir, marker, holdRaw = '400'] = process.argv.slice(2);
const holdMs = Number(holdRaw);

try {
  await runCanonicalPipeline({
    input,
    jdsDir: join(batchDir, 'jds'),
    activeInput: join(batchDir, 'active.tsv'),
    batchInput: join(batchDir, 'batch.tsv'),
    rejects: join(batchDir, 'rejects.tsv'),
    livenessResults: join(batchDir, 'liveness.tsv'),
    engine: 'none',
    scan: false,
    fetchJds: async () => ({ urls: 1, requests: 0, available: 0 }),
    checker: {
      check: async () => {
        await new Promise(resolve => setTimeout(resolve, holdMs));
        return { result: 'active', source: 'api', reason: 'fixture active' };
      },
      close: async () => {},
    },
    prefilter: ({ input: activeInput, out, rejects }) => {
      writeFileSync(out, readFileSync(activeInput, 'utf8'));
      writeFileSync(rejects, 'url\tcompany\ttitle\trule\tevidence\n');
      return {
        kept: [{ url: 'https://jobs.example/role' }],
        rejected: [],
        result: { roles: 1, kept: 1, rejected: 0 },
      };
    },
    evaluationRunner: async () => {
      appendFileSync(marker, `${process.pid}\n`);
      return { attempted: 1, completed: [], failed: [] };
    },
  });
} catch (error) {
  if (error instanceof PipelineRunBusyError) {
    process.exitCode = 23;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
}
