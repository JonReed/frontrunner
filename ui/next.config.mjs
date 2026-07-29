/** @type {import('next').NextConfig} */
export default {
  // The local server reads tracker, report, and generated-CV files from the
  // parent checkout at request time. They are not bundled, so file tracing
  // stays scoped normally. Pinning Turbopack to Next's selected project cwd
  // avoids it treating the root package-lock.json as a monorepo declaration.
  turbopack: {
    root: process.cwd(),
  },
};
