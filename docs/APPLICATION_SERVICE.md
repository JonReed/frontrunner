# Local application service

Frontrunner's backend exposes a small, versioned operation boundary for local
interfaces. A UI asks for an operation with data; it never supplies an
executable, script, working directory, environment-variable name, or arbitrary
flag.

This is an internal local protocol, not a network API. It exists so the new UI,
future desktop packaging, and other local clients can share the same validation,
process supervision, cancellation, and result semantics without reproducing
backend commands.

## Version 1 operations

| Operation | Purpose | Model tokens |
|---|---|---:|
| `scan.run` | Run the zero-token portal scan | No |
| `pipeline.prepare` | Scan, cache, check liveness, and prefilter | No |
| `pipeline.run` | Run the canonical pipeline including evaluation | Yes, unless the selected engine is `none` |
| `cv.build` | Build a tailored CV for one tracked role | Yes |

The catalog lives in `src/application/operations.mjs`. Only that module may map
an operation to a process. Every command uses the current Node executable, a
fixed repository script, the repository root as its working directory, and
`shell: false`.

## Request contract

Send one JSON object to `node src/application/run.mjs` on standard input:

```json
{"version":"1","operation":"pipeline.prepare","input":{"scan":true,"input":"data/pipeline.md"}}
```

The adapter emits newline-delimited JSON lifecycle events to standard output.
The terminal `finished` event contains the result envelope. Failed protocol
validation is emitted as one `protocol_error` object on standard error and no
backend process is started.

Requests are limited to 64 KiB. Unknown fields and operations are rejected.
Paths are repository-relative and contained under the operation's allowed data
directory. URLs and model identifiers have explicit syntax and size limits.

Persistent job control uses the same versioned, closed protocol:

```json
{"version":"1","action":"start","request":{"version":"1","operation":"pipeline.prepare","input":{"scan":true,"input":"data/pipeline.md"}}}
{"version":"1","action":"read","id":"cv-42-abc123"}
{"version":"1","action":"read","id":"job-prepare-abc123"}
{"version":"1","action":"cancel","id":"cv-42-abc123"}
{"version":"1","action":"list","operation":"pipeline.run","status":"running","limit":20}
{"version":"1","action":"history","operation":"pipeline.run","status":"failed","limit":20}
```

`start` accepts every operation in the fixed catalog. CV jobs retain their
`cv-{role}-{suffix}` IDs for UI compatibility; scan and pipeline jobs use
operation-scoped opaque IDs. Reads and cancellation accept only those validated
forms. Cancellation creates a bounded, contained marker beside that job's
state. The controller that actually owns the operation observes the marker and
aborts through the service; another process never guesses or signals an
operating-system PID.

`list` and `history` are read-only discovery actions for local interfaces.
Both accept only catalog operation names, action-specific closed statuses, and
a limit from 1 to 50. Job lists return recent summary fields and deliberately
exclude retained output, request data, URLs, descriptions, deduplication claims,
and internal paths. History is newest-first and revalidates every stored record;
malformed storage fails closed instead of returning a partial view.

## Lifecycle guarantees

- Events have a version, run ID, monotonically increasing sequence, timestamp,
  operation, and event type.
- Pipeline stage progress uses a separate closed descriptor-3 channel. Only the
  five canonical stage IDs, `started`/`completed`/`failed`, and bounded integer
  counts are accepted. Free text, URLs, errors and unknown fields are rejected.
  Fragmentation is handled; a malformed, oversized or flooding channel is
  disabled after one bounded warning without changing the backend result.
- Results distinguish `succeeded`, `failed`, `cancelled`, and `timed_out`.
- Standard output and error are streamed as bounded events; only a bounded tail
  is retained in the result.
- Operations are launched into a dedicated POSIX process group; Windows uses
  the fixed system `taskkill.exe /T` command with no shell.
- Cancellation and timeout signal the entire process tree, not only the
  immediate Node child. A forced tree kill runs after the fixed grace period
  even if the parent exits first, preventing model/browser descendants from
  outliving a terminal job result.
- A fixed operation wrapper owns the actual backend tree. Its controller sends
  one validated request and keeps an ownership pipe open. Unexpected EOF,
  including an uncatchable controller death, forces the backend tree down.
  Recovery therefore never needs to signal a stored or potentially recycled
  process ID.
- The bounded tracker-status controller applies the same rule to its fixed
  canonical writer. Timeout, controller cancellation, or an output flood
  terminates the complete writer tree before returning a stable `STATUS_*`
  error, so a change cannot land after the interface reports failure.
- The anonymous read-only health controller accepts only `{"version":"1",
  "action":"read"}` and invokes one fixed `claude auth status --json` command.
  Its stdout is byte-bounded, stderr is discarded, and cancellation, timeout
  or an output flood terminates the complete probe tree before returning the
  closed connection summary. It exposes no login action or organization
  identifiers.
- Every operation has a centrally defined timeout and token-cost marker.
- Presentation callbacks cannot crash or change the backend operation.
- Persistent jobs derive atomic claims from the catalog's canonical
  deduplication key. Caller-supplied idempotency labels cannot split one
  operation into duplicate work. CV builds deduplicate per tracker role. Scan,
  preparation and full-pipeline operations share one exclusive pipeline-state
  resource, because they touch the same pending roles and audit artifacts.
  An exact repeat returns its existing job; a different conflicting operation
  fails before launch with `APPLICATION_OPERATION_BUSY` and a bounded summary
  of the active job.
