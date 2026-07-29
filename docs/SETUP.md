# Setup Guide

## Prerequisites

- An AI coding CLI — [Claude Code](https://claude.ai/code) or Codex, or Antigravity CLI if you want the free tier (see [Supported CLIs](SUPPORTED_CLIS.md))
- [Node.js](https://nodejs.org) 22.5+ and Git. Node 22.5 is the minimum
  because the tracker index uses the built-in `node:sqlite` module.

## Quick Start

### Recommended

Clone the official Frontrunner repository and install its dependencies:

```bash
git clone https://github.com/Furls-Digital/frontrunner.git
cd frontrunner
npm install
claude   # or codex / qwen / opencode / agy / grok
```

**On first launch, Frontrunner walks you through setup by chatting** — it asks
for your CV, your details (name, target roles, salary), and sets up the job
scanner. Nothing to edit by hand: just answer its questions.

If you are using Codex, start the interactive session with `codex`. Slash commands are not guaranteed in Codex, so use the same mode names in a prompt if `/frontrunner` is unavailable:

```text
Evaluate this JD with frontrunner auto-pipeline: https://company.com/jobs/123
Run the frontrunner scan mode.
Run the frontrunner pipeline mode.
Run the frontrunner pdf mode.
Run the frontrunner email mode for the latest evaluated role. Draft only; never sends, submits, or clicks.
Run the frontrunner tracker mode.
```

For one-shot workers or batch tasks in Codex, use `codex exec`. See [docs/CODEX.md](CODEX.md) for the full guide.

```bash
codex exec "Evaluate this JD with frontrunner auto-pipeline: https://company.com/jobs/123"
codex exec "Run frontrunner scan mode in this repo."
codex exec "Run frontrunner pipeline mode for data/pipeline.md."
codex exec "Run frontrunner pdf mode for the latest evaluated role."
codex exec "Run frontrunner email mode for the latest evaluated role. Draft only; do not send, submit, or click anything."
codex exec "Run frontrunner tracker mode and summarize the current statuses."
```

### Advanced — clone manually

<details>
<summary>Prefer to clone the repo yourself?</summary>

```bash
git clone https://github.com/Furls-Digital/frontrunner.git
cd frontrunner
npm install
```

Then open your AI CLI in the folder — the same first-run onboarding applies. Use this path if you want to track a specific branch, contribute, or audit the code before installing dependencies.

</details>

### PDF rendering (one-time)

PDFs are rendered with a headless Chromium. Install it once per machine:

```bash
npx playwright install chromium
```

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/frontrunner scan` or ask the agent to run `scan` |
| Process pending URLs | `/frontrunner pipeline` or ask the agent to run `pipeline` |
| Generate a PDF | `/frontrunner pdf` or ask the agent to run `pdf` |
| Draft application email | `/frontrunner email` or ask the agent to run `email`; draft-only, never sends, submits, or clicks |
| Batch evaluate | `/frontrunner batch` or use `codex exec "Run frontrunner batch mode ..."` |
| Check tracker status | `/frontrunner tracker` or ask the agent to run `tracker` |
| Fill application form | `/frontrunner apply` or ask the agent to run `apply` |

## Verify Setup

```bash
node src/cv/cv-sync-check.mjs      # Check configuration
node src/tracker/verify-pipeline.mjs     # Check pipeline integrity
```

## Local Interface

The supported workflow remains conversation-first. `ui/` is the incomplete
workflow-first Frontrunner interface and the only web runtime under active
development. It is not yet a one-click consumer installation.

Do not run `web/`. That directory preserves inherited source for upstream
reference only. Its `dev` and `start` commands deliberately fail, and its
runtime returns `410 Gone` if Next.js is launched directly.
