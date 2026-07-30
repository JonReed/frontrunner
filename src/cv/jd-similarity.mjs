/**
 * Deterministic CV-reuse recommendation for two job descriptions.
 *
 * This module never reads arbitrary paths, evaluates a role, or mutates an
 * artifact. Callers provide already-bounded JD text from the canonical cache.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'for', 'from', 'have', 'in', 'not', 'of', 'on',
  'or', 'our', 'that', 'the', 'this', 'to', 'will', 'with', 'you', 'your',
  '以及', '具备', '岗位', '工作', '相关', '能够', '负责', '进行', '通过', '需要',
]);

const LEVELS = [
  ['intern', '应届', '实习', '实习生'],
  ['junior', '初级'],
  ['mid', '中级'],
  ['senior', '资深', '高级'],
  ['staff', 'principal', 'lead', '负责人'],
];

export function tokenizeJobDescription(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}+#./-]+/gu)
      ?.map(token => token.replace(/^[./-]+|[./-]+$/g, ''))
      .filter(token => token && (token.length > 1 || /\d/.test(token)) && !STOP_WORDS.has(token))
      ?? [],
  );
}

export function jaccardSimilarity(left, right) {
  const a = left instanceof Set ? left : tokenizeJobDescription(left);
  const b = right instanceof Set ? right : tokenizeJobDescription(right);
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function seniorityLevel(text) {
  const normalized = String(text ?? '').toLowerCase();
  return LEVELS.findIndex(words => words.some(word => {
    if (/^\p{Script=Han}+$/u.test(word)) return normalized.includes(word);
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(normalized);
  }));
}

export function recommendCvReuse(currentJd, previousJd, options = {}) {
  const highThreshold = Number(options.highThreshold ?? 0.72);
  const mediumThreshold = Number(options.mediumThreshold ?? 0.45);
  const minTokens = Number(options.minTokens ?? 20);
  if (
    !Number.isFinite(highThreshold)
    || !Number.isFinite(mediumThreshold)
    || mediumThreshold < 0
    || highThreshold > 1
    || mediumThreshold > highThreshold
    || !Number.isSafeInteger(minTokens)
    || minTokens < 1
  ) {
    throw new TypeError(
      'similarity options require 0 <= medium <= high <= 1 and a positive integer minTokens',
    );
  }

  const currentTokens = tokenizeJobDescription(currentJd);
  const previousTokens = tokenizeJobDescription(previousJd);
  const score = jaccardSimilarity(currentTokens, previousTokens);
  if (currentTokens.size < minTokens || previousTokens.size < minTokens) {
    return { decision: 'regenerate', score, reason: 'insufficient-content' };
  }
  const currentLevel = seniorityLevel(currentJd);
  const previousLevel = seniorityLevel(previousJd);
  if (currentLevel >= 0 && previousLevel >= 0 && currentLevel !== previousLevel) {
    return { decision: 'regenerate', score, reason: 'level-mismatch' };
  }
  if (score >= highThreshold) {
    return { decision: 'reuse', score, reason: 'high-similarity' };
  }
  if (score >= mediumThreshold) {
    return { decision: 'reuse-with-edits', score, reason: 'medium-similarity' };
  }
  return { decision: 'regenerate', score, reason: 'low-similarity' };
}
