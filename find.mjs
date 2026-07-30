#!/usr/bin/env node

/**
 * Stable public entry point for tracker identity lookup.
 */

export * from './src/tracker/find.mjs';
import { main } from './src/tracker/find.mjs';
import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
