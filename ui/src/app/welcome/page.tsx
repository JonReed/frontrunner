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
import { readSetup } from '@/lib/setup';
import { SetupFlow } from '@/components/setup-flow';

export const dynamic = 'force-dynamic';

export default function WelcomePage() {
  const { needed } = readSetup();
  if (!needed) redirect('/');

  return <SetupFlow />;
}
