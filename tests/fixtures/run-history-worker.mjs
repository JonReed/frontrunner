import { writeRunHistory } from '../../src/application/run-history.mjs';

const [file, prefix, rawCount] = process.argv.slice(2);
const count = Number.parseInt(rawCount, 10);

for (let index = 0; index < count; index++) {
  await writeRunHistory({
    runId: `${prefix}-${String(index)}`,
    operation: 'scan.run',
    status: 'succeeded',
    startedAt: index,
    finishedAt: index + 1,
    costsTokens: false,
    counts: { roles: index },
  }, { file });
}
