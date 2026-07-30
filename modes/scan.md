# Mode: scan — Find roles

Use the deterministic scanner. Do not browse job sites with an interactive
agent, spawn scan workers, or reconstruct provider calls from this prompt.

```bash
npm run scan
```

`src/scan/scan.mjs` reads `workspace/search/portals.yml`, calls the versioned
provider modules through the central bounded HTTP broker, validates every result
against the closed Job contract, applies the user's title/location/blacklist
rules, deduplicates it, and publishes pending URLs transactionally.

When the user wants descriptions, liveness and filtering prepared as well, run:

```bash
npm run pipeline:prepare
```

That is the canonical zero-token path:

```text
scan → cache descriptions → liveness → deterministic prefilter
```

Provider APIs are authoritative where supported. The application-owned
Playwright service is a bounded fallback for inconclusive pages; never give the
model a browser or local tools. Web search snippets cannot prove liveness and
must not be written into the inbox as verified jobs.

Summarize the command's structured result: roles found, new pending roles,
duplicates, rejected/blacklisted roles, inconclusive providers, and any source
failures. Do not edit `workspace/search/pipeline.md` directly.

To support a new source, add or extend a module in `providers/` behind
`providers/_http.mjs` and `providers/_contract.mjs`, with injected HTTP fixtures
and destructive malformed-response tests. Source coverage belongs in code, not
in an agent prompt.
