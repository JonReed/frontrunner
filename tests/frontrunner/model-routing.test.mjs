/**
 * Small-model routing for extraction operations.
 *
 * Before this existed, profile extraction passed no model and no thinking
 * setting, so it inherited the CLI default: one extraction spread across two
 * models, 70 seconds of thinking to locate an email address, and $0.0486 a run.
 * Nobody chose any of that — it was the absence of a choice.
 *
 * These assertions pin the choice. The expensive failure is silent: dropping
 * either flag still produces correct output, just slowly and at 5.5x the cost,
 * so nothing but a test would notice.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ROOT } from '#paths';
import { SMALL_MODEL, smallModelArgs } from '../../src/lib/model-routing.mjs';
import { buildProfileExtractionClaudeArgs } from '../../src/application/profile-extraction.mjs';

test('the small-model flags pin both the model and thinking', () => {
  const args = smallModelArgs();
  const modelIndex = args.indexOf('--model');
  assert.ok(modelIndex >= 0, 'a model must be named, never left to the CLI default');
  assert.equal(args[modelIndex + 1], SMALL_MODEL.claude);

  const settingsIndex = args.indexOf('--settings');
  assert.ok(settingsIndex >= 0, 'thinking must be switched off explicitly');
  assert.deepEqual(JSON.parse(args[settingsIndex + 1]), { alwaysThinkingEnabled: false });

  // --effort is not a substitute: measured at 48s because it trims the
  // thinking budget rather than removing it.
  assert.ok(!args.includes('--effort'), '--effort trims thinking, it does not remove it');
});

test('profile extraction runs on the small model with thinking off', () => {
  const args = buildProfileExtractionClaudeArgs();
  assert.equal(args[args.indexOf('--model') + 1], SMALL_MODEL.claude);
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { alwaysThinkingEnabled: false });
  // The zero-tools boundary is what keeps a model that reads an untrusted CV
  // harmless. Routing must never disturb it.
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
});

test('only the claude CLI is spawned by this repo', () => {
  // modes/_shared.md carries the routing for hosts that run modes themselves.
  // Pretending this repo can spawn them would be a lie with a plausible shape.
  assert.throws(() => smallModelArgs('codex'), /only spawns the claude CLI/);
  assert.throws(() => smallModelArgs('antigravity'), /only spawns the claude CLI/);
});

test('the mode routing table names the economy model for each supported CLI', () => {
  const shared = readFileSync(join(ROOT, 'modes', '_shared.md'), 'utf-8');
  const claudeRow = shared.split('\n').find((line) => line.startsWith('| Claude Code |'));
  const codexRow = shared.split('\n').find((line) => line.startsWith('| Codex |'));
  assert.ok(claudeRow && codexRow, 'both supported CLIs need a routing row');
  assert.match(claudeRow, /Haiku/i);
  assert.match(codexRow, new RegExp(SMALL_MODEL.codex, 'i'));

  // A named model is a preference. If the CLI does not know the name the run
  // must continue on its default — a routing hint is never worth a dead end.
  assert.match(shared, /if that name is not available|fall back to its cheapest available model/i);
  assert.match(shared, /Extraction is not judgement/);
});

test('the prompt asks for an honest basis on derived values', () => {
  // Haiku labelled a postcode-derived country as basis "explicit" while its own
  // evidence text admitted deriving it. The user reads the evidence; the code
  // reads the field. They must not disagree.
  const source = readFileSync(join(ROOT, 'src', 'application', 'profile-extraction.mjs'), 'utf-8');
  assert.match(source, /basis "explicit" means the value is written in the CV/);
  assert.match(source, /mark it "suggested" and say what you derived it from/);
});
