# Architecture

A high-level map of how career-ops is put together. For the precise system/user file boundary, see [DATA_CONTRACT.md](DATA_CONTRACT.md); for contribution mechanics, see [CONTRIBUTING.md](CONTRIBUTING.md); for runtime flow diagrams (evaluation steps, batch processing), see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

Settled doctrine ([#918](https://github.com/santifer/career-ops/issues/918)): the human-readable, git-diffable files (`data/applications.md`, `reports/`, `data/pipeline.md`) are the **permanent source of truth**. SQLite exists only as a derived index (fast queries, reindex-on-delete) and will never become a primary store — not even opt-in. The web interfaces, community plugins, and external scripts all read the files; a second canonical store would force every reader to support two modes forever. Performance work is welcome **on the derived layer**; the files stay the brain.

## Domain layout and stable entry points

Backend modules are grouped by responsibility under `src/`: scanning,
evaluation, tracking, CV generation, analysis, security, plugins, pipeline
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
Finds jobs from **open, no-auth public sources**. `src/scan/scan.mjs` is zero-token: it calls public ATS APIs (Greenhouse, Ashby, Lever, BambooHR, Teamtailor, Workday, Breezy) and RSS/JSON boards via per-board modules in `providers/`. Auth-gated/login-required sources are intentionally out of core (they belong in the plugin layer). Results land in `data/pipeline.md`.

### Evaluation — `modes/oferta.md` + `modes/_shared.md`
The heart of the tool. `oferta.md` defines the A–G evaluation blocks; `_shared.md` defines the 1–5 scoring system, archetype detection, posting-legitimacy signals, and global rules. The AI reads these plus your `cv.md` and produces a structured report.

**Standalone evaluators** let you run the same scoring without an interactive CLI, against cheaper/local models: `src/evaluate/gemini-eval.mjs` (Google free tier), `src/evaluate/ollama-eval.mjs` (fully local), and `src/evaluate/openai-eval.mjs` (any OpenAI-compatible endpoint).

### Generation — PDFs, CVs, cover letters
`src/cv/generate-pdf.mjs` (Playwright HTML→PDF), `src/cv/generate-latex.mjs` / `src/cv/build-cv-latex.mjs`, `src/cv/generate-cover-letter.mjs`. ATS-safe templates live in `templates/` and `fonts/`.

### Tracking — `data/` + `reports/` + tracker scripts
Every evaluated offer is registered. `data/applications.md` is the canonical tracker table; `reports/{NNN}-{company}-{date}.md` holds full evaluations. `src/tracker/tracker.mjs`, `src/tracker/merge-tracker.mjs`, `src/tracker/dedup-tracker.mjs`, `src/tracker/normalize-statuses.mjs`, and `src/tracker/reconcile-pipeline.mjs` keep it consistent (atomic writes + a SQLite index). Report numbers are claimed atomically via `src/tracker/reserve-report-num.mjs`.

### Liveness — never evaluate a dead posting
`src/scan/check-liveness.mjs` / `liveness-*.mjs` verify a posting is still open (zero-token) before it costs evaluation time.

### Local application service — `src/application/`

Local interfaces request a versioned operation such as `scan.run`,
`pipeline.prepare`, `pipeline.run`, or `cv.build`. The service validates bounded
application data, maps it to a fixed Node entry point, and owns structured
events, result envelopes, timeouts, and cancellation. Clients cannot supply
executables, working directories, arbitrary flags, or shell fragments. A
persistent job manager adds atomic per-role claims, bounded logs, reload-safe
state, and crash recovery for the UI. See
[`docs/APPLICATION_SERVICE.md`](docs/APPLICATION_SERVICE.md).

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

`web/` is the inherited, experimental local web application. `ui/` is
Frontrunner's workflow-first replacement and is still under development. Both
read the same canonical user files as the conversational and script workflows;
neither maintains a separate database or source of truth. Paid actions in
`ui/` use the application-service job manager rather than launching processes
directly.

## Data flow (a typical run)

```
scan ──► data/pipeline.md ──► evaluate (oferta + cv) ──► reports/NNN-*.md
                                          │                      │
                                          └──► data/applications.md (tracker)
                                                         │
                                          apply (human reviews + clicks)
```

## Quality gates

- `test-all.mjs` — the full suite (500+ checks across scoring, scan, tracker, PDF, security, updater).
- `updater-migration-tests.mjs` — enforces the system/user boundary and safe cross-version upgrades.
- CI: `test` + CodeQL are required; CodeRabbit reviews every PR; Renovate keeps deps current.

## Where to start reading

- The boundary → `DATA_CONTRACT.md`
- The scoring → `modes/_shared.md` + `modes/oferta.md`
- Adding a job source → [`providers/README.md`](providers/README.md)
- The local backend boundary → [`docs/APPLICATION_SERVICE.md`](docs/APPLICATION_SERVICE.md)
- The updater → `update-system.mjs`
