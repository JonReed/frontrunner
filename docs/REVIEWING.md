# Reviewing Frontrunner PRs — the one-pager

What a review here looks for. Useful whether you are reviewing someone else's
PR or checking your own before opening it.

## The three rules

1. **Written doctrine beats personal taste.** Review against what the repo says
   (`CONTRIBUTING.md`, `DATA_CONTRACT.md`, `AGENTS.md`, the mode files), not
   against how you would have written it.
2. **Evidence beats confidence.** Reproduce the defect, inspect the actual
   boundary and run the relevant destructive regression. A plausible review
   comment without evidence is not a release gate.
3. **The maintainer decides.** Furls Digital Ltd is the sole maintainer. External
   review is useful but does not imply merge authority, repository access, a
   contributor ladder or a voting process.

## What to check, in order

1. **Data contract** — does the diff touch user files (`cv.md`, `config/profile.yml`, `data/`, `reports/`)? User files are never written without explicit opt-in. This is the one non-negotiable.
2. **Tests** — does `node test-all.mjs` pass? Does new behavior come with a check? Files added at top level must be registered in `SYSTEM_PATHS` (update-system.mjs).
3. **Scope** — does the diff match what the linked issue asked for? New
   features, modes, commands and architecture changes need prior discussion;
   bug fixes, providers, tests, docs and translations do not.
4. **Behavior changes** — anything under `modes/` changes what the agent does. Descriptive signals with guards written into the text are the house style; anything that changes scoring or tiers goes to the maintainer.
5. **Security** — new fetches get hostname validation (parse the URL, never substring-match), no new dependencies without discussion, nothing auto-submits on a candidate's behalf.

## Tone

Be direct and respectful. Separate correctness, security and data-safety
findings from preferences. When something cannot land, explain the concrete
constraint and the smallest viable path forward.
