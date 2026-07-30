# Contributing to Frontrunner

Thanks for helping improve Frontrunner. The project is maintained by Furls
Digital Ltd and accepts focused fixes, documentation, provider adapters,
translations and backend improvements.

Frontrunner is a fork of
[career-ops](https://github.com/santifer/career-ops), but it has its own
architecture, security boundaries, issue tracker and release process. Do not
send Frontrunner support requests or patches to the upstream project.

## Before submitting a PR

Open an issue before a new feature, mode, command or architecture change. A
prior issue is not required for:

- bug fixes;
- anonymous, zero-auth scanner providers;
- documentation;
- tests; or
- translations.

Keep a PR focused. Explain the user-visible behavior, the root cause for a fix,
and the checks you ran. Link the issue when one exists. The sole maintainer
makes merge and release decisions; there is no contributor ladder, voting
process, response-time promise or implied path to repository access.

### What makes a reviewable PR

- It changes one coherent behavior.
- It includes regression coverage for behavior changes.
- It preserves the system/user boundary in `DATA_CONTRACT.md`.
- It keeps hostile remote content away from local authority.
- It updates user-facing documentation when commands or guarantees change.
- It passes the relevant focused checks and the complete `test-all.mjs` suite.

## Development workflow

1. Fork and clone the repository.
2. Install the Node version declared in `package.json` and run `npm install`.
3. Create a focused branch.
4. Make the change with tests.
5. Run the checks below.
6. Open a PR against `Furls-Digital/frontrunner`.

## What to Contribute

- New anonymous providers under `providers/`, including parser fixtures.
- Deterministic backend behavior and destructive tests.
- Documentation corrections and examples using fictional data.
- Market modes and translations.
- Improvements to the active `ui/` interface.

The inherited `web/` tree is archived reference source. Its launch paths fail
closed, so do not build new features there.

## Scope: the core vs. the shared layer

Frontrunner core is **local-first and human-in-the-loop** by design — it runs on your machine and drafts applications for *you* to review and submit. Centralized infrastructure — hosted job aggregation, a shared matching service, proxies or Workers the project would operate — is **not part of the core**: it's heavier than a free local tool should carry, and it's where the project is headed as a *separate, opt-in service*. Discuss that direction in [GitHub Issues](https://github.com/Furls-Digital/frontrunner/issues).

Rule of thumb before you build: **provider modules, languages, CLI support, modes, local interfaces, docs and fixes → the core.** Bigger centralized or automation ideas (a hosted layer, auto-apply, scraping infrastructure) → **start in that discussion**, so we can route them together instead of a large PR that can't merge.

## Guidelines

- Keep base modes language-agnostic; market-specific rules belong in their
  market directory.
- Scripts should handle missing files gracefully (check `existsSync` before `readFileSync`)
- Interface changes must pass the `ui` package's typecheck and build, and should be tested with representative fictional data
- Don't commit personal data (workspace/profile/cv.md, profile.yml, applications.md, workspace/reports/evaluations/)

### Dependency policy

Keep the dependency surface small. Prefer the standard library or an existing
dependency when that produces maintainable code. A new direct dependency
requires prior discussion and must:

- be at least seven days old when reviewed, unless it is an urgent security fix
  and the exception is explained in the PR;
- have active maintenance, an MIT-compatible license, and no known high or
  critical vulnerability affecting its use here;
- be added through the relevant package manifest with the updated
  `package-lock.json` committed; and
- avoid install-time scripts unless the PR explains why they are necessary and
  how their supply-chain risk is contained.

Dependabot checks npm packages daily but waits 3 days for patches, 7 days for
minor releases, and 30 days for major releases. Security updates are not
delayed. Compatible patch and minor releases are grouped by workspace; major
updates are reviewed separately and are never auto-merged.

## What we do NOT accept

- **PRs that scrape platforms prohibiting automated access** (LinkedIn, etc.). We actively reject these to respect third-party ToS.
- **PRs that enable auto-submitting applications** without human review. Frontrunner is a decision-support tool, not a spam bot.
- **PRs that add external API dependencies** without prior discussion in an issue.
- **PRs that add centralized or hosted infrastructure to the core** (proxies, aggregation services, shared Workers). That's the separate opt-in service, not the open-core — open an [issue](https://github.com/Furls-Digital/frontrunner/issues) first.
- **Integrations that send your data to a third-party service** — providers or sync features that require a third-party account or push your CV, pipeline, or notes out to an external service. Frontrunner is local-first and zero-keys: your job-search data stays on your machine. Reading *public* job-listing APIs locally is welcome (that's how the built-in providers work); routing your personal data through someone else's service is not.
- **PRs that add third-party hosted entry-points or service badges to the README** — links or embeds that route users' resumes or job data through a service the project doesn't operate. The README stays to assets the project controls, and the official online experience is something we keep first-party. Projects built on Frontrunner are welcome — share them in [GitHub Issues](https://github.com/Furls-Digital/frontrunner/issues), just not on the front page.
- **PRs containing personal data** (real CVs, emails, phone numbers). Use `docs/examples/` with fictional data instead.

## Development

```bash
# Scripts
npm run doctor                # Setup validation
node src/tracker/verify-pipeline.mjs     # Health check
node src/cv/cv-sync-check.mjs        # Config check

# Interfaces
npm -C ui run typecheck
npm -C ui run build

# Tests
npm run qa                    # Full local/CI gate — run before committing
node test-all.mjs --only providers/themuse   # Run just one provider's test(s)
```

Run `npm run hooks:install` once after cloning to enable the versioned
pre-commit hook. The hook runs the same `npm run qa` command as GitHub Actions:
the complete hermetic suite plus the reproducible benchmark-artifact check.

`test-all.mjs` copies the current tracked and untracked system source into a
disposable git repository before executing any test. Ignored user data is never
copied. Every Node child also inherits a filesystem barrier that rejects writes
back to the original checkout's user layer and an outbound-network barrier that
rejects fetch, HTTP, sockets and DNS. A static gate rejects browser launches and
network command escapes from the suite. The runner supplies a private HOME,
temporary directory, Git config and package/browser caches; it does not inherit
credentials, proxies, user configuration or `NODE_OPTIONS`. Live services and
a locally installed browser must never determine whether a test runs. Inject
transports, resolvers and browser-page fixtures instead. Missing declared
dependencies are failures, not conditional skips. Tests should still use
temporary fixtures explicitly; the outer isolation is the final safety boundary
when a fixture override is missing or stale.

**Adding a test for a new scanner provider:** add one file at
`tests/providers/{name}.test.mjs` — it's auto-discovered (`tests/**/*.test.mjs`),
no registration needed. Do not add a section to `test-all.mjs` for this.

**`--only` is a dev convenience, not a PR gate:** it runs *only* the discovered
`tests/` files matching the given substring and skips every inline core
section (syntax, scripts, data contract, personal data, paths,
etc.). A green `--only` run is **not** a green suite — always run the full
`node test-all.mjs` before pushing.

## Brand

Contributions to the codebase are governed by the MIT [LICENSE](LICENSE).
If you fork Frontrunner for commercial use you're welcome to do so under
MIT — please give it your own product name rather than implying this
project endorses it. The "career-ops" name belongs to the upstream
project and is not ours to license.

## Need Help?

- [Open an issue](https://github.com/Furls-Digital/frontrunner/issues)
- [Read the support policy](SUPPORT.md)
- [Read the architecture docs](docs/ARCHITECTURE.md)
