# Architecture

This file describes the runtime flows. Design principles and the
system/user data-contract layers live in [../ARCHITECTURE.md](../ARCHITECTURE.md).

## System Overview

```
data/pipeline.md
       │
       ▼
src/pipeline/run.mjs
       │
       ├─ scan ─────────────── public provider/ATS APIs
       ├─ cache ────────────── clean descriptions in jds/
       ├─ liveness ─────────── provider API → Playwright fallback
       ├─ prefilter ────────── deterministic keep/reject + audit TSV
       └─ evaluation ───────── only surviving roles reach a model
                                  │
                   ┌──────────────┴──────────────┐
                   ▼                             ▼
             API engines                 Tool-less Claude CLI
                   └──────── JSON scoring contract ────────┘
                                  ▼
                         ┌────────┴────────┐
                         ▼                 ▼
                     A–G report       tracker TSV
                         └──── atomic/locked merge ────┘
                                  │
                                  ▼
                         data/applications.md
```

## Evaluation Flow (Single Offer)

1. **Input**: a cached JD, pasted JD text, or URL
2. **Liveness and description**: use the provider API first; launch Playwright
   only when the structured endpoint is unsupported or inconclusive
3. **Deterministic gate**: reject unambiguous level, role-family, compensation,
   clearance, or sponsorship mismatches without a model call
4. **Model judgement**: every engine returns versioned JSON evidence and scores
   through `src/evaluate/scoring-contract.mjs`. Claude is launched in safe mode
   with zero tools and a JSON schema; it is not an agent worker.
5. **Render**: evaluator JSON is rendered in code into 7 report blocks (A-G):
   - A: Role summary
   - B: CV match (gaps + mitigation)
   - C: Level strategy
   - D: Comp research (WebSearch)
   - E: CV personalization plan
   - F: Interview prep (STAR stories)
   - G: Posting legitimacy (scam / ghost-job signals)
   The renderer also emits a Risk Summary and compatibility `Machine Summary`
   YAML consumed by the deterministic analysis commands.
6. **Score**: validated 1–5 dimensions and global score
7. **Report**: save as `reports/{num}-{company}-{date}.md`
8. **Track**: new entries via TSV in `batch/tracker-additions/` merged by
   `src/tracker/merge-tracker.mjs`; status updates to existing rows via `src/tracker/set-status.mjs`

CV tailoring is a separate, explicit action after evaluation. A tool-less model
returns a bounded render payload to `src/cv/claude-tailor.mjs`; fixed code then
renders, fact-checks, and creates the PDF.

## Batch Processing

The batch system processes multiple offers in parallel:

```
batch-input.tsv → mandatory prefilter → batch-input.filtered.tsv
                                             │
                                             ▼
                              tool-less evaluator loop
                                             │
                                   N schema-only calls
                           │
                    batch-state.tsv
                    (tracks progress)
```

The canonical default is the tool-less Claude evaluator. Other supported
evaluators are selected through
`src/pipeline/run.mjs --engine openrouter|openai|gemini`.
The legacy shell state runner calls the same tool-less evaluator and fails
closed if either the mandatory prefilter or a cached JD is absent. Code produces:
- Report .md
- Tracker TSV line

The orchestrator manages parallelism, state, retries, and resume.

## Remote-content security boundary

All core HTTP traffic passes through `providers/_http.mjs`, backed by
`src/security/remote-target-policy.mjs`. The broker blocks local/private
destinations after DNS resolution and on every redirect, pins the connection to
the validated address, limits time and bytes, and defaults to rejecting
redirects. Browser subrequests use the same policy, with Chromium's own final
DNS connection documented as a residual in the threat model.

Every description crosses `src/security/job-document.mjs` before a model. It is
bounded, fingerprinted, marked as hostile data, and never grants model tools.
`src/evaluate/save-evaluation.mjs` and the CV renderers own all filesystem
effects. The local UI is loopback-only and treats reports and generated HTML as
untrusted output.

## Failure and Concurrency Boundaries

- Tracker mutations use shared locking and atomic replacement.
- Report numbers are reserved with atomic sentinels before parallel work.
- The updater stages replacements and rolls back injected failures rather than
  leaving mixed versions.
- The reverse ATS scanner checkpoints its lowest unfinished index and resumes
  safely after interruption.
- Liveness uncertainty is never silently converted into an expired result.

## Data Flow

```
cv.md                    →  Evaluation context
article-digest.md        →  Proof points for matching
config/profile.yml       →  Candidate identity
portals.yml              →  Scanner configuration
templates/states.yml     →  Canonical status values
templates/cv-template.html → PDF generation template
```

## File Naming Conventions

- Reports: `{###}-{company-slug}-{YYYY-MM-DD}.md` (3-digit zero-padded)
- PDFs: `cv-candidate-{report}-{company-slug}-{YYYY-MM-DD}.pdf`
- Tracker TSVs: `batch/tracker-additions/{id}.tsv`

## Pipeline Integrity

Scripts maintain data consistency:

| Script | Purpose |
|--------|---------|
| `src/tracker/merge-tracker.mjs` | Merges batch TSV additions into applications.md |
| `src/tracker/verify-pipeline.mjs` | Health check: statuses, duplicates, links |
| `src/tracker/dedup-tracker.mjs` | Removes duplicate entries by company+role |
| `src/tracker/normalize-statuses.mjs` | Maps status aliases to canonical values |
| `src/cv/cv-sync-check.mjs` | Validates setup consistency |

## User Interfaces

The interfaces are local views over the same files used by the scripts and AI
workflow:

- `web/` is the inherited experimental web application.
- `ui/` is Frontrunner's workflow-first interface and is still under
  development.

Neither interface owns a separate data store. Application state remains in
`data/`, `reports/`, and the generated output directories.
