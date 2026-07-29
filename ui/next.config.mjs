import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  // The UI reads the career-ops checkout one level up (tracker, reports,
  // generated CVs). Nothing from there is bundled — server code reads it at
  // request time — but file tracing needs to know the wider root exists.
  outputFileTracingRoot: resolve(here, '..'),

  // ...and Turbopack needs to be told the PROJECT root separately, or it
  // infers it from outputFileTracingRoot, looks for next/package.json up
  // there, fails to find it, and dev refuses to start.
  turbopack: { root: here },
};
