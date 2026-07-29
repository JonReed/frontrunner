#!/usr/bin/env node

import { appendStatusTransition } from '../../src/tracker/status-log.mjs';

const [filePath, trackerNum, date, from, to] = process.argv.slice(2);

await appendStatusTransition(filePath, {
  trackerNum: Number(trackerNum),
  date,
  from,
  to,
});
