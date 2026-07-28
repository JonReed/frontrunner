# Custom Instructions — efficiency preset

<!-- ============================================================
     PORTABLE EFFICIENCY RULES — contains no personal data.

     SETUP: copy this to modes/_custom.md, then add your own
     house rules underneath.

         cp modes/_custom.efficiency.template.md modes/_custom.md

     modes/_custom.md is gitignored (it is user layer), which is
     why these rules live in a tracked template instead.

     WHY: by default every evaluation writes a ~2,200-word A-G
     report regardless of how badly the role scores, and the batch
     runner pulls a full HTML page into the model's context to read
     each job description. Measured on a 123-role run: ~18,000
     tokens of rendered page to obtain a ~1,800-token JD, and ~60%
     of roles rejected for reasons a regex settles instantly.

     These rules + src/scan/fetch-jds.mjs + src/scan/prefilter.mjs address that.
     ============================================================ -->

## House Rules

### RULE 0 — Below 2.0, write NO report file at all. (highest priority)

Scores run 1.0-5.0, so 1.0 is the floor. A role scoring **< 2.0** is a category
error — wrong role family, wrong level, or a disqualifying requirement. Writing
about it is waste.

When the triage score is **< 2.0**:

1. **Do not create a report file.** No `reports/{###}-*.md`.
2. **Do not reserve a report number.** Skip `src/tracker/reserve-report-num.mjs`.
3. **Do NOT research.** No WebSearch, no comp lookups. Researching the salary of
   a role you are rejecting is pure waste. This is the biggest time saving.
4. **Write the tracker TSV line only**, with `—` in the report column:

   ```
   {id}	{date}	{company}	{role}	SKIP	{score}/5	❌	—	{one-line reason}
   ```

   A row with no markdown link in the report column is valid — `src/tracker/verify-pipeline.mjs`
   skips the link check for it.

5. Final response: **one line** — score and reason.

Score as early as possible. Once the title and first few requirements show it is
wrong-family, stop reading and write the line.

### RULE 1 — Triage first; full reports only for real candidates

Score first, then decide how much to write. Never write block content before scoring.

| Score | What to produce |
|---|---|
| **>= 4.0** | Full A-G report as specified — a real candidate role |
| **2.0 - 3.9** | Triage-only report: 200-300 words, hard ceiling 400 |
| **< 2.0** | Nothing — see Rule 0 |

**Research budget by band** — web research is the slowest part of an evaluation:

| Score band | Research allowed |
|---|---|
| **>= 4.0** | Full bounded budget (up to 5 queries) |
| **2.0 - 3.9** | At most 1, only if comp is the deciding factor |
| **< 2.0** | None |

**Triage-only format** — header, `## Machine Summary` YAML fence (unchanged, all
keys), then only:

```markdown
## Verdict
**{Score}/5 — {SKIP | Evaluated}** — {one-sentence reason}

## Why it doesn't fit
{2-4 bullets naming the specific mismatch; quote the JD where it matters}

## Hard blockers
{Quoted verbatim if any, else: "None — level/fit mismatch, not a disqualification."}

## Better fit at this company
{Name one if obvious; otherwise omit this section entirely}
```

Omit Blocks A-G entirely: no CV match table, no interview plan, no customization
plan, no cover letter draft, no keywords list.

### RULE 2 — No cover letter drafts below 4.0

Stated explicitly because the base `oferta` mode appends one unconditionally.

### RULE 3 — Company naming must be consistent

One canonical company name and slug per employer, everywhere — report title,
filename slug, tracker Company column. Never put the role, product, or team name
in the company slug. Inconsistent naming breaks duplicate detection in
`src/tracker/merge-tracker.mjs` and produces multiple tracker rows for one company.

## Custom Workflows

### Before any batch run

```bash
npm run pipeline            # canonical scan → cache → liveness → prefilter → evaluation
npm run pipeline:prepare    # zero-token preparation only
```

`src/scan/fetch-jds.mjs` writes `jds/` + `jds/index.tsv`; the batch runner reads that index
so workers get clean JD text instead of fetching HTML. `src/scan/prefilter.mjs` writes an
audit trail to `batch/prefilter-rejects.tsv` — check it occasionally for false
rejects and tune the rules.

### After ANY `node update-system.mjs apply`

`batch/batch-runner.sh` is in the updater's SYSTEM_PATHS, so an update reverts the
JD pre-fetch wiring and the batch silently goes back to fetching HTML pages.
Re-apply `patches/jd-prefetch.patch.md`, then `bash -n batch/batch-runner.sh`.

`src/scan/fetch-jds.mjs` and `src/scan/prefilter.mjs` are registered system files.
After an upstream merge, run the normal Frontrunner path-repair and full-test procedure;
do not assume updater behaviour will preserve local edits to either file.

## Output Preferences

- Reports lead with the score and the one-line verdict.
- When summarising a batch run, show only the >= 4.0 roles in full; everything
  else gets a single aggregate line ("37 roles scored below 4.0, mostly IC-level").

## Off-Limits

- Never auto-fill or submit an application without showing me first.
- Never edit a system file to customize my setup — put it here.
