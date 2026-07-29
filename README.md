# Frontrunner

Find the jobs worth applying for, prepare a strong application, and keep track
of what happens next.

Frontrunner is a local-first job-search system. It scans public job boards,
removes obvious mismatches before using an AI model, evaluates the roles that
remain against your real experience, and keeps your applications and documents
in one place.

It is a fork of [career-ops](https://github.com/santifer/career-ops). Frontrunner
keeps its provider ecosystem, scoring framework, file formats, and ethical
application rules, but changes how jobs are collected, filtered, secured, and
presented. The inherited implementation did not treat job adverts as hostile
input; Frontrunner does.

> **The measured difference:** on the checked-in deterministic benchmark,
> Frontrunner uses **92.3% fewer model input tokens**, **81.8% fewer output
> tokens**, and **62.5% fewer description HTTP calls** than the inherited flow.
> Its separate scored regression corpus has **zero false rejects at a score of
> 3.0 or above**. See the [reproducible benchmark](#reproducible-benchmark).

> **Current status:** the core workflow works, but Frontrunner is not yet a
> polished consumer application. Setup still requires Node.js, Git, and an AI
> coding assistant. A workflow-first interface is under active development in
> `ui/`. If you are not comfortable using developer tools, this release is
> probably not ready for you yet.

## What it does

A typical Frontrunner search looks like this:

1. **Find** — scan public company and ATS job boards.
2. **Filter** — reject clear mismatches such as the wrong role family, level,
   location, or compensation before spending model tokens.
3. **Evaluate** — compare plausible roles with your CV, goals, and constraints.
4. **Prepare** — create a tailored CV, cover letter, outreach, and interview
   material using only claims supported by your source documents.
5. **Track** — keep application status, reports, PDFs, replies, and follow-ups
   together.

Frontrunner never submits an application. It can prepare and prefill material,
but you review it and make the final decision.

## Why this fork exists

career-ops has a capable job-search engine, but its batch workflow sends too
much avoidable work to the model.

In the run that prompted this fork:

- workers read rendered job pages of roughly 18,200 tokens to extract job
  descriptions of roughly 1,840 tokens;
- roles with deterministic seniority, function, or salary mismatches were still
  sent for model evaluation; and
- low-scoring roles received reports almost as long as strong matches.

Frontrunner adds bulk job-description ingestion and a conservative deterministic
prefilter before model evaluation.

### What Frontrunner changes

- **One backend pipeline:** `npm run pipeline` owns scan, cache, liveness,
  prefilter, and evaluation in that order.
- **One local application boundary:** interfaces request a small versioned
  operation; fixed backend code chooses executables, scripts, paths, flags,
  timeouts, cancellation, and bounded lifecycle output. The new UI uses this
  boundary rather than constructing backend commands.
- **Structured progress, not log guessing:** canonical pipeline stages publish
  closed progress events over a bounded local process channel. Persistent jobs
  retain the latest validated stage across controller/UI reloads, while human
  stdout remains diagnostic only and cannot spoof progress.
- **Cancellation stops the whole job:** supervised operations run in a
  dedicated process group on POSIX and a fixed `taskkill /T` tree on Windows.
  Timeout or cancellation terminates descendant model and browser processes
  too, so a reported stop cannot leave token spend or file mutations running
  in the background. The persistent backend accepts a validated job ID and
  writes a contained cancellation request; the owning controller observes it
  and aborts the operation without signalling an unverified or recycled PID.
  Tracker-status writes use the same tree supervision: timeout, controller
  shutdown, or oversized output terminates the fixed writer and descendants
  before reporting failure, preventing a late status change after the UI says
  the operation stopped. The read-only Claude authentication probe is equally
  bounded: cancellation, timeout, or an output flood terminates its complete
  process tree before the interface receives a disconnected result.
  Backend jobs additionally run behind a fixed ownership wrapper. The
  controller keeps a kernel pipe open for its lifetime; even an uncatchable
  controller crash closes that pipe and makes the wrapper terminate the backend
  tree, without persisting or later trusting a process ID.
- **No duplicate AI spend:** persistent local jobs cover CV builds, scans,
  zero-token preparation and full pipeline runs. Catalog-owned deduplication
  keys prevent even inconsistent caller idempotency labels from splitting one
  operation into duplicate work. Scan, preparation and full evaluation also
  share one exclusive pipeline-state claim, so different operation names
  cannot race the same pending roles and audit files; clients receive a stable
  busy response naming the active job. Reads, operation-specific stale recovery,
  cancellation, and terminal completion are serialized per job, so a late
  process result cannot resurrect or overwrite a job already made terminal.
  Direct CLI and application-service pipeline runs also share one
  cross-process lease across the complete
  scan→cache→liveness→prefilter→evaluation transaction; a competing run fails
  before scanning or spending tokens, and a crashed owner is recovered.
- **Crash-safe local run history:** completed backend operations append a
  bounded record to `data/run-history.ndjson` with status, duration, token-cost
  classification, per-stage status/timing, safe pipeline counts and
  provider-reported token usage when available. Concurrent processes cannot
  lose records, interrupted replacement preserves the prior file, and the
  history never stores job URLs, descriptions, prompts, model output or
  environment data. A supervised pipeline and its controller share one
  validated run identity, so detailed child accounting and the controller's
  terminal status merge into one logical record instead of creating duplicate
  runs. A generic successful process exit cannot erase a detailed child
  failure. Mid-stage crashes retain the exact failed stage and all previously
  completed stage timings. Local interfaces can query bounded recent job
  summaries and history through the same validated backend contract instead of
  reading private state files. Detailed terminal job state and logs are
  transient—kept for at most 30 days and the newest 200 jobs—while the smaller
  aggregate history remains available independently. Strict, age-gated cleanup
  also removes old crash-orphaned state, sidecars and atomic-write debris
  without following symlinks or touching young, live or lookalike files.
- **Measured model accounting:** Claude, OpenAI, Gemini and OpenRouter
  evaluators return token usage and request counts through a closed 2 KiB
  process-result channel, separate from human output. The pipeline aggregates
  reported usage, explicitly counts evaluations whose provider omitted it, and
  never estimates missing live-run tokens from prose.
- **Transactional profile saves:** a UI save spanning the canonical CV,
  additional CV versions and profile fields is preflighted as one decision,
  serialized across processes and protected by a private write-ahead journal.
  Interrupted saves replay idempotently; recovery refuses to overwrite a
  target changed later by an agent or CLI.
- **Model only for judgement:** provider APIs and deterministic code handle
  collection, description extraction, freshness, obvious mismatches, report
  rendering, pipeline state, and tracker-safe output. The model receives clean
  JD text only after every deterministic stage has passed.
- **Compact scoring contract:** supported API evaluators ask the model for
  versioned JSON evidence and scores; code renders the A–G report instead of
  paying a model to reproduce boilerplate. The same renderer emits the machine
  summary used by salary, skill-gap, and pattern analysis.
- **Deterministic CV rendering:** Claude and OpenAI-compatible tailoring return
  the same closed, versioned JSON payload. Code injects identity from the local
  profile, renders the selected template, verifies claims, and atomically
  publishes the HTML—the model never emits an executable document.
- **API-first job access:** Greenhouse, Lever, Ashby, and Workday APIs are used
  before a browser. Playwright is reserved for providers that cannot answer
  through a structured endpoint, and fallback text is cached rather than
  fetched again by the evaluator.
- **Bounded model transport:** OpenRouter model discovery and completions use
  fixed endpoints through the same DNS-pinned, size-limited HTTP broker as job
  ingestion. Responses cross a closed content/usage boundary, while failed
  models are persisted with locked atomic merge semantics across processes.
- **One job-source result contract:** all built-in sources cross the same
  runtime boundary after fetching. It rejects unsafe URLs and malformed records, removes unknown
  fields, bounds job counts and every retained field, caps aggregate
  description data, deduplicates URLs, and reports anything dropped. Adding
  another source does not add another place to remember these controls.
- **Mandatory conservative filtering:** every model-backed entry point runs the
  deterministic gate. Rejections retain the exact rule and matching evidence;
  uncertain roles pass through rather than being silently discarded.
- **Fail-closed state changes:** tracker writes are locked and atomic, report
  numbers are reserved safely, interrupted scans checkpoint, and updater
  failures roll back without leaving a half-installed system. Scanner history,
  run metrics, portal health, the pending-role pipeline, and the agent inbox use
  the same crash-safe locked replacement boundary, so concurrent scans or local
  clients cannot silently drop each other's state. Application-answer sections,
  pasted reply candidates, and assessment events use it too; reply input is
  schema/size bounded and report updates are contained under `reports/`.
  Explicit ATS discovery also re-reads and re-deduplicates `portals.yml` inside
  the lock, so simultaneous discoveries preserve every unique board. The
  shared JD cache uses the same discipline: scanner, bulk-fetch and
  browser-fallback publishers merge under one lock,
  publish bounded JD files atomically, and commit `jds/index.tsv` last.
- **Transactional evaluation publication:** every model provider uses one
  journaled report-to-tracker publisher. If the process, machine, or tracker
  merge fails after model tokens have already been spent, the next evaluation
  resumes the same publication idempotently instead of losing the result,
  duplicating the tracker row, or reusing its report number.
- **Crash-safe candidate facts:** a confirmed `/add` update to `cv.md` and
  `article-digest.md` is serialized and write-ahead journaled. If Frontrunner
  stops between those two canonical files, the operation resumes without
  duplicating the entry; if either file was edited meanwhile, recovery refuses
  to overwrite the newer human change.
- **Regression evidence:** destructive crash/interruption tests, the scored-role
  false-reject corpus, and a generated efficiency benchmark run in CI. The
  aggregate runner also supervises framework tests so a failing destructive
  suite cannot be hidden behind a green summary. The complete suite executes
  in a disposable repository containing the current system source but no
  ignored user files; a process-wide write barrier additionally prevents test
  children from reaching the original CV, profile, tracker, reports, JDs or
  generated output.
- **Upstream-compatible data:** the CV, profile, reports, tracker, provider
  ecosystem, and scoring scale remain compatible with career-ops.

### Reproducible benchmark

<!-- pipeline-benchmark:start -->
The checked-in 8-role, 3-board fixture currently produces:

| Measure | inherited flow | Frontrunner | Change |
|---|---:|---:|---:|
| Description HTTP calls | 8 | 3 | −62.5% |
| Approximate model input tokens | 276,854 | 21,441 | −92.3% |
| Approximate model output tokens | 17,125 | 3,123 | −81.8% |
| Roles reaching the model | 8 | 8 | 100% pass rate |
| False rejects at score ≥3.0 | — | 0 | — |

The separate 105-role leadership calibration rejects
15 of 88 roles scoring
below 3.0 (17%) and rejects **0 roles scoring 3.0 or above**.
<!-- pipeline-benchmark:end -->

These numbers come from
[`src/benchmark/corpora/pipeline-benchmark.json`](src/benchmark/corpora/pipeline-benchmark.json), not
from hand-edited README estimates. Run `npm run benchmark` to regenerate the
artifact and `npm run benchmark:check` to fail when it is stale. The fixture is
a deterministic regression benchmark, not a promise that every live job board
will have the same ratios. Its token comparison measures the compact
contract-based evaluator path. Claude now uses the same compact contract through
a tool-less CLI call. The command also records wall time for the local
deterministic pass. Run `npm run benchmark:prefilter` to calibrate the active
user rules against the same scored corpus; add `-- --check` to fail on a false
reject.

## Requirements

- Node.js 22.5 or later
- Git
- An AI coding assistant that can work inside a local repository, such as
  Codex, Claude Code, OpenCode, Qwen, Antigravity, Grok, Kimi, or Copilot
- Chromium through Playwright for PDF generation and fallback access to job
  boards without a usable structured endpoint

## Install

There is not yet a one-click Frontrunner installer. The current installation
path is:

```bash
git clone https://github.com/Furls-Digital/frontrunner.git
cd frontrunner
npm install
npx playwright install chromium
```

### Updating Frontrunner

```bash
npm run update:check
npm run update
```

The updater only accepts the official
`https://github.com/Furls-Digital/frontrunner.git` source. It refuses the
parent career-ops repository and preserves the user-data paths in
[DATA_CONTRACT.md](DATA_CONTRACT.md). `npm run rollback` restores the most
recent pre-update system snapshot.

Open your AI coding assistant in the `frontrunner` directory and say:

```text
Set up Frontrunner for me.
```

The assistant should ask for your CV, target roles, location, compensation
expectations, and search preferences. It stores personal information only in
the ignored user-data files described in [DATA_CONTRACT.md](DATA_CONTRACT.md).

Once setup is complete, try:

```text
Scan for roles that fit my profile.
```

or paste a job-description URL and ask:

```text
Evaluate this role for me: https://example.com/job
```

Codex users can find invocation details in [CODEX.md](CODEX.md). Interactive
Codex works with the same plain-language requests; slash commands are not
guaranteed. For a one-shot headless run:

```bash
codex exec "Run the Frontrunner scan workflow and summarise the new matches."
```

## Current interfaces

Frontrunner has two supported surfaces:

- **Conversation** — the main supported workflow. Ask your AI coding assistant
  to scan, evaluate, prepare, or track an application in plain language.
- **`ui/`** — the new Frontrunner interface. It is organised around the next
  useful action rather than implementation commands, but is still incomplete.

The inherited `web/` source is retained only as an upstream reference. Its
`dev` and `start` commands fail closed, and its runtime returns `410 Gone` for
every route even if Next.js is launched directly. This removes the legacy
tool-capable agents, browser-driving application flow and direct process
endpoints from the reachable product surface.

The new UI should not yet be presented as a finished non-technical installation
experience.

## Run the pipeline

There is one supported backend command:

```bash
npm run pipeline
```

It always runs:

```text
scan → cache clean job descriptions → check liveness → prefilter → evaluate
```

Provider APIs are used for descriptions and liveness where available.
Playwright is a fallback, not the first request. Only the final evaluation
stage needs a model. OpenAI-compatible, Gemini, Ollama, OpenRouter, and the
default tool-less Claude evaluator all run the deterministic gate before a
provider request. `--engine batch` remains a deprecated alias for tool-less
Claude; it no longer launches an agent worker.

Use `npm run pipeline:prepare` to run every zero-token stage without starting
evaluation. Select a non-default evaluator with
`node src/pipeline/run.mjs --engine openrouter`, `--engine openai`, or
`--engine gemini`.

Prefilter rejections are written to `batch/prefilter-rejects.tsv`, and
liveness decisions to `batch/liveness-results.tsv`. Review both after a run to
catch rules that are too aggressive or sites that could not be verified.

## Configure the prefilter

`config/prefilter.example.yml` deliberately ships without opinions about which
job families are wrong. Rejecting engineering roles makes sense for some
leaders and would make the product useless for an engineer.

The example contains optional presets for:

- leadership versus individual-contributor roles;
- commercial, people, finance, legal, clinical, and physical-operations work;
- minimum seniority;
- compensation floors;
- active security-clearance requirements; and
- visa-sponsorship requirements.

The security-clearance and sponsorship blockers are disabled by default.
Unclear roles pass through to evaluation: a false keep costs some computation,
while a false rejection can cost an opportunity.

## Data and privacy

Your CV, profile, reports, application tracker, and generated documents are
stored in the local checkout. They are gitignored and separated from updateable
system files. Model-backed evaluation necessarily sends the bounded job text
plus the relevant CV/profile context to the model provider you select. Use
Ollama if that content must never leave the machine.

The canonical user data remains human-readable Markdown, YAML, and TSV. See
[DATA_CONTRACT.md](DATA_CONTRACT.md) for the exact boundary.

Operational run history is local user data too. `data/run-history.ndjson` keeps
at most 1,000 records and 2 MiB, uses private file permissions, and contains
only bounded statuses, timings and aggregate counts. It is not uploaded or
reported to Frontrunner.

Generated application content is restricted to your CV, profile, portfolio
digest, writing samples, and facts you explicitly provide. Frontrunner may
rephrase evidence but must not invent experience, metrics, or authorship.

## Security model

Frontrunner assumes every website, API response, redirect, job URL, job advert,
and model-generated field is malicious. This is a hard architectural boundary,
not prompt wording that each provider has to remember.

- **One egress policy:** core providers and bulk JD ingestion use the shared
  HTTP broker. It accepts only HTTP(S), rejects embedded credentials,
  localhost/private/link-local/metadata destinations, checks resolved IPs,
  pins brokered connections to the checked address, revalidates every redirect,
  times out stalled bodies, and enforces response byte limits. Playwright
  applies the same destination policy to every page subrequest.
- **Anonymous core sources:** built-in providers use public, anonymous
  endpoints. Authenticated job sources are intentionally unsupported;
  credentials are never attached to arbitrary job URLs.
- **Bounded job-source output:** every core provider is reduced to one closed
  Job schema before filtering or persistence. Malformed, credentialed or
  non-HTTP(S) URLs are dropped; result
  counts, descriptions, strings, dates and salary values have central limits;
  truncation and rejected records are emitted as audit telemetry.
- **Hostile-document quarantine:** JD text is normalized, capped at 24,000
  characters, fingerprinted, inspected for instruction-like signals, and
  enclosed in an explicit untrusted-data block. Detection is telemetry—not a
  claim that prompt injection can be sanitized away.
- **Models have no authority:** Claude evaluation and CV tailoring run with
  `--tools ""`, safe mode, no MCP servers or extension hooks, no session
  persistence, and schema-constrained output. Frontrunner never uses
  `--dangerously-skip-permissions`. OpenAI, Gemini, Ollama, and OpenRouter
  evaluators are API calls with no local tools.
- **Code owns effects:** models return bounded evidence, scores, or a CV render
  payload. Deterministic code validates it, chooses paths, writes reports and
  tracker rows, escapes HTML, verifies CV facts, and invokes fixed PDF commands.
- **Local UI means local:** the new UI binds to `127.0.0.1`, rejects non-local
  Host/Origin values, sets an enforced CSP and security headers, validates file
  containment and job IDs, allows only HTTP(S) external links, renders report
  Markdown as escaped React elements, and sandboxes generated HTML previews.

The local UI is not a hosted scraping service and should not be exposed on a
LAN or the public internet. Local-only operation also does not grant permission
to scrape a site: users remain responsible for the terms and access rules of
the sources they configure. Reviewed provider code, local-parser commands,
the selected model provider, browser/OS compromise, and a hostile
local user remain outside the remote-job-content sandbox.

See the [full threat model](docs/frontrunner-threat-model.md), including the
unsafe inherited baseline, abuse cases, residual risks, and implementation
status. The [local application-service contract](docs/APPLICATION_SERVICE.md)
documents the fixed operation catalog that local interfaces must use.

## Relationship to career-ops

Frontrunner follows upstream development and periodically merges provider
fixes, new ATS support, evaluation improvements, and market-specific modes.
It is not a thin theme or a drop-in package wrapper:

- scripts have been reorganised into domain directories under `src/`;
- repository paths are centralised through `src/paths.mjs`;
- the inherited terminal interface and translated READMEs were removed;
- JD ingestion and batch evaluation have changed;
- standalone API evaluator responses use a versioned scoring contract that
  code renders into reports; and
- Frontrunner-specific destructive tests protect filtering, tracker recovery,
  evaluation publication, updater rollback, scanner resume, and repository
  layout.

The user-data contract remains compatible, but internal paths and maintainer
workflows can differ.

### For maintainers: merging upstream

Ordinary users should not need to merge upstream themselves. Maintainers use:

```bash
git fetch upstream
git merge upstream/main
node src/lib/root-paths.mjs --fix
node test-all.mjs
```

Upstream is only a maintainer input. Ordinary users update from Frontrunner
with `npm run update`; the updater is pinned to the Frontrunner repository and
will not fetch the parent.

## Language support

The documentation is maintained in English only.

Market-specific evaluation modes remain available under directories such as
`modes/de/`, `modes/fr/`, and `modes/ja/`. These provide local employment and
compensation vocabulary; they are separate from the language used to write
reports, CVs, and letters.

## Who builds this

Frontrunner is built and sponsored by **[Furls Digital](https://furls.co.uk)** —
AI strategy, program delivery and product engineering. We built this because we
needed it, and we keep building it in the open.

## Credit

Frontrunner is a **fork**, and says so prominently because that is the honest
description: we did not write this from scratch, we made specific and
measurable improvements to someone else's good idea.

It is built on
[career-ops](https://github.com/santifer/career-ops) by
[Santiago Fernández de Valderrama](https://santifer.io). The upstream scanners,
providers, evaluation framework, tracker, document pipeline, and much of the
test suite remain foundational to this fork.

MIT licensed. Upstream copyright is retained in [LICENSE](LICENSE), alongside
Furls Digital's copyright covering the changes made here.
`career-ops` is the upstream project's name and remains theirs; Frontrunner is
independently named and makes no claim to it.
