/**
 * Mandatory deterministic boundary in front of every model-backed evaluation.
 *
 * Evaluators must call this before constructing a provider request. A rejected
 * result is final and auditable; an unclear title is deliberately kept.
 */

import { classify } from '../scan/prefilter.mjs';

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
} = {}) {
  const metadata = extractEvaluationMetadata(jdText, { title, company });
  const decision = classify(metadata.title, String(jdText ?? ''), profile, rules);
  return {
    gate: 'deterministic-prefilter',
    allowed: decision.verdict === 'keep',
    title: metadata.title,
    company: metadata.company,
    ...decision,
  };
}

export function formatGateRejection(result) {
  if (result?.allowed) return '';
  const role = result?.title || 'unknown role';
  const evidence = result?.evidence ? `; evidence: ${result.evidence}` : '';
  return `Evaluation stopped before the model call: ${role} matched ${result?.rule || 'a deterministic rejection rule'}${evidence}.`;
}
