// tests/token-tracker.test.mjs — token tracking & cost estimation unit tests
import { pass, fail } from './helpers.mjs';
import { estimateCost, TokenAccumulator, formatBreakdown } from '../src/lib/token-tracker.mjs';
import { parseTokenVal } from '../batch/aggregate-tokens.mjs';

console.log('\ntoken-tracker.mjs & aggregate-tokens.mjs unit tests');

try {
  // 1. parseTokenVal (from batch/aggregate-tokens.mjs)
  const val1 = parseTokenVal('12.4k');
  const val2 = parseTokenVal('1,234');
  const val3 = parseTokenVal('');
  const val4 = parseTokenVal('500');

  if (val1 === 12400 && val2 === 1234 && val3 === 0 && val4 === 500) {
    pass('parseTokenVal correctly parses "12.4k" → 12400, "1,234" → 1234, "" → 0, "500" → 500');
  } else {
    fail(`parseTokenVal failed: val1=${val1}, val2=${val2}, val3=${val3}, val4=${val4}`);
  }

  // 2. estimateCost for a known Claude model.
  // RATES['claude-3-5-haiku'] = { input: 0.80 / 1e6, output: 4.00 / 1e6 }
  // 1000 input = $0.0008, 500 output = $0.0020 -> total $0.0028
  const usage = { prompt_tokens: 1000, completion_tokens: 500, cached_tokens: 0 };
  const costKnown = estimateCost('claude-3-5-haiku', usage, 'claude');
  const expectedCost = 0.0028;
  if (costKnown !== null && Math.abs(costKnown - expectedCost) < 1e-9) {
    pass('estimateCost for claude-3-5-haiku matches hand-calculated cost ($0.0028)');
  } else {
    fail(`estimateCost for claude-3-5-haiku failed: expected ${expectedCost}, got ${costKnown}`);
  }

  // 3. An unpriced provider must return null rather than a guessed number.
  // The OpenRouter/Ollama exemptions went with those evaluators; inventing a
  // price for an unknown provider would be worse than admitting we don't know.
  const removedProviderCost = estimateCost('llama3:latest', usage, 'ollama');
  if (removedProviderCost === null) {
    pass('a provider Frontrunner no longer supports yields null, not a fabricated cost');
  } else {
    fail(`removed-provider cost failed: expected null, got ${removedProviderCost}`);
  }

  // 5. Unknown model/provider fallback → estimateCost returns null
  const unknownCost = estimateCost('completely-unknown-model-xyz', usage, 'unknown-provider');
  if (unknownCost === null) {
    pass('Unknown model/provider fallback returns null for estimateCost');
  } else {
    fail(`Unknown model fallback failed: expected null, got ${unknownCost}`);
  }

  // 6. formatBreakdown renders "est. cost n/a" (not $0.0000) when cost is null
  const accNull = new TokenAccumulator();
  accNull.record('evaluation', { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
  const breakdownNull = formatBreakdown(accNull, 'completely-unknown-model-xyz', 'unknown-provider');
  if (breakdownNull.includes('est. cost n/a') && !breakdownNull.includes('$0.0000')) {
    pass('formatBreakdown renders "est. cost n/a" (not $0.0000) when cost is null');
  } else {
    fail(`formatBreakdown null cost rendering failed:\n${breakdownNull}`);
  }

  // 7. formatBreakdown renders a zero-token step as "(zero-token by design)"
  const accZero = new TokenAccumulator();
  accZero.recordZeroToken('scan');
  accZero.record('evaluation', { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 });
  const breakdownZero = formatBreakdown(accZero, 'gpt-4o-mini', 'openai');
  if (breakdownZero.includes('(zero-token by design)')) {
    pass('formatBreakdown renders zero-token step as "(zero-token by design)"');
  } else {
    fail(`formatBreakdown zero-token step rendering failed:\n${breakdownZero}`);
  }
} catch (e) {
  fail(`token-tracker tests crashed: ${e.message}`);
}
