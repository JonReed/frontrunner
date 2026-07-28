/** @type {import('next').NextConfig} */
export default {
  // The UI reads the career-ops checkout it lives in (one level up).
  // Nothing is bundled from there — server code reads it at request time.
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
};