- Job reads, stale reaping, cancellation and terminal writes are serialized per
  job. State and bounded logs use durable atomic replacement, and a late
  completion cannot overwrite an already-terminal recovery result.
- Persistent pipeline jobs store the latest validated structured stage in a
  private atomic sidecar, so progress survives a controller or UI reload.
  Out-of-order stage regressions are ignored. Human log regexes remain only as
  fallback for older/non-pipeline workers and cannot override structured state.
- Each stored job carries the catalog operation, token-cost marker and its
  operation-specific stale deadline. A full pipeline therefore retains its
  30-minute allowance instead of being reaped using the CV builder's five-minute
  limit.
- Cancellation markers are removed on every terminal path. An orphaned running
  job is recoverable after a process crash.
- Detailed terminal job state and bounded logs are transient. Cleanup runs
  before starts and list reads, keeps running jobs unconditionally, and retains
  at most the newest 200 terminal jobs for 30 days. It removes only the exact
  state/log/cancel/progress artifacts belonging to an eligible job, under that
  job's lock; similarly prefixed files are not touched. Cleanup failure is
  advisory and cannot prevent a valid backend operation from starting.
- Hard-crash debris is bounded independently: invalid/orphan state, log,
  cancellation and progress families are removed only when every member is an
  old regular file and no valid job exists under the same lock. Strictly named
  old atomic-replacement temporary files are also removed. The 24-hour age gate
  preserves in-flight creation, while symlinks, directories and lookalikes are
  never followed or deleted.
- Stored job, log, and progress reads accept only regular non-symlink files
  within their respective byte limits. Oversized, symlinked, malformed, or
  impossible lifecycle state is ignored rather than followed or partially
  trusted. A child-reported terminal timestamp is clamped to the persisted
  start time so it cannot create a negative-duration job.
- Terminal operations are summarized in the local
  `data/run-history.ndjson`. The history is locked across processes, replaced
  atomically, private (`0600`), and capped at 1,000 records/2 MiB. It records
  operation, status, whole-run and per-stage timing, whether the operation could
  spend tokens, safe aggregate counts, and provider-reported usage when
  available. It never records request input, job URLs/descriptions, prompts,
  model output, logs, or environment data. Likely credentials in error
  summaries are redacted.
- The service passes its validated run ID to a pipeline child through one fixed
  environment field. The pipeline accepts it only when it satisfies the same
  closed run-ID grammar used by history storage; an invalid inherited value is
  replaced with a locally generated ID. Child stage/token accounting and the
  controller's terminal lifecycle therefore upsert one logical record. The
  controller's whole-process timing wins, while detailed child counts, usage,
  and stage timings are preserved. Terminal outcomes merge fail-closed: a
  generic successful process exit cannot erase a detailed child failure.
- A pipeline exception closes its active stage as failed before propagating.
  Its failure audit retains that stage plus all earlier completed stages, and
  the controller's later terminal update cannot erase them.
- Run-history write failure is reported as a warning but cannot turn successful
  backend work into a failure. Malformed existing history fails closed and is
  never silently replaced.
- Interfaces enumerate recent jobs and run history through the same bounded
  controller instead of reading `ui/.jobs` or `data/run-history.ndjson`
  directly. This keeps filtering, record validation, limits, and summary-field
  selection in the backend.
- Pipeline evaluators publish model request counts and provider-reported token
  usage over one fixed, 2 KiB descriptor-3 JSON contract. Unknown fields,
  malformed JSON, oversized output and contradictory "skipped but billed"
  results fail that role closed. Human stdout/stderr is never parsed for
  accounting. Providers that omit usage remain explicitly counted as missing;
  Frontrunner does not manufacture an estimate.

The contract accepts an optional idempotency key and the catalog supplies a
stable default deduplication key. The service exposes the caller label in its
validated request, but the persistent controller deliberately uses the
catalog-owned key for concurrency control so untrusted clients cannot bypass
spend deduplication or shared-resource exclusion.

## Migration rule

New local interfaces must use this boundary instead of spawning backend scripts
directly. The persistent controller now supports CV builds, scans, zero-token
pipeline preparation and full evaluation runs through the same protocol. The
Frontrunner UI's CV builder is migrated; it launches only the fixed, bounded
`job-control.mjs` adapter and cannot choose a backend command. The workflow UI
can adopt the other operations, progress reads and cancellation without adding
a new privileged process endpoint. It can also discover recent jobs and
operational history without direct filesystem access.

Profile saves use a separate fixed controller because they mutate user-layer
source files rather than start backend jobs. The complete CV, additional CV
versions and allowlisted profile fields are validated before any write. One
cross-process transaction lock protects a private `data/` write-ahead journal
and deterministically ordered target locks. Recovery completes an interrupted
save idempotently, but compares the journalled prior-state hash first and
refuses to overwrite a newer manual or agent edit.

The inherited `web/` tree is archived fail-closed: package start commands are
disabled and all runtime requests receive `410 Gone`. Its legacy endpoints are
not an alternate application boundary. Direct command-line entry points remain
supported for people and CI.
