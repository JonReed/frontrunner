# Private Workspace Contract

The repository root contains product source. All personal content, generated
documents and mutable runtime state live below one blanket-ignored
`workspace/` boundary. A fresh clone contains no `workspace/` scaffolds and is
therefore a real empty install.

```
workspace/
├── profile/       CV, identity, targeting, preferences and writing sources
├── search/        portals, URL inbox, blacklist and explicit filter overrides
├── applications/ tracker, follow-ups, replies, offers and observations
├── jobs/          cached job descriptions
├── reports/       evaluations and analysis
├── documents/     generated CVs, cover letters and other application files
├── interviews/    story bank, company prep and sessions
└── .state/        derived indexes, audit trails, locks and recovery journals
```

No subsystem may invent another user-data location. Canonical backend paths
come from `src/paths.mjs`; the UI mirrors that closed layout in
`ui/src/lib/root.ts`.

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

Runtime mutations to this layer must use `src/lib/locked-file.mjs` (or a
domain transaction built on it) for protected create, replace, copy, move and
delete operations. Test processes fail closed before touching the real user
layer, even if a stale or misspelled fixture override makes production code
fall back to the checkout. CI inventories raw filesystem mutators so a new
bypass cannot be introduced silently. External document compilers work in
temporary directories and publish only complete artifacts through this
boundary.

