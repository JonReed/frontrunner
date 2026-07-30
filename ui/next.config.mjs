/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  // Backend operations are reached through a fixed child-process adapter; no
  // backend module is bundled into Next.js. Keep Turbopack scoped to the UI so
  // its separate package and lockfile remain authoritative.
  turbopack: {
    root: process.cwd(),
  },
  // The dev overlay badge is pinned bottom-left, which is exactly where the
  // mobile nav bar sits. It hides a real control while testing at phone width.
  devIndicators: false,
  // The profile boundary accepts a bounded 1.5 MiB aggregate request so a
  // supported 512 KiB CV can cross a Server Action without Next rejecting it
  // before the application validator runs.
  experimental: {
    serverActions: {
      bodySizeLimit: '1536kb',
      allowedOrigins: ['127.0.0.1:3100', 'localhost:3100'],
    },
  },
};
