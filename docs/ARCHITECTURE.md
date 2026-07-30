# Architecture

How Frontrunner is put together: the principles and layout first, then the
runtime flows. For the precise system/user file boundary see
[../DATA_CONTRACT.md](../DATA_CONTRACT.md); for contribution mechanics see
[../CONTRIBUTING.md](../CONTRIBUTING.md).

This was two files — a map in the repository root and flows in `docs/` —
each opening by pointing at the other. One architecture document is easier
to keep true than two.

## Principles

Frontrunner is built on three commitments that every design decision serves:

- **Local-first.** Everything runs on your machine against your files. No account required, no server in the loop for the core tool.
- **Model-agnostic backend.** Scoring and tailoring use versioned contracts
  across supported model transports. Claude Code, Codex and Antigravity CLI are
  the tested agent hosts; other CLIs may consume the same mode files but are
  compatibility paths rather than supported configurations.
- **Human-in-the-loop.** The tool prepares and evaluates; the human reviews and clicks. It never submits applications on your behalf.

## The two layers (the data contract)

The single most important architectural rule: **system files** and **user files** are strictly separated.

- **System layer** — the updateable core: `modes/`, scripts (`*.mjs`), and templates. These are versioned and updated by `update-system.mjs`. Listed in `SYSTEM_PATHS`.
- **Application trees** — `web/` and `ui/` are versioned interfaces with their
  own locked packages. They contain no user data and are updated by
  `update-system.mjs` with the rest of the system layer.
- **Private workspace** — every user file, generated artifact and mutable
  runtime record is below `workspace/`. It is blanket-ignored, contains no
  tracked scaffolds, and is represented by one `workspace/` entry in the
  updater denylist. Canonical backend paths live in `src/paths.mjs`; the UI's
  server-only mirror lives in `ui/src/lib/root.ts`.

`DATA_CONTRACT.md` is the source of truth for this boundary, and `updater-migration-tests.mjs` enforces that no system path ever overlaps a user path.

## Files are canonical — databases are derived

