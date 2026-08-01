# Supported CLIs

**Frontrunner runs on a Claude subscription.** That is the whole supported list
today. ChatGPT is the next host on the roadmap.

This is not a limitation to apologise for. Frontrunner is built for people who
are not developers and will not open a terminal, and those people have a Claude
or a ChatGPT subscription — not a local model server. Supporting two hosts
properly is worth more to them than supporting nine badly, because a path nobody
tests is a path that breaks in front of someone who cannot debug it. Narrowing
it also removes a genuinely bad first question to ask a non-technical user:
*which command-line agent tool do you use?*

| CLI | Entry File | How to invoke |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` | Interactive: `claude` (then `/frontrunner`). Headless: `claude -p "prompt"` |

**The application uses Claude Code directly.** The local UI spawns it — every
model-backed button in the interface is a `claude` subprocess — so it is the
path exercised on every run.

## Codex / ChatGPT

`CODEX.md` and [`docs/CODEX.md`](CODEX.md) are still in the repository, and
driving Frontrunner from `codex` will very likely work through the same mode
files. It is not supported yet, and for a specific reason: the local UI has no
Codex backend, so a ChatGPT subscriber would have to work from a terminal —
exactly the audience this product is not for. Supporting ChatGPT means building
that backend, not adding a row to a table.

## Everything else

The modes underneath read `AGENTS.md` and are CLI-agnostic, so OpenCode, Qwen,
Copilot CLI, Kimi, Grok Build CLI, Cursor and others will very likely work.
Those are **compatibility paths, not supported configurations**: nobody here
tests them, and a support question about one may not get a useful answer. If you
want to build on one, nothing stops you — it is simply not where this project's
attention goes.

`GEMINI.md` remains in the repository root as a deliberate no-op that stops an
agent host loading the full project instructions twice. The `OPENCODE.md` and
`KIMI.md` shims have been removed.
