# Frontrunner

Find the jobs worth applying for, prepare a strong application, and keep track
of what happens next.

Frontrunner is a local-first job-search system. It scans public job boards,
removes obvious mismatches before using an AI model, evaluates the roles that
remain against your real experience, and keeps your applications and documents
in one place.

It is a fork of [career-ops](https://github.com/santifer/career-ops). Frontrunner
keeps its provider ecosystem, scoring framework, file formats, and safety rules,
but changes how jobs are collected, filtered, and presented.

> **Current status:** the core workflow works, but Frontrunner is not yet a
> polished consumer application. Setup still requires Node.js, Git, and an AI
> coding assistant. A workflow-first interface is under active development in
> `ui/`. If you are not comfortable using developer tools, this release is
> probably not ready for you yet.

## What it does

A typical Frontrunner search looks like this:

1. **Find** — scan public company and ATS job boards.
2. **Filter** — reject clear mismatches such as the wrong role family, level,
   location, or compensation before spending model tokens.
3. **Evaluate** — compare plausible roles with your CV, goals, and constraints.
4. **Prepare** — create a tailored CV, cover letter, outreach, and interview
   material using only claims supported by your source documents.
5. **Track** — keep application status, reports, PDFs, replies, and follow-ups
   together.

Frontrunner never submits an application. It can prepare and prefill material,
but you review it and make the final decision.

## Why this fork exists

career-ops has a capable job-search engine, but its batch workflow sends too
much avoidable work to the model.

In the run that prompted this fork:

- workers read rendered job pages of roughly 18,200 tokens to extract job
  descriptions of roughly 1,840 tokens;
- roles with deterministic seniority, function, or salary mismatches were still
  sent for model evaluation; and
- low-scoring roles received reports almost as long as strong matches.

Frontrunner adds bulk job-description ingestion and a conservative deterministic
prefilter before model evaluation.

### Measured results

Measured on the same 306-role pipeline:

| Measure | career-ops | Frontrunner | Change |
|---|---:|---:|---:|
| JD input per role | ~18,200 tokens | ~1,840 tokens | −90% |
| HTTP requests to ingest 246 roles | 246 | 43 | −83% |
| Roles reaching the model | 246 | 131 | −47% |
| Words written per sub-4.0 role | ~2,200 | ~400 | −82% |
| Words written per sub-2.0 role | ~2,200 | 0 | −100% |
| Wall-clock time per role | ~215s | ~155s | −28% |
| Estimated total input for a full sweep | — | — | ~−70% |

The final row is an estimate; the others are direct measurements. Against 89
previously scored roles, the deterministic filter rejected no role that had
scored 3.0 or above. Every rejection is logged with the rule and matching text
so the filter can be audited and tuned.

## Requirements

- Node.js 22.5 or later
- Git
- An AI coding assistant that can work inside a local repository, such as
  Codex, Claude Code, OpenCode, Qwen, Antigravity, Grok, Kimi, or Copilot
- Chromium through Playwright for PDF generation

## Install

There is not yet a one-click Frontrunner installer. The current installation
path is:

```bash
git clone https://github.com/JonReed/frontrunner.git
cd frontrunner
npm install
npx playwright install chromium
```

Open your AI coding assistant in the `frontrunner` directory and say:

```text
Set up Frontrunner for me.
```

The assistant should ask for your CV, target roles, location, compensation
expectations, and search preferences. It stores personal information only in
the ignored user-data files described in [DATA_CONTRACT.md](DATA_CONTRACT.md).

Once setup is complete, try:

```text
Scan for roles that fit my profile.
```

or paste a job-description URL and ask:

```text
Evaluate this role for me: https://example.com/job
```

Codex users can find invocation details in [CODEX.md](CODEX.md). Interactive
Codex works with the same plain-language requests; slash commands are not
guaranteed. For a one-shot headless run:

```bash
codex exec "Run the Frontrunner scan workflow and summarise the new matches."
```

## Current interfaces

Frontrunner currently has three surfaces:

- **Conversation** — the main supported workflow. Ask your AI coding assistant
  to scan, evaluate, prepare, or track an application in plain language.
- **`web/`** — the inherited career-ops web application. It is feature-rich but
  remains an experimental, developer-started interface.
- **`ui/`** — the new Frontrunner interface. It is organised around the next
  useful action rather than implementation commands, but is still incomplete.

Neither web interface should yet be presented as a finished non-technical
installation experience.

## Advanced: run the efficient batch pipeline directly

The underlying stages remain available to technical users:

```bash
node src/scan/scan.mjs
node src/scan/fetch-jds.mjs --summary
node src/scan/prefilter.mjs --summary --out batch/batch-input.tsv
./batch/batch-runner.sh --parallel 3 --skip-pdf
```

These stages mean:

```text
find → ingest clean job descriptions → reject definite mismatches → score
```

Only the final scoring stage needs a model. Prefilter rejections are written to
`batch/prefilter-rejects.tsv`; review this file after a run to catch rules that
are too aggressive.

## Configure the prefilter

`config/prefilter.example.yml` deliberately ships without opinions about which
job families are wrong. Rejecting engineering roles makes sense for some
leaders and would make the product useless for an engineer.

The example contains optional presets for:

- leadership versus individual-contributor roles;
- commercial, people, finance, legal, clinical, and physical-operations work;
- minimum seniority;
- compensation floors;
- active security-clearance requirements; and
- visa-sponsorship requirements.

The security-clearance and sponsorship blockers are disabled by default.
Unclear roles pass through to evaluation: a false keep costs some computation,
while a false rejection can cost an opportunity.

## Data and privacy

Your CV, profile, reports, application tracker, and generated documents stay in
the local checkout. They are gitignored and separated from updateable system
files.

The canonical user data remains human-readable Markdown, YAML, and TSV. See
[DATA_CONTRACT.md](DATA_CONTRACT.md) for the exact boundary.

Generated application content is restricted to your CV, profile, portfolio
digest, writing samples, and facts you explicitly provide. Frontrunner may
rephrase evidence but must not invent experience, metrics, or authorship.

## Relationship to career-ops

Frontrunner follows upstream development and periodically merges provider
fixes, new ATS support, evaluation improvements, and market-specific modes.
It is not a thin theme or a drop-in package wrapper:

- scripts have been reorganised into domain directories under `src/`;
- repository paths are centralised through `src/paths.mjs`;
- the inherited terminal interface and translated READMEs were removed;
- JD ingestion and batch evaluation have changed; and
- Frontrunner-specific tests protect the prefilter and repository layout.

The user-data contract remains compatible, but internal paths and maintainer
workflows can differ.

### For maintainers: merging upstream

Ordinary users should not need to merge upstream themselves. Maintainers use:

```bash
git fetch upstream
git merge upstream/main
node src/lib/root-paths.mjs --fix
node test-all.mjs
```

Use Git for upstream merges. Do not use `node update-system.mjs apply` to update
Frontrunner: the inherited updater can overwrite fork-specific batch wiring.

## Language support

The documentation is maintained in English only.

Market-specific evaluation modes remain available under directories such as
`modes/de/`, `modes/fr/`, and `modes/ja/`. These provide local employment and
compensation vocabulary; they are separate from the language used to write
reports, CVs, and letters.

## Credit

Frontrunner is built on
[career-ops](https://github.com/santifer/career-ops) by
[Santiago Fernández de Valderrama](https://santifer.io). The upstream scanners,
providers, evaluation framework, tracker, document pipeline, and much of the
test suite remain foundational to this fork.

MIT licensed. Upstream copyright is retained in [LICENSE](LICENSE).
`career-ops` is the upstream project's trademark; Frontrunner is independently
named in accordance with [TRADEMARK.md](TRADEMARK.md).
