// _config-utils.mjs — shared config-parsing helpers for provider adapters.
// Files prefixed with _ are never loaded as providers by src/scan/scan.mjs (see
// _registry.mjs).

/**
 * Clamp a runtime integer into [min, max], falling back to `def` for NaN, so
 * a stray workspace/search/portals.yml value can't produce an empty (e.g. size=0) or
 * pathological query.
 * @param {unknown} val
 * @param {number} def
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function intInRange(val, def, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
