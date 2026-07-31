import type { ProfileProposal } from './profile-save';

export interface AiProfileDraft {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  portfolioUrl: string;
  github: string;
  city: string;
  country: string;
  timezone: string;
  visaStatus: string;
  targetRoles: string;
  salaryCurrency: string;
  salaryTarget: string;
  minimumSalary: string;
  remote: 'remote' | 'hybrid' | 'onsite' | '';
}

export function currentProposalValue(
  source: AiProfileDraft,
  proposal: ProfileProposal,
): string {
  const values: Record<string, string> = {
    'candidate.full_name': source.fullName,
    'candidate.email': source.email,
    'candidate.phone': source.phone,
    'candidate.location': source.location,
    'candidate.linkedin': source.linkedin,
    'candidate.portfolio_url': source.portfolioUrl,
    'candidate.github': source.github,
    'location.city': source.city,
    'location.country': source.country,
    'location.timezone': source.timezone,
    'location.visa_status': source.visaStatus,
    'target_roles.primary': source.targetRoles,
    'compensation.currency': source.salaryCurrency,
    'compensation.target_range': source.salaryTarget,
    'compensation.minimum': source.minimumSalary,
    'compensation.location_flexibility': source.remote,
  };
  return values[proposal.path] ?? '';
}

export function applyProfileProposal<T extends AiProfileDraft>(
  source: T,
  proposal: ProfileProposal,
): T {
  const value = proposal.value.trim();
  switch (proposal.path) {
    case 'candidate.full_name': return { ...source, fullName: value };
    case 'candidate.email': return { ...source, email: value };
    case 'candidate.phone': return { ...source, phone: value };
    case 'candidate.location': return { ...source, location: value };
    case 'candidate.linkedin': return { ...source, linkedin: value };
    case 'candidate.portfolio_url': return { ...source, portfolioUrl: value };
    case 'candidate.github': return { ...source, github: value };
    case 'location.city': return { ...source, city: value };
    case 'location.country': return { ...source, country: value };
    case 'location.timezone': return { ...source, timezone: value };
    case 'location.visa_status': return { ...source, visaStatus: value };
    case 'compensation.currency': return { ...source, salaryCurrency: value.toUpperCase() };
    case 'compensation.target_range': return { ...source, salaryTarget: value };
    case 'compensation.minimum': return { ...source, minimumSalary: value };
    case 'compensation.location_flexibility': {
      const normalized = value.toLocaleLowerCase('en');
      const remote = normalized.includes('hybrid')
        ? 'hybrid'
        : normalized.includes('remote')
          ? 'remote'
          : normalized.includes('on-site')
              || normalized.includes('onsite')
              || normalized.includes('on site')
            ? 'onsite'
            : '';
      return remote ? { ...source, remote } : source;
    }
    case 'target_roles.primary': {
      const roles = source.targetRoles.split(/\r?\n/u).map(role => role.trim()).filter(Boolean);
      if (roles.some(role => role.toLocaleLowerCase('en') === value.toLocaleLowerCase('en'))) return source;
      return { ...source, targetRoles: [...roles, value].join('\n') };
    }
    default: return source;
  }
}
