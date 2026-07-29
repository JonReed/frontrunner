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
7. **Publish**: `src/evaluate/evaluation-publication.mjs` first writes a
   bounded `reports/{num}-PUBLISHING.json` journal, then atomically publishes
   `reports/{num}-{company}-{date}.md` and its tracker TSV
8. **Track**: `src/tracker/merge-tracker.mjs` merges the TSV; only after the
   tracker contains the exact report identity is the journal removed. A later
   evaluation replays any interrupted journal idempotently. Status updates to
   existing rows use `src/tracker/set-status.mjs`.

CV tailoring is a separate, explicit action after evaluation. Claude and
OpenAI-compatible models return the same bounded, versioned payload defined by
`src/cv/tailoring-contract.mjs`; identity comes only from the trusted local
profile. Fixed code renders and fact-checks the result, and model output is
never published as HTML.

OpenRouter discovery and completion requests use fixed endpoints through
`src/evaluate/openrouter-client.mjs`, which delegates networking to the central
DNS-pinned broker and exposes only bounded content plus usage. Failed-model
blacklisting uses locked atomic merge semantics across processes.

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

After each adapter returns, `providers/_contract.mjs` treats its result as
hostile again. Every scanner and probe receives only the closed Job schema:
HTTP(S) URLs without credentials, bounded strings and descriptions, plausible
dates and salary values, a per-fetch job cap, an aggregate description budget,
and exact-URL deduplication. Invalid records are dropped with reason counts;
non-array provider results fail closed rather than looking like an empty board.

Every description crosses `src/security/job-document.mjs` before a model. It is
bounded, fingerprinted, marked as hostile data, and never grants model tools.
`src/evaluate/save-evaluation.mjs` routes every evaluator through the same
bounded, path-derived publication journal; model fields never choose paths.
The CV renderers own their filesystem effects. The local UI is loopback-only
and treats reports and generated HTML as untrusted output.

## Failure and Concurrency Boundaries

- Persistent application jobs serialize reads, stale recovery, cancellation and
  terminal transitions per job. Cancellation is a contained durable marker
  observed by the owning controller, never a request to signal a stored PID.
- The canonical pipeline holds one owner-verified cross-process lease across
  scan, cache, liveness, prefilter and evaluation. Concurrent CLI/service runs
  fail before shared artifacts or tokens are touched; dead owners recover.
- Tracker mutations use shared locking and atomic replacement.
- Application-answer report sections, pasted reply candidates and assessment
  events use the same boundary; report paths are contained under `reports/`
  and hostile reply records have closed shape, count and byte limits.
- Opt-in ATS discovery validates fixed provider URLs and re-deduplicates
  `portals.yml` inside its write lock, preventing lost boards across concurrent
  discovery runs while preserving comments and formatting.
- Report numbers are reserved with atomic sentinels before parallel work.
- Evaluation report/tracker publication is write-ahead journaled and
  idempotently recovered after interruption or merge failure.
- Confirmed additions spanning `cv.md` and `article-digest.md` are serialized,
  write-ahead journaled and replayed only when each source still matches its
  recorded before-state; newer human edits fail closed.
- Scanner, bulk-fetch and browser-fallback JD cache writes share one locked
  publication boundary. Bounded JD files are atomically replaced before the
  merged manifest commits, so interruption cannot publish a partial target or
  erase another process's entry.
- The updater stages replacements and rolls back injected failures rather than
  leaving mixed versions.
- The reverse ATS scanner checkpoints its lowest unfinished index and resumes
  safely after interruption.
- Liveness uncertainty is never silently converted into an expired result.
- Job-source records cannot bypass the central result schema through a new scan
  or portal-probe entry point; a regression test inventories every consumer.

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

## User Interface

`ui/` is Frontrunner's workflow-first interface and is still under development.
It is a local view over the same files used by the scripts and AI workflow; it
does not own a separate data store. Application state remains in `data/`,
`reports/`, and the generated output directories.

The inherited `web/` source is archived for upstream reference only. Its normal
start commands are disabled and a request-wide proxy returns `410 Gone` if
someone starts Next.js directly. This keeps its legacy tool-capable agents,
browser automation and direct process endpoints outside the reachable product
surface.
