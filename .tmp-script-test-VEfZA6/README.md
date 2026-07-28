# Frontrunner

AI job search that **filters deterministically first** and spends the model only where judgement is actually needed.

A fork of [career-ops](https://github.com/santifer/career-ops) — same scanners, same scoring rubric, same file formats. Rebuilt where it was expensive.

---

## Why this fork exists

The parent project is good software with one blind spot: **it reaches for the LLM by default**, including for work a script does instantly and for free.

Running 123 roles through it consumed most of a 5-hour Claude usage window. Three causes:

**1. It read job descriptions as rendered web pages.** Every worker pulled a full HTML page into the model's context to reach the job ad inside it.

```
Anthropic — Applied AI Security Architect
  raw HTML page   72,943 chars   ~18,200 tokens
  clean JD text    7,367 chars    ~1,840 tokens   ← same content, 9.9x smaller
```

The ATS APIs return that text directly. Greenhouse returns **every job at a company in one request** with `?content=true`; Ashby and Lever return plain-text descriptions by default. The scanner already calls those endpoints and threw the descriptions away.

**2. It scored roles a regex could reject.** Of the rejections in that run, ~60% cited *seniority mismatch*, *role-family mismatch* or *salary below floor* — all decidable from the job title, in microseconds.

**3. It wrote ~2,200 words about every role**, including ones scoring 1.2 out of 5.

---

## What changed

Measured on the same 306-role pipeline, before and after:

| | career-ops | Frontrunner | Improvement |
|---|---:|---:|---:|
| JD input per role | ~18,200 tokens | ~1,840 tokens | **−90%** |
| HTTP requests to ingest 246 roles | 246 page fetches | 43 API calls | **−83%** |
| Roles reaching the model | 246 | 131 | **−47%** |
| Words written per sub-4.0 role | ~2,200 | ~400 | **−82%** |
| Words written per sub-2.0 role | ~2,200 | 0 | **−100%** |
| Wall clock per role | ~215s | ~155s | **−28%** |
| **Total input across a full sweep** | — | — | **≈ −70%** |

Every row except the last is directly measured. The total is an **estimate**: the system prompt, rubric and CV are unchanged and now dominate what remains, so your mileage moves with how aggressive your filters are.

Time improves least because the fixed costs — process start, reading the rubric and CV — are untouched. Tokens are what your subscription meters, and tokens are where the win is.

None of it makes evaluations worse. Validated against 89 roles that already had LLM scores: **zero roles scoring 3.0+ were rejected by the deterministic pass.**

---

## Quick start

```bash
git clone https://github.com/JonReed/frontrunner.git
cd frontrunner && npm install
```

```bash
cp config/profile.example.yml    config/profile.yml        # you
cp config/prefilter.example.yml  config/prefilter.yml      # your filters
cp templates/portals.example.yml portals.yml               # where to look
cp modes/_custom.efficiency.template.md modes/_custom.md   # the efficiency rules
```

Add your CV as `cv.md`, then open your AI CLI in the directory and talk to it.

Web UI (alpha, inherited): `cd web && npm ci && npm run dev` → `localhost:3000`.

Works with any AI coding CLI — Claude Code, Codex, OpenCode, Qwen, Antigravity, Grok, Kimi, Copilot. In CLIs that register slash commands, use `/career-ops`. In Codex, slash commands are not guaranteed, so ask in plain language instead — or run headless:

```bash
codex exec "Run the career-ops scan mode and summarize new matches."
```

See [CODEX.md](CODEX.md) and [docs/SETUP.md](docs/SETUP.md) for the full invocation model.

### The loop

```bash
node src/scan/scan.mjs                                            # find    - zero tokens
node src/scan/fetch-jds.mjs --summary                             # ingest  - zero tokens
node src/scan/prefilter.mjs --summary --out batch/batch-input.tsv # filter  - zero tokens
./batch/batch-runner.sh --parallel 3 --skip-pdf          # score   - the only paid step
```

Every rejection is logged to `batch/prefilter-rejects.tsv` with the rule that fired and the text it matched. Nothing is dropped silently.

---

## The config has no opinions

`config/prefilter.example.yml` ships with `ic_families` and `wrong_functions` **empty**, because what counts as a wrong role is entirely personal — rejecting `engineer` is right for a delivery director and absurd for an engineer.

Presets sit in the file as comments. Uncomment what fits:

- **Targeting leadership?** Enable the `ic_families` preset to filter IC roles out.
- **An IC avoiding management?** Put the management preset into `wrong_functions`.
- **Not in tech?** Commercial, finance, legal and clinical presets are all there.

Two hard blockers — active security clearance, no visa sponsorship — ship **disabled**. Enable them only if they apply to you.

Tune from evidence: run once, read the rejects log, adjust.

---

## Keeping up with upstream

Frontrunner tracks career-ops rather than diverging from it, so their provider fixes, new ATS vendors and market modes flow in:

```bash
git pull upstream main
```

Changes here are deliberately **additive** — new files that cannot conflict, plus one small insert in `batch/batch-runner.sh`. Use `git pull`, not `node update-system.mjs apply`: the updater treats that file as system-layer and silently reverts the JD wiring. If that happens, re-apply `patches/jd-prefetch.patch.md`.

---

## Credit

Built on [career-ops](https://github.com/santifer/career-ops) by [Santiago Fernández de Valderrama](https://santifer.io). MIT licensed, copyright retained in [LICENSE](LICENSE).

The scanners, 70+ ATS providers, the A–F scoring rubric, the tracker integrity layer and a 2,200-test suite are all his work and all still here. This fork changes how job descriptions are ingested and which roles reach the model. That is a difference in priorities rather than a criticism — at a handful of roles a week, none of this costs enough to be worth optimising.

"career-ops" is their trademark. Frontrunner is an independently named fork, per their [trademark policy](TRADEMARK.md).

MIT.
