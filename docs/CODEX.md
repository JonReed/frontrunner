# Codex Guide

Frontrunner supports Codex through the same shared router used by the other
tested agent hosts.

## How Codex maps to frontrunner

- `AGENTS.md` is the shared instruction source.
- Root `CODEX.md` is the thin Codex wrapper that imports `AGENTS.md`.
- This file is the human-facing guide for running frontrunner workflows from Codex.

## Interactive Codex

Start Codex in the repository root:

```bash
cd frontrunner
codex
```

Codex may not expose a native `/frontrunner` slash command. When it does not, ask for the same workflow in plain language:

```text
Evaluate this JD with frontrunner auto-pipeline: https://company.com/jobs/123
Run the frontrunner scan mode and summarize new matches.
Run the frontrunner pipeline mode for workspace/search/pipeline.md.
Run the frontrunner pdf mode for the latest evaluated role.
Run the frontrunner email mode for the latest evaluated role. Draft only; never sends, submits, or clicks.
Run the frontrunner tracker mode and summarize the current statuses.
```

## One-shot workers

For single commands or batch workers, use `codex exec`:

```bash
codex exec "Evaluate this JD with frontrunner auto-pipeline: https://company.com/jobs/123"
codex exec "Run frontrunner scan mode in this repo and summarize new matches."
codex exec "Run frontrunner pipeline mode for workspace/search/pipeline.md."
codex exec "Run frontrunner pdf mode for the latest evaluated role."
codex exec "Run frontrunner email mode for the latest evaluated role. Draft only; do not send, submit, or click anything."
codex exec "Run frontrunner tracker mode and summarize the current statuses."
```

## Notes

- If your Codex environment exposes slash commands, the shared `/frontrunner` router semantics still apply.
- If it does not, use the same mode names through prompts or `codex exec`.
- `scan` and `pipeline` run through application code; they do not depend on
  browser tools in the active agent. The application may launch its own bounded
  Playwright fallback when a provider API is inconclusive. `apply` remains a
  local, user-visible browser workflow, but model-authored answers are isolated
  from browser and local tools.
