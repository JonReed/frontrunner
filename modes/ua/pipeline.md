# Mode: pipeline — canonical backend (Ukrainian market)

> **Frontrunner backend override:** execute `npm run pipeline`.

This market mode does not duplicate backend instructions. The canonical code
path is API/cache → liveness → deterministic prefilter → evaluation, with
Playwright only as fallback. Use `npm run pipeline:prepare` for the zero-token
stages without evaluation.

Apply Ukrainian-market vocabulary and rules from `modes/ua/_shared.md` and the
selected Ukrainian evaluation mode. Human-facing output still follows
`config/profile.yml` → `language.output`.
