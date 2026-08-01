# Setup Guide

## Prerequisites

- A Claude subscription and [Claude Code](https://claude.ai/code) (see [Supported CLIs](SUPPORTED_CLIS.md))
- [Node.js](https://nodejs.org) 22.5+ and Git. Node 22.5 is the minimum
  because the tracker index uses the built-in `node:sqlite` module.

## Quick Start

### Recommended

Clone the official Frontrunner repository and start its local interface:

```bash
git clone https://github.com/Furls-Digital/frontrunner.git
cd frontrunner
npm ci
npm run ui:install
npm run ui
```

Open <http://127.0.0.1:3100/welcome>.

If you prefer a conversational agent host, run one from the repository instead
of starting the UI:

```bash
claude   # or codex / agy
```

Claude Code is the supported agent host; ChatGPT/Codex is next. Other agent
CLIs may work through the shared `AGENTS.md` contract as compatibility paths
but are not supported configurations; see [Supported CLIs](SUPPORTED_CLIS.md).

**On first launch, Frontrunner walks you through setup by chatting** — it asks
for your CV, the core details needed for a useful search (name, email,
location, and target job titles), and the preferences that improve matching.
Salary currency/target/floor, working pattern, search area, timezone, structured
work authorisation, AI usage level, output language, phone and public links are
shown explicitly as recommended or optional rather than being hidden behind a generic “complete” state. A final
review lists any missing values, and the profile page repeats that review later.
CV header and title suggestions are deterministic and require confirmation;
they do not spend AI allowance. After the user reviews the imported CV text,
onboarding also offers the first optional AI-styled action. The screen explains
the product-wide convention (violet plus sparkle always means AI), names Claude
as the recipient, and says that the CV text is sent through the user's
connected Claude subscription using that subscription's allowance. Claude
runs without tools and returns bounded, evidence-backed suggestions. The user
selects which suggestions enter the form, reviews them on the later screens,
and explicitly finishes onboarding before anything is written to the profile.
Frontrunner never receives the user's Claude password or subscription
credentials.

The final button uses one recoverable backend operation. It writes the profile,
creates a candidate-specific search brief, derives the scanner title and
location filters from confirmed answers, and creates the empty application
tracker. If the process is interrupted, setup remains visibly incomplete and a
retry resumes safely. Additional CV versions are stored locally but are not
automatically sent to an AI provider.

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
codex exec "Run frontrunner pipeline mode for workspace/search/pipeline.md."
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
npm ci
```

Then open your AI CLI in the folder — the same first-run onboarding applies. Use this path if you want to track a specific branch, contribute, or audit the code before installing dependencies.

</details>

### PDF rendering (one-time)

PDFs are rendered with a headless Chromium. Install it once per machine:

```bash
npm run browser:install
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

`ui/` is the supported workflow-first local interface and the only web runtime
under active development. It remains bound to loopback and is not yet a
one-click consumer installation.

```bash
npm run ui:install
npm run ui
```

Open <http://127.0.0.1:3100/welcome>.

Do not run `web/`. That directory preserves inherited source for upstream
reference only. Its `dev` and `start` commands deliberately fail, and its
runtime returns `410 Gone` if Next.js is launched directly.
