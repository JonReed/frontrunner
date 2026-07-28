@AGENTS.md

<!-- ==========================================================================
     Frontrunner-specific guidance. AGENTS.md (above) carries the inherited
     career-ops behaviour; everything here is what differs in this fork.
     Keep it short — this file loads into every session.
     ========================================================================== -->

# Frontrunner

A fork of [career-ops](https://github.com/santifer/career-ops). Same scoring
rubric, same file formats, same providers. What differs: job descriptions are
fetched in bulk by scripts rather than by the model, and roles that cannot fit
are rejected before any model call.

## Repository layout

```
src/paths.mjs        the ONLY place the repo root is derived. Import via '#paths'.
src/scan/            scanning, JD ingestion, liveness, prefiltering
src/tracker/         applications tracker, locking, statuses, follow-ups
src/cv/              CV + cover letter rendering (HTML and LaTeX) and PDF
src/analysis/        patterns, upskill, stats, salary, funnel
src/evaluate/        model-backed evaluation and tailoring
src/lib/             shared helpers
src/plugins/         plugin host and registry validation
tests/               ALL tests (see the two conventions below)
templates/ modes/ providers/ config/ data/ reports/ jds/   (unchanged)
```

Root holds only entry points: `doctor`, `find`, `test-all`, `update-system`,
`validate-system-paths-coverage`.

## Rules that are load-bearing

**1. Never derive the repo root from a file's own location.**

```js
import { ROOT } from '#paths';                           // correct — works anywhere
const ROOT = dirname(fileURLToPath(import.meta.url));    // WRONG
```

61 modules each had their own copy of the second form, which is why moving a
file used to break everything. A test enforces this
(`tests/frontrunner/module-loadability.test.mjs`). The one documented
exception is `validate-system-paths-coverage.mjs`, which must resolve its own
location to detect being run from a temp copy.

Note `import { ROOT } from '#paths'; export { ROOT };` — a bare
`export { ROOT } from '#paths'` re-exports **without a local binding**, which
silently breaks any use of `ROOT` in that file.

**2. Two test suffixes, and the difference matters.**

| Suffix | Behaviour |
|---|---|
| `*.test.mjs` | Auto-discovered, runs **in-process**, shares `test-all`'s counters. Must never call `process.exit()` — it would forge an exit code and skip every later section. |
| `*-tests.mjs` | Standalone suite with its own runner and exit code. Invoked explicitly. |

**3. Prefer new files over editing inherited ones.** This fork tracks upstream
(`git pull upstream main`). New files can never conflict; edits to theirs can.
When behaviour must change, add a module and call it rather than rewriting
theirs.

**4. Use `git pull upstream main`, never `node update-system.mjs apply`.**
The updater treats `batch/batch-runner.sh` as system-layer and silently
reverts the JD pre-fetch wiring. If that happens, re-apply
`patches/jd-prefetch.patch.md`.

## The pipeline

```bash
node src/scan/scan.mjs                                              # find   — zero tokens
node src/scan/fetch-jds.mjs --summary                               # ingest — zero tokens
node src/scan/prefilter.mjs --summary --out batch/batch-input.tsv   # filter — zero tokens
./batch/batch-runner.sh --parallel 3 --skip-pdf                     # score  — the only paid step
```

Only the last step costs tokens. `fetch-jds` writes `jds/` + `jds/index.tsv`,
which `batch-runner.sh` reads so workers get clean JD text (~1.8k tokens)
instead of fetching a rendered HTML page (~18k). `prefilter` logs every
rejection with the rule that fired to `batch/prefilter-rejects.tsv` — check it
for false rejects rather than trusting the filter.

## Verification

```bash
node test-all.mjs                          # full suite
node --test tests/frontrunner/*.test.mjs   # this fork's tests
node validate-system-paths-coverage.mjs    # every tracked file registered
node src/tracker/verify-pipeline.mjs       # tracker integrity
```

Run `test-all.mjs` after ANY file move. Its failures are often misleading: a
broken `tests/helpers.mjs` makes every command return null and reports dozens
of unrelated files as having "syntax errors".

## Gotchas that have cost real time

- **Scripts that write their first argument.** Several CLIs take `argv[2]` as a
  path, so passing a flag creates a file named after it. Guard new CLIs with
  `if (arg?.startsWith('-'))`.
- **Reference rewriting after a move needs five separate passes**: relative
  imports, bare text in docs and `package.json`, `$VAR/`-prefixed shell paths,
  escaped-regex forms (`x\.mjs`) in assertions, and fixtures writing to nested
  paths. Missing any one fails silently.
- **`batch-runner.sh` runs under `set -e`.** A bad path there kills the run
  with empty stdout, so the failure surfaces as an unrelated assertion.
- **Test fixtures that copy the repo** need directories created before writing
  into them; nested paths are not implicit.

## Do not

- Reintroduce upstream branding: `career-ops.org`, their Discord, the manifesto
  promo, or funding config pointing at them.
- Add a terminal UI. The Go dashboard was removed deliberately — the target
  user is not in a terminal.
- Write user data into tracked files. `cv.md`, `config/*.yml`, `data/`,
  `reports/`, `jds/` are gitignored and must stay that way.
