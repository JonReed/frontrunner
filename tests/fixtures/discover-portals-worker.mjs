#!/usr/bin/env node

import { appendDiscoveredPortals } from '../../src/scan/discover-ats.mjs';

const [portalsPath, matchJson] = process.argv.slice(2);
const outcome = await appendDiscoveredPortals([JSON.parse(matchJson)], portalsPath);
process.stdout.write(`${JSON.stringify({
  written: outcome.written,
  duplicates: outcome.duplicates.length,
})}\n`);
