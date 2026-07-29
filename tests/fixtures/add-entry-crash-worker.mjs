#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { applyAdd } from '../../src/tracker/add-entry.mjs';
import { mutateAddEntrySources } from '../../src/tracker/add-entry-publication.mjs';

const [cvPath, articlePath, journalPath, payloadPath] = process.argv.slice(2);
const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));

await mutateAddEntrySources({
  cvPath,
  articlePath,
  journalPath,
  compute: current => applyAdd(payload, current),
}, {
  afterStage(stage) {
    if (stage === 'cv') process.exit(73);
  },
});