Settled doctrine ([#918](https://github.com/santifer/career-ops/issues/918)): the human-readable, git-diffable files (`workspace/applications/tracker.md`, `workspace/reports/evaluations/`, `workspace/search/pipeline.md`) are the **permanent source of truth**. SQLite exists only as a derived index (fast queries, reindex-on-delete) and will never become a primary store — not even opt-in. The web interfaces and external scripts read the files; a second canonical store would force every reader to support two modes forever. Performance work is welcome **on the derived layer**; the files stay the brain.

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
 src/scan/scan.mjs    oferta.md         PDFs/CVs/     workspace/     update-
 providers/  (+eval scripts)   cover letters                 system.mjs
```

### Discovery — `src/scan/scan.mjs` + `providers/`
Finds jobs from **open, no-auth public sources**. `src/scan/scan.mjs` is
zero-token: it calls public ATS APIs (Greenhouse, Ashby, Lever, BambooHR,
Teamtailor, Workday, Breezy) and RSS/JSON boards via per-board modules in
`providers/`. Every result then crosses `providers/_contract.mjs`, which
enforces the same closed, bounded Job schema for every built-in source before
any filter or persistence step. Auth-gated/login-required sources are
intentionally unsupported. Results land in `workspace/search/pipeline.md`.

### Evaluation — `modes/oferta.md` + `modes/_shared.md`
The heart of the tool. `oferta.md` defines the A–G evaluation blocks; `_shared.md` defines the 1–5 scoring system, archetype detection, posting-legitimacy signals, and global rules. The AI reads these plus your `workspace/profile/cv.md` and produces a structured report.

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
`src/cv/generate-pdf.mjs` converts HTML to PDF. All Chromium PDF producers
(`generate-pdf`, `img-to-pdf` and `archive-posting`) publish their complete,
validated and size-bounded buffers through `src/cv/pdf-artifact-store.mjs`.
Same-directory fsync-backed replacement means interruption cannot expose a
partial PDF or truncate an existing artifact. Generated-CV
`workspace/.state/pdf-index.tsv` bookkeeping is centralized in
`src/cv/pdf-index-store.mjs`: records are schema-bounded, repository-relative,
merged under an owner-verified lock and atomically replaced. Concurrent renders
therefore retain every distinct entry, while a failed replacement leaves the
previous manifest readable.
`src/cv/generate-latex.mjs` / `src/cv/build-cv-latex.mjs` and
`src/cv/generate-cover-letter.mjs` provide the other generation paths. ATS-safe
templates live in `templates/` and `fonts/`.

### Tracking — `workspace/applications/` + reports + tracker scripts
Every evaluated offer is registered. `workspace/applications/tracker.md` is the canonical
tracker table; `workspace/reports/evaluations/{NNN}-{company}-{date}.md` holds full evaluations.
`src/evaluate/evaluation-publication.mjs` journals the report and tracker
fragment before either becomes visible, then replays interrupted publication
idempotently. `src/tracker/tracker.mjs`, `src/tracker/merge-tracker.mjs`,
`src/tracker/dedup-tracker.mjs`, `src/tracker/normalize-statuses.mjs`, and
`src/tracker/reconcile-pipeline.mjs` keep the tracker consistent (atomic writes
+ a SQLite index). Report numbers are claimed atomically via
`src/tracker/reserve-report-num.mjs`; a pending publication journal also keeps
that number occupied after a crash.

Pipeline reconciliation shares the scanner's canonical pipeline lock across
its complete read/decision/publication transaction. It atomically publishes
both the pre-reconcile backup and the new inbox, so concurrent scan additions
survive and interruption before replacement leaves the original readable.
`src/pipeline/pipeline-files.mjs` is the canonical pipeline-file publisher:
active-role, liveness, rejection and final inbox-outcome replacements are
fsync-backed, atomic and protected from test writes. Inbox publication remains
inside the pipeline transaction lock, so a failed replacement preserves the
pending role and releases the lock for an immediate retry.

Durable user-state files share `src/lib/file-lock.mjs` and
`src/lib/locked-file.mjs`: owner-verified cross-process locks cover the complete
read/modify/write transaction, while same-directory temporary files, `fsync`
and atomic rename prevent readers from seeing partial replacements. This
publisher now also owns the canonical tracker replacement beneath its
tracker-specific transaction, so standalone tests cannot bypass the user-data
write barrier and every tracker writer gets the same durable publication
semantics. The same boundary owns exclusive creation, atomic copy, atomic move
and protected deletion. Journal cleanup, report reservation release/GC,
tracker backups, CV/LaTeX/HTML publication, reverse-ATS cache/digests and
scanner checkpoint removal therefore cannot escape stale-test protection.
External LaTeX compilers write only into a private temporary directory; code
atomically publishes the completed PDF. A source inventory test permits raw
filesystem mutation only in explicitly listed contained runtime, temporary,
lock and maintainer modules. The boundary also covers the pending-role pipeline, scanner audit
files, application job claims, the agent inbox, application-answer sections,
reply candidates and assessment events. The
observation-only status transition ledger also uses a validated locked atomic
append: concurrent events are retained and interruption cannot tear a TSV row,
while ledger failure never changes the already-committed tracker state.
Follow-up pins are published through `src/tracker/followup-store.mjs` under the
same owner-verified transaction boundary. Concurrent Applied transitions retain
every pin, and interruption between the durable temporary write and rename
leaves the prior follow-up history intact.
External reply content is schema/size bounded before persistence, and
application-answer writes resolve only to existing Markdown files contained
under `workspace/reports/evaluations/`.
Opt-in ATS discovery updates re-read, validate and deduplicate `workspace/search/portals.yml`
inside the same lock before atomically preserving the user's formatting.
Confirmed candidate-source additions use
`src/tracker/add-entry-publication.mjs`: a bounded write-ahead journal makes a
joint `workspace/profile/cv.md` + `workspace/profile/article-digest.md` change recoverable, while before-state
hashes stop recovery from overwriting a human edit made after interruption.
JD cache publication is centralized in `src/scan/jd-cache-store.mjs`.
Scanner descriptions, bulk ATS fetching and browser fallback all re-read and
merge `workspace/jobs/descriptions/index.tsv` under one lock, atomically publish bounded description
files, and replace the manifest last. Concurrent publishers cannot lose entries
and an interrupted manifest replacement leaves the prior index readable.
Completed backend operations use the same boundary for the bounded local
`workspace/.state/run-history.ndjson`. The history contains safe operational metadata and
aggregate counts only—not remote content, prompts, generated output, URLs, logs
or environment values—and audit failure never changes the backend result.

### Liveness — never evaluate a dead posting
`src/scan/check-liveness.mjs` / `liveness-*.mjs` verify a posting is still open (zero-token) before it costs evaluation time.

### Local application service — `src/application/`

Local interfaces request a versioned operation such as `scan.run`,
`pipeline.prepare`, `pipeline.run`, or `cv.build`. The service validates bounded
application data, maps it to a fixed Node entry point, and owns structured
events, result envelopes, timeouts, and cancellation. Clients cannot supply
executables, working directories, arbitrary flags, or shell fragments. A
persistent job manager covers every catalog operation with canonical
cross-process claims (per tracker role for CVs and one shared resource for
scan, preparation and full pipeline work), per-job transactional state,
bounded crash-safe logs,
operation-specific stale deadlines, reload-safe state, durable cancellation
requests, and crash recovery. Caller idempotency labels cannot override those
claims. Supervised operations are isolated into a process group/tree, so
cancellation and timeout terminate model, browser and renderer descendants
before the job becomes terminal. See
[`APPLICATION_SERVICE.md`](APPLICATION_SERVICE.md).

The controller does not directly own the privileged backend process. A fixed
wrapper validates the catalog request again, owns a separate backend
process-group/tree, and watches a kernel ownership pipe held by the controller.
An ordinary signal follows the normal cancellation path; an uncatchable
controller death closes the pipe and triggers forced descendant termination.
No PID is persisted or trusted later during recovery.

Tracker status changes cross a separate narrow controller because they are
synchronous mutations rather than persistent jobs. It accepts only a tracker
number, `Applied`/`Discarded`/`SKIP`, and a bounded table-safe note, then invokes
the canonical locked writer with fixed arguments. That child is also a
supervised process-group/tree: timeout, cancellation and output overflow force
termination before the controller returns an error, preventing late writes.

The connection-health controller is narrower still: one anonymous read action
maps to the fixed, zero-token `claude auth status --json` probe and returns only
installed/sign-in state plus bounded account, plan and method labels. It has no
login action. The probe uses the shared process-tree supervisor, so timeout,
controller cancellation or output flooding cannot leave CLI descendants
running after a disconnected result is returned.

Profile edits cross another narrow controller. A single save may span `workspace/profile/cv.md`,
`workspace/profile/cv-versions/` and `workspace/profile/profile.yml`, so individual atomic replacements are
not sufficient. The backend preflights the complete request, acquires one
transaction claim plus deterministically ordered target locks, then persists a
private write-ahead journal before replacement. A later read/save recovers an
interruption idempotently. Each entry records the prior content hash; recovery
fails closed if another process changed a target after the crash.

Pipeline progress does not depend on console wording. The child publishes a
closed sequence of scan/cache/liveness/prefilter/evaluation events over fixed
descriptor 3; the application service validates, bounds and timestamps them,
then the job manager atomically retains the latest stage across reloads.
Malformed progress produces one advisory warning and has no execution
authority. Log-pattern stage detection exists only as a compatibility fallback.

General backend subprocesses use `src/security/subprocess.mjs`. The canonical
pipeline, Claude evaluation/tailoring, OpenAI-compatible rendering, local
parser, LaTeX engines, batch tailoring, tracker post-processing and evaluation
recovery therefore share `shell: false`, bounded argv/stdin/stdout/stderr,
explicit timeouts and cancellation, and whole-process-tree TERM/KILL cleanup.
Output observers cannot alter lifecycle decisions. A static capability
inventory rejects new direct child-process imports outside this boundary and
the reviewed application protocols. The application service, operation worker,
health probe and status controller remain separate because their versioned
stdin/result, owner-death or fixed-auth semantics are stricter than a general
command runner. The self-loading updater and maintainer path-rewrite utility
remain explicitly reviewed non-runtime exceptions.

The same controller provides the read side for local interfaces. `list`
returns bounded job summaries rather than logs or request data; `history`
returns at most 50 newest-first records after revalidating the complete history
file. Operation and status filters are closed enums. Interfaces therefore do
not need direct access to the private job directory or run-history file.

The private job directory is a transient supervision store, not a second
permanent history database. Before starts and list reads, the manager removes
terminal artifacts older than 30 days or beyond the newest 200, serialized by
the affected job lock; running jobs are never retention candidates. Reads
reject symlinks, oversized files, malformed state, and terminal timestamps that
predate their start. Invalid or incomplete job families left by a hard crash
are removed only after a 24-hour age gate, under that same lock, when every
artifact is a regular file and no valid state exists. Strict old atomic-write
debris is removed separately; symlinks, directories, young files and lookalike
names survive. Durable aggregate evidence remains separately bounded in
`workspace/.state/run-history.ndjson`.

Both direct application requests and persistent jobs publish one terminal run
record. A supervised pipeline child publishes detailed counts and provider
usage under the parent run ID; the parent then idempotently merges its
full-process timing into that record. Terminal outcomes merge fail-closed, so a
generic successful parent exit cannot erase a detailed pipeline failure. The
inherited run ID crosses only one
fixed environment field and must satisfy the closed history grammar, otherwise
the pipeline replaces it with a locally generated value. Direct CLI pipeline
runs use the same contract with their own generated run ID.

The canonical pipeline additionally owns a cross-process run lease for its
entire scan → cache → liveness → prefilter → evaluation transaction. This
covers direct CLI calls as well as application-service children, prevents
shared `workspace/jobs/descriptions/` and `batch/` artifacts from interleaving, and stops a second
process before it can duplicate model spend. Dead owners are recovered through
the shared owner-verified lock implementation.

Each evaluator also has a data-only execution-result boundary on fixed file
descriptor 3. The versioned 2 KiB schema permits only terminal status, model
request count and normalized input/workspace/documents/cached token totals. This keeps
accounting independent of human console wording and prevents job content,
scores, reports or model output entering run history. Missing provider usage is
preserved as missing rather than silently converted to zero.

The pipeline records each canonical stage's terminal status and elapsed time in
its local run-history record. An exception closes the currently active stage as
failed before the run fails, making cache, liveness, filtering and model
failures distinguishable without storing their hostile inputs. The later
supervisor update preserves these child stage metrics, so a controller and
pipeline failure still produce one evidence-rich logical record.

### Self-update — `update-system.mjs`
Safely pulls new system files from the official Frontrunner repository without
touching user data. The source is pinned to
`Furls-Digital/frontrunner`; the parent repository is only used by maintainers
performing an explicit upstream merge. The updater backs up, fetches, re-execs
the target updater, then checks out only `SYSTEM_PATHS`.
`BOOTSTRAP_PATHS` covers very old installs.

### Multi-CLI entry files
Each CLI reads its own entry file, all of which point at the canonical `AGENTS.md`: `CLAUDE.md` (full), thin `@AGENTS.md` redirect wrappers `CODEX.md` and `GEMINI.md`, plus the `.agents/skills/` skill entrypoints — canonical, with copies materialized for Claude Code and Antigravity by `src/lib/skill-entrypoints.mjs`. This is the [open agent skill standard](https://agentskills.io).

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

- `test-all.mjs` — the full suite (2,200+ checks across scoring, scan, tracker,
  PDF, security, updater). It executes the exact current system source in a
  disposable git repository with ignored user files omitted, a private
  HOME/temp/config/cache tree, fixed timezone and locale, and no inherited
  credentials, proxies or user `NODE_OPTIONS`. Filesystem and outbound-network
  barriers inherited by every Node child reject writes back to the original
  checkout and reject fetch, HTTP, socket and DNS egress. A static gate rejects
  browser launches and network-command escapes from the suite. Destructive tests
  therefore cannot mutate real user data or silently reach a live service.
  Provider, updater, archive and browser behavior uses injected fixtures, and
  missing declared dependencies fail rather than reducing coverage. Canonical
  primitive tests cover create/copy/move/delete denial and interrupted-copy
  preservation; static inventories reject new raw mutation or live-network
  bypasses.
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
workspace/search/pipeline.md
       │
       ▼
src/pipeline/run.mjs
       │
       ├─ scan ─────────────── public provider/ATS APIs
       ├─ cache ────────────── clean descriptions in workspace/jobs/descriptions/
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
                         workspace/applications/tracker.md
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
   bounded `workspace/.state/evaluation-publications/{num}-PUBLISHING.json`
   journal, then atomically publishes
   `workspace/reports/evaluations/{num}-{company}-{date}.md` and its tracker TSV
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

All public runtime HTTP traffic—including providers, discovery seeds,
enrichment and model APIs—passes through `providers/_http.mjs`, backed by
`src/security/remote-target-policy.mjs`. The broker blocks local/private
destinations after DNS resolution and on every redirect, pins the connection to
the validated address, limits time and bytes, and defaults to rejecting
redirects. `src/security/model-http.mjs` adds a deliberately separate,
loopback-only and no-redirect capability for local model servers.

Every remote Chromium path uses `src/security/browser-egress.mjs`, which
validates the initial target, all redirects and subresources, and the final
page URL. Chromium's own final DNS connection remains the residual documented
in the threat model. A source-inventory regression test rejects new direct
`fetch`, Node HTTP, `page.goto` or `route` capabilities outside these brokers.
`update-system.mjs` is the sole runtime exception because it must remain
self-loading for old-client upgrades; it accepts only Frontrunner's fixed
official endpoints and applies explicit transfer, process and output limits.

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
and treats reports and generated HTML as untrusted output. It is launched
through `src/application/ui-launch.mjs`, which supplies the canonical root and
fixed Next.js process specification; UI code never derives the checkout from
its working directory. Generated-document routes accept only a tracker role ID
and closed format, resolve the corresponding published artifact server-side,
then apply extension and realpath containment plus an HTML sandbox.

## Failure and Concurrency Boundaries

- Persistent application jobs serialize canonical deduplication claims, reads,
  operation-specific stale recovery, cancellation and terminal transitions.
  Scan, preparation and evaluation claim the same pipeline-state resource;
  conflicting operation names receive a structured busy result before launch.
  Cancellation is a contained durable marker observed by the owning controller,
  never a request to signal a stored PID.
- The canonical pipeline holds one owner-verified cross-process lease across
  scan, cache, liveness, prefilter and evaluation. Concurrent CLI/service runs
  fail before shared artifacts or tokens are touched; dead owners recover.
- Tracker mutations use shared locking and atomic replacement.
- Application-answer report sections, pasted reply candidates and assessment
  events use the same boundary; report paths are contained under `workspace/reports/evaluations/`
  and hostile reply records have closed shape, count and byte limits.
- Opt-in ATS discovery validates fixed provider URLs and re-deduplicates
  `workspace/search/portals.yml` inside its write lock, preventing lost boards across concurrent
  discovery runs while preserving comments and formatting.
- Report numbers are reserved with atomic sentinels before parallel work.
- Evaluation report/tracker publication is write-ahead journaled and
  idempotently recovered after interruption or merge failure.
- Confirmed additions spanning `workspace/profile/cv.md` and `workspace/profile/article-digest.md` are serialized,
  write-ahead journaled and replayed only when each source still matches its
  recorded before-state; newer human edits fail closed.
- Scanner, bulk-fetch and browser-fallback JD cache writes share one locked
  publication boundary. Bounded JD files are atomically replaced before the
  merged manifest commits, so interruption cannot publish a partial target or
  erase another process's entry.
- The updater stages replacements and rolls back injected failures rather than
  leaving mixed versions.
- The reverse ATS scanner checkpoints its lowest unfinished index through the
  shared fsync-backed atomic publisher and resumes safely after interruption.
  Publication failure preserves the previous valid checkpoint, and tests cannot
  overwrite or delete a protected live checkpoint.
- Liveness uncertainty is never silently converted into an expired result.
- Job-source records cannot bypass the central result schema through a new scan
  or portal-probe entry point; a regression test inventories every consumer.

## Data Flow

```
workspace/profile/cv.md                    →  Evaluation context
workspace/profile/article-digest.md        →  Proof points for matching
workspace/profile/profile.yml       →  Candidate identity
workspace/search/portals.yml              →  Scanner configuration
templates/states.yml     →  Canonical status values
templates/cv-template.html → PDF generation template
```

## File Naming Conventions

- Reports: `{###}-{company-slug}-{YYYY-MM-DD}.md` (3-digit zero-padded)
- PDFs: `cv-candidate-{report}-{company-slug}-{YYYY-MM-DD}.pdf`
- Tracker TSVs: `workspace/.state/tracker-additions/{id}.tsv`

## Pipeline Integrity

Scripts maintain data consistency:

| Script | Purpose |
|--------|---------|
| `src/tracker/merge-tracker.mjs` | Merges batch TSV additions into applications.md |
| `src/tracker/verify-pipeline.mjs` | Health check: statuses, duplicates, links |
| `src/tracker/dedup-tracker.mjs` | Removes duplicate entries by company+role |
| `src/tracker/normalize-statuses.mjs` | Maps status aliases to canonical values |
| `src/cv/cv-sync-check.mjs` | Validates setup consistency |
