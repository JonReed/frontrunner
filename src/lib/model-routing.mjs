#!/usr/bin/env node
/**
 * model-routing.mjs — which model runs an operation, and how hard it thinks.
 *
 * Some operations are extraction: find a fact in a document and quote it. They
 * do not need the expensive model and they do not need extended thinking. This
 * module is the single place that decides that, so the next call site reuses a
 * decision instead of inheriting whatever the CLI defaults to.
 *
 * Measured on a real 7.5 KB CV through the production profile-extraction path
 * (2026-08-01, `claude` CLI, one CV, three runs per configuration):
 *
 *   | configuration                        | wall     | cost/run | values |
 *   |--------------------------------------|----------|----------|--------|
 *   | no --model, thinking on (the default)| 13.8s    | $0.0486  | —      |
 *   | --model haiku, thinking on           | 71.8s    | $0.0408  | 7/7    |
 *   | --model haiku, thinking OFF          | 8.4-10s  | $0.0088  | 7/7    |
 *
 * Two findings drove this file. The default routed a single extraction across
 * BOTH Sonnet 5 and Haiku because nothing asked for a model. And extended
 * thinking dominated everything else: 4,795-7,031 output tokens for a
 * 265-token answer, nearly all of it invisible, with 50-75s time-to-first-token.
 * Turning it off is a bigger win than the model choice and costs no accuracy on
 * this task — every extracted value was correct in every run either way.
 *
 * `--effort low` is NOT a substitute. Measured at 48s, because it trims the
 * thinking budget rather than removing it.
 *
 * WHAT NOT TO ROUTE HERE: judgement. Scoring an offer, tailoring a CV and
 * writing a cover letter are the work this product exists to do well, and they
 * follow the user's `spend_tier` (see modes/_shared.md). Extraction is not
 * judgement — it is find-and-quote over a document the user then reviews field
 * by field before anything is written.
 */

/**
 * The cheapest capable model per supported agent CLI.
 *
 * Only `claude` is used by this repo's own code: nothing in src/ or ui/ spawns
 * another CLI. The other entries exist for the mode-level routing table in
 * modes/_shared.md, which an agent host reads when it runs a mode itself.
 *
 * These names are unverifiable from inside this project and vendors rename
 * models. Every consumer must therefore treat an unknown name as "use the
 * CLI's default" rather than failing the operation — a routing preference is
 * never worth a dead end in front of a user.
 */
export const SMALL_MODEL = Object.freeze({
  claude: 'haiku',
  codex: 'luna',
});

/** CLI flags that pin the small model and switch extended thinking off. */
export function smallModelArgs(cli = 'claude') {
  if (cli !== 'claude') {
    throw new Error(`model-routing: this repo only spawns the claude CLI, got ${cli}`);
  }
  return [
    '--model', SMALL_MODEL.claude,
    // The settings flag rather than --effort: effort trims the thinking budget,
    // this removes it. See the measurements above.
    '--settings', JSON.stringify({ alwaysThinkingEnabled: false }),
  ];
}