| File | Purpose |
|------|---------|
| `workspace/profile/cv.md` | Your CV in markdown |
| `workspace/profile/profile.yml` | Your identity, targets, comp range |
| `workspace/profile/cv-facts.json` | Your CV fact-check allowlist and forbidden phrases |
| `workspace/profile/benchmarks.yml` | Your market calibration benchmark overrides (optional; copy `templates/benchmarks.yml` here and edit — read by `src/analysis/funnel-velocity.mjs`) |
| `workspace/profile/targeting.md` | Your archetypes, narrative, negotiation scripts |
| `workspace/profile/preferences.md` | Your house rules, custom workflows & output preferences (procedural — survives updates) |
| `workspace/profile/voice-dna.md` | Your writing voice guardrail — banned words, anti-AI-slop rules, tone (optional; copy `templates/voice-dna.template.md` here and edit) |
| `workspace/profile/article-digest.md` | Your proof points from portfolio |
| `workspace/interviews/story-bank.md` | Your accumulated STAR+R stories |
| `workspace/interviews/{company}-{role}.md` | Company-specific interview prep reports (written by `/frontrunner interview-prep`) |
| `workspace/interviews/sessions/*.md` | Interview sessions — real transcripts + mock sessions (sensitive: real names/companies). Drives `patterns` Step 1b targeting signal and `interview-redflag` analysis. |
| `workspace/search/portals.yml` | Your customized company list |
| `workspace/applications/tracker.md` | Your application tracker (source of truth) |
| `workspace/.state/applications.db` | Derived query index over `applications.md` (SQLite, rebuilt by `node src/tracker/tracker.mjs sync` — safe to delete) |
| `workspace/search/pipeline.md` | Your URL inbox |
| `workspace/search/prefilter-overrides.tsv` | Your explicit one-role exceptions to deterministic prefilter decisions: `{recorded_at}\t{url}\t{company}\t{title}\t{rule}\t{evidence}`. Written only after an “Assess anyway” confirmation; an exception matches the exact normalized URL and exact rule, so it cannot disable filtering broadly. |
| `workspace/.state/scan-history.tsv` | Your scan history (tab-separated, append-only trailing columns; col 8: local SimHash JD fingerprint for cross-listing detection, col 9: posting date, cols 10-11: trust score/flags, col 12: normalized company key for repost/name matching). Older rows may have fewer columns — readers index by position and tolerate the absence. |
| `workspace/.state/scan-runs.tsv` | Your per-run scan counters (appended by `src/scan/scan.mjs`, read by `src/analysis/stats.mjs`) |
| `workspace/.state/portal-health.tsv` | Consecutive reachability status for scanned portals (appended by `src/scan/scan.mjs`; statuses: `reachable`, `empty`, `slug_gone`, `network`, `auth`, `server`, `unknown` — the last three joined the vocabulary later, so older files carry only the first four) |
| `workspace/applications/follow-ups.md` | Your follow-up history |
| `workspace/applications/active-interviews.md` | Your active interview processes, incl. inline `[process-friction]` notes (read by `src/analysis/process-quality.mjs`) |
| `workspace/applications/agent-inbox.md` | Your append-only request queue drained at session start (written by `src/tracker/agent-inbox.mjs`) |
| `workspace/.state/.add-entry-PUBLISHING.json` | Temporary, mode-0600 recovery journal used only while a confirmed addition spans `workspace/profile/cv.md` and `workspace/profile/article-digest.md`; removed after both canonical sources are safely published |
| `workspace/applications/reply-candidates.json` | Your normalized employer-reply candidates (subject, body, sender, signal — read by `src/tracker/reply-watch.mjs`) |
| `workspace/.state/pdf-index.tsv` | PDF↔report linkage manifest (written by `src/cv/generate-pdf.mjs`, read by `find.mjs`, the interfaces, and the `email` mode) |
| `workspace/applications/offers/*` | Your received offers/contracts, promise notes, prep reports, and reply drafts (PII — gitignored, written by the `offer-prep` mode) |
| `workspace/applications/salary-observations.tsv` | Your append-only compensation observation log: `{tracker#}\t{date}\t{desired\|advertised\|actual}\t{amount}\t{currency}\t{source}\t{note}`. Written by interactive modes when a figure is stated/confirmed; never edited in place. Advertised figures come from reports' `advertised_comp` instead — reports are themselves observation sources. Read by `src/analysis/salary-gap.mjs` |
| `status-log.tsv` (sibling of the active tracker file — `workspace/applications/status-log.tsv` in the default layout) | Your append-only status transition ledger: `{tracker#}\t{date}\t{from}\t{to}\t{source}\t{note}`. Appended by `src/tracker/set-status.mjs` next to wherever the tracker lives, on every real status change (the tracker stays the source of truth for *state*; the ledger records *when* transitions happened); never edited in place — corrections are new `correction`-source lines. Read by `src/analysis/funnel-velocity.mjs` |
| `workspace/reports/analysis/upskill/*` | Your skill-gap analysis reports (written by the `upskill` mode) |
| `workspace/search/blacklist.md` | Your do-not-apply company list (opt-in — absence = no filtering; never auto-populated: only you, or the agent on your explicit instruction, write to it. Respected by `src/scan/scan.mjs` and the `auto-pipeline`/`oferta`/`apply` gates; never a scoring input) |
| `workspace/applications/assessments.tsv` | Your append-only skills-assessment log: `{date}\t{company}\t{report#\|-}\t{platform}\t{subject}\t{threshold%\|-}\t{score%\|-}\t{stale_note}`. Appended by `node src/analysis/assessment-log.mjs add`; never edited in place. Empty stale_note = no staleness observed. Read by `src/analysis/assessment-log.mjs` |
| `workspace/profile/writing-samples/*` | Your personal writing samples for style calibration |
| `workspace/profile/cv-versions/*` | Your alternate and historical CV source files |
| `workspace/reports/evaluations/*` | Your evaluation reports |
| `workspace/documents/*` | Your generated PDFs |
| `workspace/jobs/descriptions/*` | Your saved job descriptions |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/_custom.template.md` | Template seed for the user's `workspace/profile/preferences.md` |
| `modes/_profile.template.md` | Template seed for the user's `workspace/profile/targeting.md` |
| `templates/voice-dna.template.md` | Template seed for the user's `workspace/profile/voice-dna.md` |
| `modes/oferta.md` | Evaluation mode instructions |
| `modes/pdf.md` | PDF generation instructions |
| `modes/cover.md` | Cover letter generation instructions |
| `modes/latex.md` | LaTeX/Overleaf CV export instructions |
| `modes/add.md` | CV addition (project/paper/role) instructions |
| `modes/scan.md` | Portal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/contacto.md` | LinkedIn outreach instructions |
| `modes/email.md` | Formal application email draft instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/regional/*` | Regional market calibration modes |
| `modes/ofertas.md` | Comparison instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/training.md` | Training evaluation instructions |
| `modes/patterns.md` | Pattern analysis instructions |
| `modes/titles.md` | Adjacent job-title suggestion instructions |
| `modes/upskill.md` | Skill-gap analysis instructions |
| `modes/followup.md` | Follow-up cadence instructions |
| `modes/offer-prep.md` | Offer-stage contract reading companion instructions |
| `modes/interview.md` | Interactive profile/CV onboarding interview instructions |
| `modes/interview-prep.md` | Company-specific interview prep instructions |
| `modes/interview-redflag.md` | Company red-flag detection instructions |
| `modes/interview/*` | Interview prep planning, practice, and debrief skills |
| `modes/agent-inbox.md` | Agent inbox (queued requests) instructions |
| `modes/reply-watch.md` | Employer reply classification instructions |
| `modes/update.md` | System update instructions |
| `modes/ar/*` | Arabic language modes |
| `modes/da/*` | Danish language modes |
| `modes/de/*` | German language modes |
| `modes/es/*` | Spanish language modes |
| `modes/fr/*` | French language modes |
| `modes/hi/*` | Hindi language modes |
| `modes/id/*` | Indonesian language modes |
| `modes/it/*` | Italian language modes |
| `modes/ja/*` | Japanese language modes |
| `modes/ko/*` | Korean language modes |
| `modes/nl/*` | Dutch language modes |
| `modes/pl/*` | Polish language modes |
| `modes/pt/*` | Portuguese language modes |
| `modes/ru/*` | Russian language modes |
| `modes/tr/*` | Turkish language modes |
| `modes/ua/*` | Ukrainian language modes |
| `modes/zh/*` | Chinese language modes |
| `modes/heuristics/*` | Shared candidate-facing application heuristics |
| `CLAUDE.md` | Agent instructions (Claude Code) |
| `CODEX.md` | Agent instructions (Codex) |
| `GEMINI.md` | Legacy no-op context guard (prevents Antigravity duplicate imports) |
| `AGENTS.md` | Canonical agent instructions (imported by CLI-specific wrappers) |
| `*.mjs` | Utility scripts |
| `providers/` | Job-source provider modules for the zero-token scanner |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `templates/*` | Base templates |
| `fonts/*` | Self-hosted fonts |
| `.claude/skills/*` | Skill definitions (Claude Code) |
| `.antigravitycli/skills/*` | Skill definitions (Antigravity CLI) |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## Application Trees

`web/` and `ui/` are versioned application code, never user data. They have
their own packages and are included as complete directory entries in
`update-system.mjs`; an update must not partially replace either application.

## The Rule

**The updater treats `workspace/` as an opaque, untouchable directory.**

**If a file is in the System Layer, it can be safely replaced with the latest
version from the official Frontrunner repository.** The parent career-ops
repository is not an application update source.

Older installations can preview their pre-workspace private paths with
`node src/workspace/archive-legacy.mjs`. Adding `--apply` moves them, without
deleting them, to a timestamped `workspace/.legacy-backup/` manifest. The
archive is deliberately not imported into the active layout: onboarding starts
from an empty workspace.
