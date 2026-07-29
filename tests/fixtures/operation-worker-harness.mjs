import { runOperationWorker } from '../../src/application/operation-worker.mjs';

const backend = process.argv[2];
if (!backend) throw new Error('backend fixture path is required');

process.exitCode = await runOperationWorker({
  terminationGraceMs: 75,
  resolveOperation(request) {
    if (request?.operation !== 'test.owner-death') {
      throw new Error('unexpected fixture operation');
    }
    return {
      command: process.execPath,
      args: [backend],
      cwd: process.cwd(),
    };
  },
});
