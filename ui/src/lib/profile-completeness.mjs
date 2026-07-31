/**
 * The profile contract exposed to people, rather than just the YAML keys the
 * writer happens to accept.
 *
 * A file existing is not the same thing as a useful profile. Keep the required
 * and recommended checks here so onboarding, the profile page and regression
 * tests cannot quietly disagree about what “done” means.
 */

export const PROFILE_COMPLETENESS_FIELDS = Object.freeze([
  {
    id: 'cv',
    label: 'CV',
    priority: 'required',
    reason: 'Frontrunner needs your CV to compare roles with your experience.',
  },
  {
    id: 'full_name',
    path: 'candidate.full_name',
    label: 'Full name',
    priority: 'required',
    reason: 'Used on tailored CVs and application material.',
  },
  {
    id: 'email',
    path: 'candidate.email',
    label: 'Email',
    priority: 'required',
    reason: 'Used to identify you in application material and tracker notes.',
  },
  {
    id: 'location',
    path: 'candidate.location',
    label: 'Where you are',
    priority: 'required',
    reason: 'Used for commute, location and remote-work matching.',
  },
  {
    id: 'target_roles',
    path: 'target_roles.primary',
    label: 'Target job titles',
    priority: 'required',
    reason: 'The scanner uses these to find relevant openings.',
  },
  {
    id: 'target_range',
    path: 'compensation.target_range',
    label: 'Target pay',
    priority: 'recommended',
    reason: 'Lets scoring distinguish attractive roles from roles below your aim.',
  },
  {
    id: 'currency',
    path: 'compensation.currency',
    label: 'Salary currency',
    priority: 'recommended',
    reason: 'Prevents pay comparisons being made in the wrong currency.',
  },
  {
    id: 'working_pattern',
    path: 'compensation.location_flexibility',
    label: 'Working pattern',
    priority: 'recommended',
    reason: 'Lets the filter reject roles that cannot work for you.',
  },
  {
    id: 'search_country',
    path: 'location.country',
    label: 'Search country',
    priority: 'recommended',
    reason: 'Makes country-specific source and work-authorisation decisions reliable.',
  },
  {
    id: 'timezone',
    path: 'location.timezone',
    label: 'Timezone',
    priority: 'recommended',
    reason: 'Helps with working-hours and location comparisons.',
  },
  {
    id: 'spend_tier',
    path: 'spend_tier',
    label: 'AI usage level',
    priority: 'recommended',
    reason: 'Controls how much of your own AI allowance each assessment uses.',
  },
  {
    id: 'phone',
    path: 'candidate.phone',
    label: 'Phone',
    priority: 'optional',
    reason: 'Useful for applications, but never required to search.',
  },
  {
    id: 'linkedin',
    path: 'candidate.linkedin',
    label: 'LinkedIn',
    priority: 'optional',
    reason: 'Useful context for applications and outreach.',
  },
  {
    id: 'portfolio_url',
    path: 'candidate.portfolio_url',
    label: 'Portfolio',
    priority: 'optional',
    reason: 'Adds evidence when a role asks for public work.',
  },
  {
    id: 'github',
    path: 'candidate.github',
    label: 'GitHub',
    priority: 'optional',
    reason: 'Adds evidence for roles where public code is relevant.',
  },
  {
    id: 'minimum',
    path: 'compensation.minimum',
    label: 'Walk-away number',
    priority: 'optional',
    reason: 'A private floor for filtering; leave blank if you do not use one.',
  },
  {
    id: 'visa_status',
    path: 'location.visa_status',
    label: 'Work authorisation',
    priority: 'optional',
    reason: 'Only needed when work permission or sponsorship affects your search.',
  },
  {
    id: 'authorized_in',
    path: 'location.authorized_in',
    label: 'Countries you can work in',
    priority: 'optional',
    reason: 'Provides structured evidence for work-authorisation checks.',
  },
  {
    id: 'needs_sponsorship',
    path: 'location.needs_sponsorship',
    label: 'Sponsorship requirement',
    priority: 'optional',
    reason: 'Prevents eligibility being inferred from ambiguous free text.',
  },
]);

function present(value) {
  if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && item.trim());
  return typeof value === 'string' ? Boolean(value.trim()) : value !== null && value !== undefined;
}

export function profileCompleteness({ fields = {}, hasCv = false } = {}) {
  const checks = PROFILE_COMPLETENESS_FIELDS.map((definition) => {
    const complete = definition.id === 'cv' ? hasCv : present(fields[definition.path]);
    return Object.freeze({ ...definition, complete });
  });
  const missing = checks.filter((check) => !check.complete);
  return Object.freeze({
    checks: Object.freeze(checks),
    missing: Object.freeze(missing),
    requiredMissing: Object.freeze(missing.filter((check) => check.priority === 'required')),
    recommendedMissing: Object.freeze(missing.filter((check) => check.priority === 'recommended')),
    optionalMissing: Object.freeze(missing.filter((check) => check.priority === 'optional')),
    ready: missing.every((check) => check.priority !== 'required'),
  });
}

/** Convert the setup draft into the same field map used by profile pages. */
export function onboardingCompleteness(draft) {
  return profileCompleteness({
    hasCv: Boolean(draft?.cv?.trim()),
    fields: {
      'candidate.full_name': draft?.fullName ?? '',
      'candidate.email': draft?.email ?? '',
      'candidate.location': draft?.location ?? '',
      'candidate.phone': draft?.phone ?? '',
      'candidate.linkedin': draft?.linkedin ?? '',
      'candidate.portfolio_url': draft?.portfolioUrl ?? '',
      'candidate.github': draft?.github ?? '',
      'target_roles.primary': String(draft?.targetRoles ?? '').split(/\r?\n/u).filter(Boolean),
      'compensation.target_range': draft?.salaryTarget ?? '',
      'compensation.minimum': draft?.minimumSalary ?? '',
      'compensation.currency': draft?.salaryCurrency ?? '',
      'compensation.location_flexibility': draft?.remote ? String(draft.remote) : '',
      'location.country': draft?.country ?? '',
      'location.city': draft?.city ?? '',
      'location.timezone': draft?.timezone ?? '',
      'location.visa_status': draft?.visaStatus ?? '',
      'location.authorized_in': String(draft?.authorizedIn ?? '').split(/\r?\n/u).filter(Boolean),
      'location.needs_sponsorship': draft?.needsSponsorship === 'unsure'
        ? undefined
        : draft?.needsSponsorship === 'yes',
      spend_tier: draft?.spendTier ?? '',
    },
  });
}
