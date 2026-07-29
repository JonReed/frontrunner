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

## Lifecycle guarantees

- Events have a version, run ID, monotonically increasing sequence, timestamp,
  operation, and event type.
- Results distinguish `succeeded`, `failed`, `cancelled`, and `timed_out`.
- Standard output and error are streamed as bounded events; only a bounded tail
  is retained in the result.
- Cancellation sends `SIGTERM`, followed by `SIGKILL` after a fixed grace
  period if the child does not exit.
- Every operation has a centrally defined timeout and token-cost marker.
- Presentation callbacks cannot crash or change the backend operation.

The contract accepts an optional idempotency key and the catalog supplies a
stable default deduplication key. Persistent job deduplication belongs to the
consumer/job store; the service exposes the identity but deliberately does not
silently invent cross-process state.

## Migration rule

New local interfaces must use this boundary instead of spawning backend scripts
directly. Existing UI consumers will be migrated as a separate change so the
service contract and its destructive tests land independently of presentation
work. Direct command-line entry points remain supported for people and CI.
