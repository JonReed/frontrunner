/** @type {import('next').NextConfig} */
export default {
  // Backend operations are reached through a fixed child-process adapter; no
  // backend module is bundled into Next.js. Keep Turbopack scoped to the UI so
  // its separate package and lockfile remain authoritative.
  turbopack: {
    root: process.cwd(),
  },
  // The dev overlay badge is pinned bottom-left, which is exactly where the
  // mobile nav bar sits. It hides a real control while testing at phone width.
  devIndicators: false,
};
