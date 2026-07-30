# Mode: pipeline — canonical backend (Italian market)

> **Frontrunner backend override:** execute `npm run pipeline`.

This market mode does not duplicate backend instructions. The canonical code
path is API/cache → liveness → deterministic prefilter → evaluation, with
Playwright only as fallback. Use `npm run pipeline:prepare` for the zero-token
stages without evaluation.

Apply Italian-market vocabulary and rules from `modes/it/_shared.md` and the
selected Italian evaluation mode. Human-facing output still follows
`workspace/profile/profile.yml` → `language.output`.
