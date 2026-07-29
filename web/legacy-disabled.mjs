#!/usr/bin/env node

const message = [
  'The inherited web application is archived and cannot be started.',
  'Use the Frontrunner UI instead: npm -C ui run dev',
  'This prevents legacy tool-capable agent and browser-driving endpoints from',
  'remaining reachable alongside the hardened backend.',
].join('\n');

process.stderr.write(`${message}\n`);
process.exitCode = 1;
