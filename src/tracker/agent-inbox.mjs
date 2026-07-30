#!/usr/bin/env node

/**
 * agent-inbox.mjs — a tiny bridge between *looking at* the pipeline and
 * *acting on* it.
 *
 * frontrunner is driven from an AI session, but there's no durable place to drop
 * a request when you're not in one — e.g. while glancing at the tracker (or a
 * dashboard) you think "evaluate this URL" or "draft a follow-up for #7". This
 * is that place: an append-only queue the agent drains at the start of a
 * session.
 *
 *   workspace/applications/agent-inbox.md
 *     - [ ] <stamp> — <request>          (pending)
 *     - [x] <stamp> — <request> → result: <one line>   (resolved)
 *
 * Fully local-first and human-in-the-loop: nothing here auto-submits. Queued
 * items are *intents* for the agent to action and the user to review. Markdown
 * checklist, no database, no server, no dependencies — edit it by hand or via
 * this CLI, and any tool (a dashboard, a script, cron) can append to it. The
 * protocol an agent follows is documented in modes/agent-inbox.md.
 *
 * Usage:
 *   node src/tracker/agent-inbox.mjs add "evaluate https://acme.com/jobs/42"
 *   node src/tracker/agent-inbox.mjs list [--all]                 # pending only, or every item
 *   node src/tracker/agent-inbox.mjs resolve 1 [--result "scored 4.3 — report 012"]
 */

import { readFileSync, existsSync } from 'fs';

import { mutateFileLocked } from '../lib/locked-file.mjs';

const PATH = process.env.FRONTRUNNER_INBOX || 'workspace/applications/agent-inbox.md';

const HEADER = [
  '# Agent Inbox',
  '',
  '> **Agent protocol:** at the start of a frontrunner session, read this file.',
  '> Run each unchecked item top-to-bottom. After each, mark it `[x]` and append',
  '> `→ result: <one line>`. Items that need live user input (a mock, a paste, a',
  '> decision) → ask the user to start them instead of running them.',
  '>',
  '> Nothing here auto-submits — queued items are *intents* for you to action and',
  '> the user to review. Appended by hand, by a dashboard, or by agent-inbox.mjs.',
  '',
].join('\n');

function stamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

async function ensureGitignored() {
  // The inbox is personal data. On installs whose .gitignore predates this
  // feature, make sure the default path is ignored so a first `add` can't
  // accidentally commit it. Only manages the default, non-overridden path.
  if (process.env.FRONTRUNNER_INBOX || PATH !== 'workspace/applications/agent-inbox.md') return;
  try {
    if (!existsSync('.gitignore')) return; // not a git checkout we should touch
    await mutateFileLocked('.gitignore', (text) => {
      if (text.split('\n').some(line => line.trim() === PATH)) return text;
      return `${text.replace(/\s*$/, '')}\n${PATH}\n`;
    });
  } catch { /* best effort — never block queuing on this */ }
}

function oneLine(s) {
  // markdown-checklist-safe: collapse to a single bullet line
  return String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

// Parse the checklist into items, in file order.
function parseItems(content = null) {
  if (content === null && !existsSync(PATH)) return [];
  const items = [];
  const text = content === null ? readFileSync(PATH, 'utf8') : content;
  text.split('\n').forEach((line, i) => {
    const m = /^- \[([ xX])\]\s*(.*)$/.exec(line.trim());
    if (m) items.push({ line: i, done: m[1].toLowerCase() === 'x', text: m[2] });
  });
  return items;
}

function opt(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}

async function add() {
  const text = oneLine(process.argv.slice(3).join(' '));
  if (!text) fail('add needs a request, e.g. node src/tracker/agent-inbox.mjs add "evaluate https://..."');
  await ensureGitignored();
  await mutateFileLocked(PATH, (current) => {
    const body = (current || HEADER).replace(/\s+$/, '');
    return `${body}\n- [ ] ${stamp()} — ${text}\n`;
  });
  process.stdout.write(`Queued: ${text}\n`);
}

function list() {
  const all = process.argv.includes('--all');
  const items = parseItems().filter((it) => all || !it.done);
  if (!items.length) return process.stdout.write(all ? 'Inbox is empty.\n' : 'No pending items.\n');
  items.forEach((it, n) => {
    process.stdout.write(`${String(n + 1).padStart(2)}. [${it.done ? 'x' : ' '}] ${it.text}\n`);
  });
}

async function resolve() {
  const n = Number(process.argv[3]);
  if (!Number.isInteger(n) || n < 1) fail('resolve needs a 1-based item number (see `list`)');
  const result = oneLine(opt('result'));
  let resolvedText = '';
  await mutateFileLocked(PATH, (current) => {
    // Number against the pending view while holding the write lock, so a
    // concurrent add/resolve cannot shift the item between read and replace.
    const pending = parseItems(current).filter(item => !item.done);
    const target = pending[n - 1];
    if (!target) fail(`no pending item #${n} (${pending.length} pending)`);
    const lines = current.split('\n');
    let updated = lines[target.line].replace('[ ]', '[x]');
    if (result && !/→ result:/.test(updated)) updated += ` → result: ${result}`;
    lines[target.line] = updated;
    resolvedText = target.text;
    return lines.join('\n');
  });
  process.stdout.write(`Resolved #${n}: ${resolvedText}\n`);
}

function fail(msg) {
  const error = new Error(msg);
  error.isAgentInboxError = true;
  throw error;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'add') await add();
  else if (cmd === 'list') list();
  else if (cmd === 'resolve') await resolve();
  else {
    process.stdout.write(
      'Usage:\n' +
      '  node src/tracker/agent-inbox.mjs add "evaluate https://acme.com/jobs/42"\n' +
      '  node src/tracker/agent-inbox.mjs list [--all]\n' +
      '  node src/tracker/agent-inbox.mjs resolve <n> [--result "..."]\n',
    );
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`agent-inbox.mjs: ${error.message}\n`);
  process.exitCode = 1;
}
