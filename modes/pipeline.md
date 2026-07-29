# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/frontrunner pipeline` to process them all.

## Canonical workflow

Run:

```bash
npm run pipeline
```

Do not manually reconstruct the stages or launch one evaluation agent per URL.
`src/pipeline/run.mjs` owns the order and audit boundary:

1. Scan public providers.
2. Bulk-cache clean descriptions through provider APIs.
3. Check liveness through the provider API, launching Playwright only when the
   API cannot decide.
4. Run the deterministic prefilter for every role, regardless of spend tier.
5. Send only surviving roles to the selected evaluator.

Use `npm run pipeline:prepare` only when the user explicitly wants the
zero-token stages without evaluation. Provider alternatives are
`node src/pipeline/run.mjs --engine openrouter|openai|gemini`.

Expired roles and deterministic rejects never receive report numbers and never
reach a model. Uncertain liveness results are kept rather than silently
discarded. The audit files are:

- `batch/liveness-results.tsv`
- `batch/prefilter-rejects.tsv`
- `batch/batch-input.tsv` (survivors)

At the end, summarize the command result:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [ ] https://jobs.ashbyhq.com/acme/789 | Acme Corp | Solutions Architect | Remote (US)
- [ ] https://jobs.ashbyhq.com/acme/790 | Acme Corp | AI Engineer | Remote (US) | 180000-220000 USD
- [ ] https://jobs.ashbyhq.com/acme/791 | Acme Corp | Staff PM | note: curated shortlist
- [ ] https://boards.greenhouse.io/acme/jobs/792 | Acme Corp | Backend Engineer | Remote (US) | posted: 2026-06-18
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

Pending lines are variable-width. The rawest form is a bare pasted URL,
`- [ ] {url}` (1 column) — what you drop into the inbox by hand. Scanner-written
entries add `| {company} | {title}` (3 columns) plus two optional trailing
columns: `| {location}` (4th) and `| {compensation}` (5th). The scanner fills the
trailing columns only when the ATS exposes them, so 1-, 3-, 4-, and 5-column rows
are all valid — `{url} | {company} | {title} | {location} | {compensation}` is the
maximum (canonical) shape, not the only one. The columns are positional, so a row
carrying compensation always includes the location cell (empty if unknown); a row
with only a location stays 4 columns. Existing shorter rows remain valid and are
read as having empty values for the missing trailing columns.

Beyond the positional cells, rows may carry optional **labeled** segments —
`| {label}: {value}` — that ride on any row shape (bare URL, 3-, 4-, or 5-column),
because the `{label}:` prefix identifies them regardless of column position. Three
are defined:

- `| posted: {YYYY-MM-DD}` — the posting date, when the provider's API exposed one
  (`offer.postedAt`). The scanner writes it so freshness is visible at triage time
  without re-fetching the ATS. Rows from providers with no posting date simply omit
  the segment.
- `| trust: {score}` — optionally `| trust: {score} {flag,flag}` — the scanner's
  legitimacy signal, written **only when a posting is flagged** (`offer.trustScore
  < 100`): the 0–100 trust score, followed (when the validator recorded any
  reasons) by a space and the comma-separated flags (e.g. `missing_apply_url`,
  `invalid_url`, `suspicious_domain`). The flag suffix is omitted when there are
  none, so a score-only segment like `… | trust: 80` is valid. Example with flags:
  `… | trust: 60 missing_apply_url,suspicious_domain`.
  A clean posting (or a scan with `trust_filter` disabled) omits the segment. Treat
  a low score as a ghost/scam-posting warning and weigh it in Block G legitimacy
  before spending an evaluation. The same score + flags are also written to the
  trailing columns of `data/scan-history.tsv`.
- `| note: {text}` — a free-text ranking signal an importer attached to the offer
  (`- [ ] {url} | {company} | {title} | note: curated shortlist` is valid). The
  deterministic scanner never sets it.

When more than one is present the order is `posted:` → `trust:` → `note:`. Treat
them as hints when triaging; none changes how you process the URL.

## JD and liveness resolution

The canonical code path is provider API → cached clean text → Playwright
fallback. WebFetch/WebSearch may help locate or extract a posting, but neither
can prove that it is live. Do not override a conclusive provider API result.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with the Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

1. Run `node src/tracker/reserve-report-num.mjs` to claim the next sequential number (stdout returns `{###}`).
2. Write the report file using that number.
3. Release the sentinel by running `node src/tracker/reserve-report-num.mjs --release {###}` once the report is written.

## Source synchronization

Before processing any URL, verify sync:
```bash
node src/cv/cv-sync-check.mjs
```
If there is a desynchronization, warn the user before continuing.
