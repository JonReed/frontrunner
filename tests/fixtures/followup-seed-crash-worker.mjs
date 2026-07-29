import { seedFollowup } from '../../src/tracker/followup-seed.mjs';

const [trackerPath, followupsPath, lockDir, rawAppNum] = process.argv.slice(2);

await seedFollowup(Number(rawAppNum), {
  trackerPath,
  followupsPath,
  lockDir,
  writeOptions: {
    afterWrite() {
      process.kill(process.pid, 'SIGKILL');
    },
  },
});
