/**
 * Mandatory deterministic boundary in front of every model-backed evaluation.
 *
 * Evaluators must call this before constructing a provider request. A rejected
 * result is final and auditable; an unclear title is deliberately kept.
 */

import { classify } from '../scan/prefilter.mjs';
import {
  PREFILTER_OVERRIDE_URL_ENV,
  matchingPrefilterOverride,
  readPrefilterOverrides,
} from '../scan/prefilter-overrides.mjs';

export function extractEvaluationMetadata(jdText, fallback = {}) {
  const text = String(jdText ?? '');
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const labelledTitle = text.match(/^\s*(?:job\s+)?title:\s*(.+)$/im)?.[1]?.trim();
  const labelledCompany = text.match(/^\s*company:\s*(.+)$/im)?.[1]?.trim();
  const fallbackTitle = String(fallback.title ?? '').trim();
  const fallbackCompany = String(fallback.company ?? '').trim();

  return {
    title: fallbackTitle || labelledTitle || heading || '',
    company: fallbackCompany || labelledCompany || '',
  };
}

export function evaluateDeterministicGate({
  jdText,
  title = '',
  company = '',
  profile,
  rules,
  sourceUrl = process.env[PREFILTER_OVERRIDE_URL_ENV] ?? '',
  overrides,
} = {}) {
  const metadata = extractEvaluationMetadata(jdText, { title, company });
  const decision = classify(metadata.title, String(jdText ?? ''), profile, rules);
  const override = decision.verdict === 'reject' && sourceUrl
    ? matchingPrefilterOverride(
      sourceUrl,
      decision.rule,
      overrides ?? readPrefilterOverrides(),
    )
    : null;
  return {
    gate: 'deterministic-prefilter',
    allowed: decision.verdict === 'keep' || Boolean(override),
    title: metadata.title,
    company: metadata.company,
    ...decision,
    ...(override ? {
      verdict: 'keep',
      rule: 'user_override',
      overriddenRule: decision.rule,
      overrideRecordedAt: override.recordedAt,
    } : {}),
  };
}

export function formatGateRejection(result) {
  if (result?.allowed) return '';
  const role = result?.title || 'unknown role';
  const evidence = result?.evidence ? `; evidence: ${result.evidence}` : '';
  return `Evaluation stopped before the model call: ${role} matched ${result?.rule || 'a deterministic rejection rule'}${evidence}.`;
}
