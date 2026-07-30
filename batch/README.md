# Batch Processing

Process multiple job offers in parallel via tool-less Claude calls. The model
has zero tools and returns schema-constrained scoring data; deterministic code
produces each A-G report and tracker line. For ordinary
use, prefer the canonical `npm run pipeline`; it prepares this input safely.

## Quick Start

1. **Prepare offers** through the canonical zero-token stages:

   ```bash
   npm run pipeline:prepare
   ```

   This writes `batch-input.tsv`. You may also create it manually
   (tab-separated: `id`, `url`, `source`, `notes`):

   ```tsv
   id	url	source	notes
   1	https://jobs.example.com/role-a	LinkedIn	
   2	https://greenhouse.io/company/role-b	Greenhouse	priority
   ```

2. **Dry run** to preview what will be processed:

   ```bash
   ./batch/batch-runner.sh --dry-run
   ```

3. **Run the batch**:

   ```bash
   ./batch/batch-runner.sh
   ```

4. **Results** are automatically merged into `workspace/applications/tracker.md`, processed offers are reconciled out of the `workspace/search/pipeline.md` inbox, and integrity is verified with `src/tracker/verify-pipeline.mjs` at the end of the run.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--parallel N` | `1` | Number of concurrent schema-only evaluations |
| `--dry-run` | off | Preview pending offers without processing |
| `--retry-failed` | off | Only retry offers marked as `failed` in state |
| `--resume-paused` | off | Resume offers paused after a Claude session/rate limit |
| `--start-from N` | `0` | Skip offers with ID below N |
| `--limit N` | `0` | Max number of offers to process in this run (0 = no limit) |
| `--max-retries N` | `2` | Max retry attempts per offer before giving up |
| `--rate-limit-sleep N` | `300` | Seconds to wait before retrying a transient rate-limited worker; use `0` to pause the batch immediately |

## Directory Layout

```
batch/
  batch-runner.sh          # Orchestrator script
  batch-prompt.md          # Legacy compatibility prompt (not model authority)
  batch-input.tsv          # Input offers (you create this)
  batch-state.tsv          # Processing state (auto-managed, resumable)
  logs/                    # Per-offer worker logs ({report_num}-{id}.log)
  tracker-additions/       # TSV lines produced by workers
    merged/                # TSVs already merged into applications.md
```

## How It Works

1. **batch-runner.sh** runs the deterministic prefilter again and fails closed
   if that boundary is unavailable. Workers read
   `batch-input.filtered.tsv`, never the unchecked source directly.
2. It reads `batch-state.tsv`, assigns collision-safe reserved report numbers,
   and launches `src/evaluate/claude-eval.mjs`.
3. Claude receives the bounded JD and candidate context with `--tools ""`,
   safe mode, strict MCP isolation and a JSON schema. Code validates the result,
   writes an A-G report to `workspace/reports/evaluations/`, and writes a tracker TSV to
   `tracker-additions/`. A missing cached JD fails closed; there is no agent or
   browser fallback.
4. After all workers finish, batch-runner calls `src/tracker/merge-tracker.mjs` to merge TSVs into `workspace/applications/tracker.md`, `src/tracker/reconcile-pipeline.mjs` to move processed offers out of the `workspace/search/pipeline.md` inbox, and `src/tracker/verify-pipeline.mjs` to check integrity.

## Tracker Merge

Workers write one TSV per offer to `workspace/.state/tracker-additions/`. The merge script (`npm run merge`) handles:

- Deduplication by company + role fuzzy match and report number
- Column order conversion (TSV has status before score; applications.md has score before status)
- In-place updates when a re-evaluation scores higher than the existing entry
- Moving processed TSVs to `tracker-additions/merged/`

Run `npm run merge` manually if you need to merge outside of a batch run.

## Pipeline Reconcile

Batch mode reads offers from `batch-input.tsv`, but the `workspace/search/pipeline.md` inbox is a separate list. Without reconciliation, an offer evaluated by a batch run stays in the pipeline "Pendientes" section and gets surfaced again on the next scan or `/frontrunner pipeline` run -- producing duplicate reports.

`src/tracker/reconcile-pipeline.mjs` (run as `npm run reconcile`) closes that gap: after the tracker merge, every `completed` or `skipped` offer in `batch-state.tsv` whose URL is still in pipeline "Pendientes" is moved to "Procesadas" with its report link and score (entries without a report file on disk are left in place). It is idempotent -- safe to run after every batch, or manually.

## Resumability

`batch-state.tsv` tracks the status of every offer (`pending`, `processing`, `completed`, `failed`, `skipped`, `rate_limited`, `paused_rate_limit`). If the batch is interrupted, re-running `batch-runner.sh` picks up where it left off -- completed offers are skipped automatically. `rate_limited` is a non-completed state used while the runner waits before retrying, so interrupted rate-limited jobs are eligible on the next normal run.

`paused_rate_limit` is different: it means a worker hit a Claude session/usage limit, so the runner stopped scheduling new offers and preserved the retry count. Resume those rows explicitly after the limit resets:

```bash
./batch/batch-runner.sh --resume-paused
```

A PID-based lock file (`batch-runner.pid`) prevents concurrent batch runs. If a previous run crashed, the stale lock is detected and removed automatically.

## Prerequisites

- Claude Code CLI (`claude`) in PATH
- Node.js >= 22.5, Playwright chromium installed (`npm run doctor` to verify)
- `batch-input.tsv` with at least one offer
