/**
 * "/welcome" — first run.
 *
 * Reached automatically when the required user-layer files are missing, so
 * nobody arrives at an empty Next up screen and has to work out why the
 * product appears to do nothing.
 *
 * If setup is already done this redirects away rather than offering to redo
 * it: an onboarding screen that stays reachable invites someone to overwrite
 * their own CV months later.
 */

import { redirect } from 'next/navigation';
import { existsSync, readFileSync } from 'node:fs';
import { readSetup } from '@/lib/setup';
import { SetupFlow } from '@/components/setup-flow';
import { readProfileSnapshot } from '@/lib/profile-save';
import { readHealth } from '@/lib/health';
import { WORKSPACE } from '@/lib/root';

export const dynamic = 'force-dynamic';

function text(fields: Record<string, string | string[] | boolean>, path: string): string {
  return typeof fields[path] === 'string' ? fields[path] as string : '';
}

function booleanChoice(fields: Record<string, string | string[] | boolean>, path: string): 'yes' | 'no' | 'unsure' {
  return fields[path] === true ? 'yes' : fields[path] === false ? 'no' : 'unsure';
}

function remoteValue(value: string): 'remote' | 'hybrid' | 'onsite' | '' {
  const normalized = value.toLocaleLowerCase('en');
  if (normalized.includes('remote')) return 'remote';
  if (normalized.includes('hybrid')) return 'hybrid';
  if (normalized.includes('on site') || normalized.includes('onsite')) return 'onsite';
  return '';
}

export default async function WelcomePage() {
  const { needed } = readSetup();
  if (!needed) redirect('/');

  const [snapshot, health] = await Promise.all([readProfileSnapshot(), readHealth()]);
  const fields = snapshot.fields;
  const roles = Array.isArray(fields['target_roles.primary'])
    ? fields['target_roles.primary'].join('\n')
    : '';
  const cv = existsSync(WORKSPACE.cv) ? readFileSync(WORKSPACE.cv, 'utf8') : '';

  return (
    <SetupFlow
      engine={{ installed: health.installed, signedIn: health.signedIn }}
      initial={{
        cv,
        fullName: text(fields, 'candidate.full_name'),
        email: text(fields, 'candidate.email'),
        phone: text(fields, 'candidate.phone'),
        linkedin: text(fields, 'candidate.linkedin'),
        portfolioUrl: text(fields, 'candidate.portfolio_url'),
        github: text(fields, 'candidate.github'),
        location: text(fields, 'candidate.location'),
        country: text(fields, 'location.country'),
        city: text(fields, 'location.city'),
        timezone: text(fields, 'location.timezone'),
        visaStatus: text(fields, 'location.visa_status'),
        authorizedIn: Array.isArray(fields['location.authorized_in'])
          ? fields['location.authorized_in'].join('\n')
          : '',
        needsSponsorship: booleanChoice(fields, 'location.needs_sponsorship'),
        targetRoles: roles,
        salaryTarget: text(fields, 'compensation.target_range'),
        minimumSalary: text(fields, 'compensation.minimum'),
        salaryCurrency: text(fields, 'compensation.currency'),
        remote: remoteValue(text(fields, 'compensation.location_flexibility')),
        spendTier: (['economy', 'standard', 'premium'].includes(text(fields, 'spend_tier'))
          ? text(fields, 'spend_tier')
          : 'standard') as 'economy' | 'standard' | 'premium',
        outputLanguage: text(fields, 'language.output') || 'en',
      }}
    />
  );
}
