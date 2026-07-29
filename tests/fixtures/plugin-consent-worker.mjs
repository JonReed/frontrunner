#!/usr/bin/env node

import { writeLockEntry } from '../../plugins/_lock.mjs';
import { setPluginEnabled } from '../../src/plugins/plugins.mjs';

const [root, id] = process.argv.slice(2);
await writeLockEntry(root, id, {
  source: 'local',
  version: '1.0.0',
  integrity: `sha256-${id.padEnd(64, '0').slice(0, 64)}`,
  files: { 'index.mjs': `sha256-${'a'.repeat(64)}` },
  consent: {
    hooks: ['ingest'],
    requiredEnv: [],
    allowedHosts: [`${id}.example.com`],
    skill: false,
    allowsLocalhost: false,
  },
});
await setPluginEnabled(root, id, true, { label: `Settings for ${id}` });
