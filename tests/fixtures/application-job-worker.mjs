import { createApplicationJobManager } from '../../src/application/job-manager.mjs';

const jobsDir = process.argv[2];
if (!jobsDir) throw new Error('jobs directory is required');

let completion;
const manager = createApplicationJobManager({
  jobsDir,
  cancelPollMs: 10,
  idFactory: () => 'cv-31-worker',
  execute(_request, options) {
    return new Promise(resolve => {
      options.signal.addEventListener('abort', () => resolve({
        version: '1',
        runId: 'cv-31-worker',
        operation: 'cv.build',
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

const job = await manager.startCvBuild(
  31,
  'https://jobs.example.com/31',
  null,
);
process.stdout.write(`${JSON.stringify(job)}\n`);
await completion;
