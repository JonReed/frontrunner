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
             API engines                    Claude batch
          JSON → code renderer          self-contained worker
                   │                             │
                   └──────────────┬──────────────┘
                                  ▼
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
             A–G report      tracker TSV       optional PDF
                 │                │
                 └────── atomic/locked merge ──────┘
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
4. **Model judgement**: standalone API engines return versioned JSON evidence
   and scores through `src/evaluate/scoring-contract.mjs`. Claude batch remains
   a self-contained worker path.
5. **Render**: API-engine JSON is rendered in code into 7 report blocks (A-G):
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
8. **PDF**: optionally generate an ATS-optimized CV (`src/cv/generate-pdf.mjs`)
9. **Track**: new entries via TSV in `batch/tracker-additions/` merged by
   `src/tracker/merge-tracker.mjs`; status updates to existing rows via `src/tracker/set-status.mjs`

## Batch Processing

The batch system processes multiple offers in parallel:

```
batch-input.tsv → mandatory prefilter → batch-input.filtered.tsv
                                             │
                                             ▼
                                    batch-runner.sh
                                             │
                                      N Claude workers
                           │
                    batch-state.tsv
                    (tracks progress)
```

The bundled shell runner is Claude Code-specific. Other supported evaluators
are selected through `src/pipeline/run.mjs --engine openrouter|openai|gemini`.
The shell runner fails closed if the mandatory prefilter module is absent.
Workers produce:
- Report .md
- PDF
- Tracker TSV line

The orchestrator manages parallelism, state, retries, and resume.

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
- PDFs: `cv-candidate-{company-slug}-{YYYY-MM-DD}.pdf`
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
