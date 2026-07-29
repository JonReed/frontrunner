/**
 * The editable profile is deliberately described in one small, inert module.
 *
 * The application service remains the authority on what may be written. This
 * is only presentation metadata shared by the form and its regression tests,
 * so a newly exposed preference cannot quietly disappear on the next redesign.
 */
export const PROFILE_DETAIL_SECTIONS = [
  {
    title: 'About you',
    fields: [
      { path: 'candidate.full_name', label: 'Full name', placeholder: 'Jane Smith' },
      { path: 'candidate.email', label: 'Email', placeholder: 'jane@example.com' },
      { path: 'candidate.phone', label: 'Phone', placeholder: 'Optional' },
      { path: 'candidate.location', label: 'Where you are', placeholder: 'Manchester, UK' },
      { path: 'candidate.linkedin', label: 'LinkedIn', placeholder: 'Optional' },
    ],
  },
  {
    title: 'Search preferences',
    fields: [
      {
        path: 'compensation.location_flexibility',
        label: 'Working pattern',
        placeholder: 'Remote preferred; hybrid in London',
      },
      { path: 'location.city', label: 'Search city', placeholder: 'London' },
      { path: 'location.country', label: 'Search country', placeholder: 'United Kingdom' },
      { path: 'location.timezone', label: 'Timezone', placeholder: 'Europe/London' },
      {
        path: 'location.visa_status',
        label: 'Work authorisation',
        placeholder: 'No sponsorship required',
      },
      { path: 'compensation.target_range', label: 'Salary target', placeholder: '£90k–£110k' },
      { path: 'compensation.minimum', label: 'Walk-away number', placeholder: '£85k' },
      { path: 'compensation.currency', label: 'Salary currency', placeholder: 'GBP' },
    ],
  },
];

export const PROFILE_DETAIL_FIELDS = PROFILE_DETAIL_SECTIONS.flatMap((section) => section.fields);

/**
 * Stop a stray sentence replacing an entire career history. The backend still
 * owns the hard byte limit; this is the human-scale guard immediately before
 * the destructive confirmation.
 */
export function cvReplacementReadiness(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const words = trimmed ? trimmed.split(/\s+/u).length : 0;
  if (!trimmed) return { ready: false, words, reason: 'Paste your CV or choose a file first.' };
  if (trimmed.length < 40 || words < 8) {
    return {
      ready: false,
      words,
      reason: 'That looks too short to be a CV. Check that the whole document was copied.',
    };
  }
  return { ready: true, words, reason: '' };
}
