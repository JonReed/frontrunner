# tests/

Auto-discovered test files for the frontrunner suite.

## Purpose

`test-all.mjs` is the stable seven-line root entry point. The hermetic runner
lives in `tests/runner.mjs`; ordered domain checks live in `tests/core/`; the
runner then auto-discovers every `*.test.mjs` file under `tests/`. There is no
test framework dependency by design — the suite runs with Node.js and the
repository dependencies alone.

## Layout

- `helpers.mjs` — shared assertion helpers and counters. Exports `pass`,
  `fail`, `warn`, plus `ROOT` (repo root), `QUICK` (`--quick` flag), and
  `NODE` (current Node binary).
- `runner.mjs` — disposable-workspace provisioning, hermetic barriers,
  discovery and `node:test` supervision.
- `core/*.mjs` — ordered domain suites extracted from the inherited monolithic
  runner. These are runner modules, not independently executable test files.
- `providers/{name}.test.mjs` — one file per scanner provider (see
  [providers/README.md](../providers/README.md) for the test pattern), plus
  shared cross-provider tests such as `ats-ssrf-hardening.test.mjs`.
  Underscore-prefixed files (e.g. `_html-entities.test.mjs`) test shared
  helper modules.
- Other `*.test.mjs` files at this level (e.g. `stats.test.mjs`) cover shared
  behavior and are discovered recursively.

## Running

```bash
node test-all.mjs                            # full suite — run before pushing
node test-all.mjs --only providers/themuse   # only matching tests/ files
```

Discovery walks `tests/` recursively, sorted lexicographically for a
deterministic cross-OS order. `--only` filters on the tests-relative path and
exits 1 when nothing matches (so a typo cannot turn CI green).

**`--only` is a dev convenience, not a PR gate:** it skips the ordered
`tests/core/` suites. A green `--only` run is not a green suite — always run
the full `node test-all.mjs` before pushing.

## Adding a test

Add one `{name}.test.mjs` file here — it is auto-discovered, no registration
needed. Do not add a section to `tests/core/` unless the check is a structural
part of the aggregate harness. Import helpers relative to the test file:

```js
import { pass, fail, ROOT } from './helpers.mjs';    // tests/*.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';   // tests/providers/*.test.mjs
```

See `CONTRIBUTING.md` for the full contribution flow.
