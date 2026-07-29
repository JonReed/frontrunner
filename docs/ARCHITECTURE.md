# Architecture

How Frontrunner is put together: the principles and layout first, then the
runtime flows. For the precise system/user file boundary see
[../DATA_CONTRACT.md](../DATA_CONTRACT.md); for contribution mechanics see
[../CONTRIBUTING.md](../CONTRIBUTING.md).

This was two files — a map in the repository root and flows in `docs/` —
each opening by pointing at the other. One architecture document is easier
to keep true than two.

## Principles

Career-ops is built on three commitments that every design decision serves:

- **Local-first.** Everything runs on your machine against your files. No account required, no server in the loop for the core tool.
- **AI-agnostic.** The logic lives in Markdown prompt files under `modes/`, executed by whatever AI coding CLI you use (Claude Code, Codex, OpenCode, Gemini, Qwen, Grok, Antigravity) or by standalone Node scripts. No single model is hardcoded.
- **Human-in-the-loop.** The tool prepares and evaluates; the human reviews and clicks. It never submits applications on your behalf.

## The two layers (the data contract)

The single most important architectural rule: **system files** and **user files** are strictly separated.

- **System layer** — the updateable core: `modes/`, scripts (`*.mjs`), and templates. These are versioned and updated by `update-system.mjs`. Listed in `SYSTEM_PATHS`.
- **Application trees** — `web/` and `ui/` are versioned interfaces with their
  own locked packages. They contain no user data and are updated by
  `update-system.mjs` with the rest of the system layer.
- **User layer** — your data: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `data/`, `reports/`, `jds/`, etc. The updater **never** touches these. Listed in `USER_PATHS`.

`DATA_CONTRACT.md` is the source of truth for this boundary, and `updater-migration-tests.mjs` enforces that no system path ever overlaps a user path.

## Files are canonical — databases are derived

