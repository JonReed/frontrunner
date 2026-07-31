/**
 * The ways someone actually chases an application.
 *
 * Inert on purpose, and in its own module for a structural reason rather than
 * a stylistic one: the form that offers these choices runs in the browser,
 * while the module that writes them spawns a backend process. A client
 * component importing the writer — even for one constant — drags `node:fs` and
 * `node:child_process` into the browser bundle and fails the production build.
 *
 * Kept in step with FOLLOWUP_CHANNELS in src/tracker/followup-log.mjs, which
 * remains the authority: a channel this list offered but that one rejected
 * would be refused at the boundary rather than silently written.
 */
export const FOLLOWUP_CHANNELS = Object.freeze([
  'Email',
  'LinkedIn',
  'Phone',
  'Portal',
  'Other',
]);
