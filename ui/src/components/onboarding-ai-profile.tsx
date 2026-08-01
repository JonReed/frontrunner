'use client';

import { useEffect, useState } from 'react';
import { extractCvProfile } from '@/app/actions';
import { AiButton } from '@/components/ai-button';
import { ConnectButton } from '@/components/connect-button';
import { ReconnectNotice, isSignInFailure } from '@/components/reconnect-notice';
import {
  currentProposalValue,
  type AiProfileDraft,
} from '@/lib/onboarding-profile-proposals';
import type { ProfileExtraction, ProfileProposal } from '@/lib/profile-save';

const LABEL: Record<string, string> = {
  'candidate.full_name': 'Full name',
  'candidate.email': 'Email',
  'candidate.phone': 'Phone',
  'candidate.location': 'Location',
  'candidate.linkedin': 'LinkedIn',
  'candidate.portfolio_url': 'Portfolio',
  'candidate.github': 'GitHub',
  'location.city': 'Search area',
  'location.country': 'Search country',
  'location.timezone': 'Timezone',
  'location.visa_status': 'Work authorisation',
  'target_roles.primary': 'Suggested job title',
  'compensation.currency': 'Salary currency',
  'compensation.target_range': 'Target pay',
  'compensation.minimum': 'Lowest figure',
  'compensation.location_flexibility': 'Working pattern',
};

export function OnboardingAiProfile({
  cv,
  draft,
  engine,
  onApply,
}: {
  cv: string;
  draft: AiProfileDraft;
  engine: { installed: boolean; signedIn: boolean };
  onApply: (proposals: ProfileProposal[]) => void;
}) {
  const [extracting, setExtracting] = useState(false);
  const [extraction, setExtraction] = useState<ProfileExtraction | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(0);

  useEffect(() => {
    setExtraction(null);
    setSelected(new Set());
    setError(null);
    setApplied(0);
  }, [cv]);

  const askClaude = async () => {
    setExtracting(true);
    setError(null);
    setApplied(0);
    const result = await extractCvProfile(cv);
    setExtracting(false);
    if ('error' in result) {
      setExtraction(null);
      setSelected(new Set());
      setError(result.error);
      return;
    }
    setExtraction(result);
    setSelected(new Set(
      result.proposals
        .filter(proposal => proposal.basis === 'explicit'
          && proposal.confidence === 'high'
          && !currentProposalValue(draft, proposal).trim())
        .map(proposal => proposal.path),
    ));
  };

  const apply = () => {
    if (!extraction) return;
    const proposals = extraction.proposals.filter(proposal => selected.has(proposal.path));
    onApply(proposals);
    setApplied(proposals.length);
  };

  return (
    <section className="mt-8 rounded-xl border border-[var(--color-ai)]/30 bg-[var(--color-ai)]/5 p-5">
      <p className="page-eyebrow text-[var(--color-ai)]">Your first AI-assisted step</p>
      <h3 className="mt-1 text-lg font-bold">Let Claude find the details already in your CV</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">
        Whenever Frontrunner needs AI, the action uses this violet button with a sparkle.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">
        Pressing it sends the CV text you reviewed above to Claude through your connected Claude
        subscription. The usage comes out of that subscription&apos;s allowance. Frontrunner never
        receives your Claude password or subscription credentials.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-soft)]">
        Claude can only suggest values. Nothing is added to your form until you choose it, and
        nothing is saved to your profile until you finish onboarding.
      </p>

      <div className="mt-4">
        <AiButton
          what="find profile details already stated in your CV"
          onClick={askClaude}
          disabled={extracting || !engine.signedIn}
        >
          {extracting ? 'Claude is reading your CV…' : 'Find details in my CV'}
        </AiButton>
        {!engine.signedIn && engine.installed && (
          <div className="mt-4">
            <p className="mb-3 text-sm font-medium text-[var(--color-attention)]">
              Connect your Claude subscription to enable this AI action.
            </p>
            <ConnectButton />
          </div>
        )}
        {!engine.signedIn && !engine.installed && (
          <p className="mt-4 text-sm text-[var(--color-ink-soft)]">
            Install{' '}
            <a
              href="https://claude.ai/code"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[var(--color-act)] underline underline-offset-2"
            >
              Claude Code
            </a>
            {' '}and reload to enable this optional AI action. You can continue onboarding without it.
          </p>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-[var(--color-attention)] bg-[var(--color-attention-wash)] px-3.5 py-3 text-sm text-[var(--color-ink-soft)]">
          {/*
            A sign-in failure carries its own remedy. Onboarding is the one
            place where prose pointing at "My details" is worst: that page does
            not exist yet for someone who has not finished setup.
          */}
          {isSignInFailure(error) ? <ReconnectNotice message={error} /> : error}
        </div>
      )}

      {extraction && (
        <div className="mt-5">
          <p className="text-sm font-semibold">Review Claude&apos;s suggestions</p>
          <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
            Clear facts for empty fields are selected. Suggestions and replacements wait for you
            to choose them.
          </p>
          {extraction.proposals.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {extraction.proposals.map(proposal => (
                <ProposalChoice
                  key={proposal.path}
                  proposal={proposal}
                  current={currentProposalValue(draft, proposal).trim()}
                  selected={selected.has(proposal.path)}
                  onChange={(checked) => setSelected(previous => {
                    const next = new Set(previous);
                    if (checked) next.add(proposal.path);
                    else next.delete(proposal.path);
                    return next;
                  })}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
              Claude did not find any details it could support confidently. You can fill them in
              yourself on the next screens.
            </p>
          )}
          {extraction.warnings.map(warning => (
            <p key={warning} className="mt-2 text-xs text-[var(--color-ink-faint)]">{warning}</p>
          ))}
          {extraction.proposals.length > 0 && (
            <button
              type="button"
              onClick={apply}
              disabled={selected.size === 0}
              className="mt-4 cursor-pointer rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-card)] px-3.5 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:border-[var(--color-ai)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Use selected details
            </button>
          )}
          {applied > 0 && (
            <p className="mt-3 text-sm font-medium text-[var(--color-ready)]">
              Added {applied} suggestion{applied === 1 ? '' : 's'} to the form. Check them on the
              next screens.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ProposalChoice({
  proposal,
  current,
  selected,
  onChange,
}: {
  proposal: ProfileProposal;
  current: string;
  selected: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-card)] p-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={event => onChange(event.target.checked)}
          className="mt-1 size-4 shrink-0 accent-[var(--color-ai)]"
        />
        <span className="min-w-0">
          <span className="block text-sm font-semibold">
            {LABEL[proposal.path] ?? proposal.path}: {proposal.value}
          </span>
          <span className="mt-0.5 block text-xs text-[var(--color-ink-faint)]">
            {proposal.basis === 'suggested' ? 'Suggested from your experience' : 'Found explicitly'}
            {' · '}{proposal.confidence} confidence
            {current ? ` · would replace “${current}”` : ''}
          </span>
          <span className="mt-1 block text-xs italic text-[var(--color-ink-soft)]">
            Evidence: “{proposal.evidence}”
          </span>
        </span>
      </label>
    </li>
  );
}
