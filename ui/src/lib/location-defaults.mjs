/**
 * Safe defaults from an explicitly entered location.
 *
 * These are deliberately conservative. A country with multiple time zones
 * gets no guessed time zone; an unrecognised location gets no guessed country
 * or currency. The UK is unambiguous for the fields Frontrunner needs here.
 */
const UK_SUFFIX = /(?:,?\s*)(?:uk|u\.k\.|united kingdom|england|scotland|wales|northern ireland)\s*$/iu;

export function locationDefaults(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { city: '', country: '', timezone: '', currency: '' };

  if (UK_SUFFIX.test(raw)) {
    return {
      city: raw.replace(UK_SUFFIX, '').replace(/[\s,]+$/u, ''),
      country: 'United Kingdom',
      timezone: 'Europe/London',
      currency: 'GBP',
    };
  }

  return { city: raw, country: '', timezone: '', currency: '' };
}
