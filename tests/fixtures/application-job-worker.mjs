import { createApplicationJobManager } from '../../src/application/job-manager.mjs';

const jobsDir = process.argv[2];
if (!jobsDir) throw new Error('jobs directory is required');
const operation = process.argv[3] ?? 'cv.build';
if (!['cv.build', 'pipeline.run'].includes(operation)) {
  throw new Error('unsupported worker operation');
}
const id = operation === 'cv.build' ? 'cv-31-worker' : 'job-pipeline-worker';

let completion;
const manager = createApplicationJobManager({
  jobsDir,
  cancelPollMs: 10,
  idFactory: () => id,
  execute(_request, options) {
    return new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve({
        version: '1',
        runId: id,
        operation,
        status: 'cancelled',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        exitCode: null,
        signal: 'SIGTERM',
        outputTail: '',
        error: 'Operation cancelled.',
      }), { once: true });
    });
  },
  onOperation(operation) {
    completion = operation;
  },
});

const job = operation === 'cv.build'
  ? await manager.startCvBuild(
    31,
    'https://jobs.example.com/31',
    null,
  )
  : await manager.start({
    version: '1',
    operation: 'pipeline.run',
    input: {
      engine: 'claude',
      scan: true,
      input: 'data/pipeline.md',
    },
  });
process.stdout.write(`${JSON.stringify(job)}\n`);
await completion;