Settled doctrine ([#918](https://github.com/santifer/career-ops/issues/918)): the human-readable, git-diffable files (`data/applications.md`, `reports/`, `data/pipeline.md`) are the **permanent source of truth**. SQLite exists only as a derived index (fast queries, reindex-on-delete) and will never become a primary store — not even opt-in. The web interfaces and external scripts read the files; a second canonical store would force every reader to support two modes forever. Performance work is welcome **on the derived layer**; the files stay the brain.

## Domain layout and stable entry points

Backend modules are grouped by responsibility under `src/`: scanning,
evaluation, tracking, CV generation, analysis, security, pipeline
orchestration, and the local application-service boundary. Repository-root
scripts are retained only as stable human and CI entry points. All modules
derive paths from `src/paths.mjs`, so internal files can move without silently
changing the repository root.

## Component map

```
AI coding CLI  ─┐
(or scripts)    │  reads prompt files
                ▼
   modes/*.md  ──────────────►  the "brain": scoring, evaluation,
   (_shared.md = scoring core)   apply, scan, interview, etc. prompts
                │
   ┌────────────┼─────────────────────────────────────────────┐
   ▼            ▼                  ▼               ▼            ▼
 scan        evaluate          generate         track       update
 src/scan/scan.mjs    oferta.md         PDFs/CVs/        data/        update-
 providers/  (+eval scripts)   cover letters    reports/     system.mjs
```

### Discovery — `src/scan/scan.mjs` + `providers/`
Finds jobs from **open, no-auth public sources**. `src/scan/scan.mjs` is
zero-token: it calls public ATS APIs (Greenhouse, Ashby, Lever, BambooHR,
Teamtailor, Workday, Breezy) and RSS/JSON boards via per-board modules in
`providers/`. Every result then crosses `providers/_contract.mjs`, which
enforces the same closed, bounded Job schema for every built-in source before
any filter or persistence step. Auth-gated/login-required sources are
intentionally unsupported. Results land in `data/pipeline.md`.

### Evaluation — `modes/oferta.md` + `modes/_shared.md`
The heart of the tool. `oferta.md` defines the A–G evaluation blocks; `_shared.md` defines the 1–5 scoring system, archetype detection, posting-legitimacy signals, and global rules. The AI reads these plus your `cv.md` and produces a structured report.

**Standalone evaluators** let you run the same scoring without an interactive CLI, against cheaper/local models: `src/evaluate/gemini-eval.mjs` (Google free tier), `src/evaluate/ollama-eval.mjs` (fully local), and `src/evaluate/openai-eval.mjs` (any OpenAI-compatible endpoint).

OpenRouter uses `src/evaluate/openrouter-client.mjs`: fixed service endpoints,
the shared DNS-pinned/size-bounded HTTP broker, and a closed response shape.
`src/evaluate/model-blacklist.mjs` persists failed-model safety state through a
locked atomic merge, so concurrent evaluators cannot overwrite one another.
Its `scan` command delegates to the canonical scanner and owns no scan writes.

### Generation — PDFs, CVs, cover letters
`src/cv/tailoring-contract.mjs` is the provider-neutral, versioned model-output
boundary for CV tailoring. Claude and OpenAI-compatible workers return bounded
content without identity or markup; fixed code injects trusted profile fields,
renders the selected template, verifies claims, and atomically publishes HTML.
`src/cv/generate-pdf.mjs` converts HTML to PDF;
`src/cv/generate-latex.mjs` / `src/cv/build-cv-latex.mjs` and
`src/cv/generate-cover-letter.mjs` provide the other generation paths. ATS-safe
templates live in `templates/` and `fonts/`.

### Tracking — `data/` + `reports/` + tracker scripts
Every evaluated offer is registered. `data/applications.md` is the canonical
tracker table; `reports/{NNN}-{company}-{date}.md` holds full evaluations.
`src/evaluate/evaluation-publication.mjs` journals the report and tracker
fragment before either becomes visible, then replays interrupted publication
idempotently. `src/tracker/tracker.mjs`, `src/tracker/merge-tracker.mjs`,
`src/tracker/dedup-tracker.mjs`, `src/tracker/normalize-statuses.mjs`, and
`src/tracker/reconcile-pipeline.mjs` keep the tracker consistent (atomic writes
+ a SQLite index). Report numbers are claimed atomically via
`src/tracker/reserve-report-num.mjs`; a pending publication journal also keeps
that number occupied after a crash.

Durable user-state files share `src/lib/file-lock.mjs` and
`src/lib/locked-file.mjs`: owner-verified cross-process locks cover the complete
read/modify/write transaction, while same-directory temporary files, `fsync`
and atomic rename prevent readers from seeing partial replacements. This
boundary covers the pending-role pipeline, scanner audit files, application job
claims, the agent inbox, application-answer sections, reply candidates and
assessment events in addition to the tracker-specific transaction. External
reply content is schema/size bounded before persistence, and application-answer
writes resolve only to existing Markdown files contained under `reports/`.
Opt-in ATS discovery updates re-read, validate and deduplicate `portals.yml`
inside the same lock before atomically preserving the user's formatting.
Confirmed candidate-source additions use
`src/tracker/add-entry-publication.mjs`: a bounded write-ahead journal makes a
joint `cv.md` + `article-digest.md` change recoverable, while before-state
hashes stop recovery from overwriting a human edit made after interruption.
JD cache publication is centralized in `src/scan/jd-cache-store.mjs`.
Scanner descriptions, bulk ATS fetching and browser fallback all re-read and
merge `jds/index.tsv` under one lock, atomically publish bounded description
files, and replace the manifest last. Concurrent publishers cannot lose entries
and an interrupted manifest replacement leaves the prior index readable.

### Liveness — never evaluate a dead posting
`src/scan/check-liveness.mjs` / `liveness-*.mjs` verify a posting is still open (zero-token) before it costs evaluation time.

### Local application service — `src/application/`

Local interfaces request a versioned operation such as `scan.run`,
`pipeline.prepare`, `pipeline.run`, or `cv.build`. The service validates bounded
application data, maps it to a fixed Node entry point, and owns structured
events, result envelopes, timeouts, and cancellation. Clients cannot supply
executables, working directories, arbitrary flags, or shell fragments. A
persistent job manager adds atomic per-role claims, per-job transactional
state, bounded crash-safe logs, reload-safe state, durable cancellation
requests, and crash recovery for the UI. Supervised operations are isolated
into a process group/tree, so cancellation and timeout terminate model, browser
and renderer descendants before the job becomes terminal. See
[`APPLICATION_SERVICE.md`](APPLICATION_SERVICE.md).

The canonical pipeline additionally owns a cross-process run lease for its
entire scan → cache → liveness → prefilter → evaluation transaction. This
covers direct CLI calls as well as application-service children, prevents
shared `jds/` and `batch/` artifacts from interleaving, and stops a second
process before it can duplicate model spend. Dead owners are recovered through
the shared owner-verified lock implementation.

### Self-update — `update-system.mjs`
Safely pulls new system files from the official Frontrunner repository without
touching user data. The source is pinned to
`Furls-Digital/frontrunner`; the parent repository is only used by maintainers
performing an explicit upstream merge. The updater backs up, fetches, re-execs
the target updater, then checks out only `SYSTEM_PATHS`.
`BOOTSTRAP_PATHS` covers very old installs.

### Multi-CLI entry files
Each CLI reads its own entry file, all of which point at the canonical `AGENTS.md`: `CLAUDE.md` (full), and thin `@AGENTS.md` redirect wrappers `OPENCODE.md`, `CODEX.md`, `GEMINI.md`, plus the `.agents/skills/` skill entrypoints. This is the [open agent skill standard](https://agentskills.io).

### User interfaces

`ui/` is Frontrunner's only web runtime. It is a workflow-first interface and
is still under development. It reads the same canonical user files as the
conversational and script workflows and does not maintain a separate database
or source of truth. Paid actions use the application-service job manager rather
than launching processes directly.

The inherited `web/` source remains versioned for upstream reference, but is
archived fail-closed: package start commands exit unsuccessfully and a
request-wide proxy returns `410 Gone` even when Next.js is started directly.
Its privileged agent, browser and process endpoints are not part of the
Frontrunner runtime.

## Quality gates

- `test-all.mjs` — the full suite (500+ checks across scoring, scan, tracker, PDF, security, updater).
- `updater-migration-tests.mjs` — enforces the system/user boundary and safe cross-version upgrades.
- CI: `test` + CodeQL are required; CodeRabbit reviews every PR; Renovate keeps deps current.

## Where to start reading

- The boundary → `DATA_CONTRACT.md`
- The scoring → `modes/_shared.md` + `modes/oferta.md`
- Adding a job source → [`providers/README.md`](../providers/README.md)
- The local backend boundary → [`APPLICATION_SERVICE.md`](APPLICATION_SERVICE.md)
- The updater → `update-system.mjs`


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
