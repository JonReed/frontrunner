# Mode: pipeline — canonical backend (Spanish market)

> **Frontrunner backend override:** execute `npm run pipeline`.

This market mode does not duplicate backend instructions. The canonical code
path is API/cache → liveness → deterministic prefilter → evaluation, with
Playwright only as fallback. Use `npm run pipeline:prepare` for the zero-token
stages without evaluation.

Apply Spanish-market vocabulary and rules from `modes/es/_shared.md` and the
selected Spanish evaluation mode. Human-facing output still follows
`workspace/profile/profile.yml` → `language.output`.
