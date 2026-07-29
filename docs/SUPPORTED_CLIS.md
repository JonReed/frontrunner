# Supported CLIs

Frontrunner supports **Claude Code** and **Codex**, plus **Antigravity CLI** for
the free tier.

That is a deliberately short list. The upstream project advertised nine CLIs,
none of which had test coverage, and support you do not test is a claim rather
than a promise. Narrowing it also removes a genuinely bad first question to ask
a non-technical user: *which command-line agent tool do you use?*

| CLI | Entry File | How to invoke |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` | Interactive: `claude` (then `/career-ops`). Headless: `claude -p "prompt"` |
| Codex | `CODEX.md` (see [`docs/CODEX.md`](CODEX.md)) | Interactive: `codex`, then plain text. Headless: `codex exec "prompt"` |
| Antigravity CLI | `AGENTS.md` | Interactive: `agy` (then `/career-ops`). Headless: `agy -p "prompt"` |

**Claude Code is the one the application itself uses.** The desktop UI spawns it
directly — `src/application/contract.mjs` defaults to the `claude` engine — so
it is the path that gets exercised on every run and the one to choose if you
have no reason to prefer another.

**Antigravity CLI is kept for one reason: it is free.** No API key, no
subscription — see [FREE_TIER.md](FREE_TIER.md). People using this tool are
frequently out of work, and making a paid subscription mandatory would exclude
exactly the people it exists for.

## Everything else

The modes underneath are CLI-agnostic and read `AGENTS.md`, so OpenCode, Qwen,
Copilot CLI, Kimi, Grok Build CLI, Cursor and others will very likely work. They
are simply not tested here, and a support question about one of them will not
get a useful answer.

`GEMINI.md` remains in the repository root. It is a deliberate no-op that stops
Antigravity CLI loading the full project instructions twice. The `OPENCODE.md`
and `KIMI.md` shims have been removed.
