# Mode: pipeline — canonical backend (Danish market)

> **Frontrunner backend override:** execute `npm run pipeline`.

This market mode does not duplicate backend instructions. The canonical code
path is API/cache → liveness → deterministic prefilter → evaluation, with
Playwright only as fallback. Use `npm run pipeline:prepare` for the zero-token
stages without evaluation.

Apply Danish-market vocabulary and rules from `modes/da/_shared.md` and the
selected Danish evaluation mode. Human-facing output still follows
`config/profile.yml` → `language.output`.
