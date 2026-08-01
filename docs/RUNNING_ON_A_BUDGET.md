# Running Frontrunner on a Budget

Frontrunner evaluates with Claude. It used to ship OpenRouter, OpenAI, Gemini
and Ollama evaluators as cheaper routes; those were removed because four
half-tested paths served nobody well, and an untested path fails in front of
someone who cannot debug it. Supporting one host properly is the trade.

That does not make it expensive. Most of what Frontrunner does costs nothing,
by design.

---

## 1. The pipeline is mostly free

Only evaluation spends model tokens. Everything before and after it is ordinary
code:

| Stage | Cost |
|---|---|
| Scanning job boards | zero — provider APIs |
| Caching job descriptions | zero |
| Liveness checking | zero — provider APIs, browser only as a fallback |
| Prefiltering | zero — deterministic rules |
| **Evaluation** | **the only model spend** |
| Tracker, reports, analysis, PDF rendering | zero |

Run the free stages alone whenever you want to see what a search turned up
before deciding what to spend on:

```bash
npm run pipeline:prepare
```

That is `--engine none`: scan, cache, liveness and prefilter, without a single
model call.

---

## 2. Pick your spend tier

`spend_tier` in [`workspace/profile/profile.yml`](../config/profile.example.yml)
controls which model evaluates offers.

| Tier | Behaviour |
|------|-----------|
| **economy** | Cheapest/fastest model, no extended thinking. Best for high-volume scanning. |
| **standard** | Balanced model, no extended thinking. Default if the key is absent. |
| **premium** | Most capable model, adaptive extended thinking. Best for high-stakes offers. |

The tier buys better **judgement** — is this offer worth applying to, how should
this CV be reframed. It does not apply to extraction: reading contact details
out of a CV runs on the cheapest model with thinking off whatever your tier
says, because there is no judgement in finding an email address. Measured on a
real CV, that was 5.5x cheaper and faster than the default with no loss of
accuracy.

---

## 3. Spend less per evaluation

**Prefilter aggressively.** Every role rejected before evaluation is a model
call you never make. `workspace/.state/prefilter-rejects.tsv` logs every
rejection, so you can see what was dropped and loosen a rule if it was wrong.

**Keep descriptions cached.** `fetch-jds` stores clean job text once, so
re-evaluating a role does not re-download or re-clean it.

**Batch a shortlist in one run.** The static context — your CV, profile and the
scoring rules — is reused across roles in a run instead of being re-sent for
each one.

---

## 4. What a run actually costs

The checked-in benchmark fixture (8 roles, 3 boards) lives in
[`src/benchmark/corpora/pipeline-benchmark.json`](../src/benchmark/corpora/pipeline-benchmark.json)
and is summarised in the README. Regenerate it with `npm run benchmark`.

It is a deterministic regression fixture, not a promise about live job boards.
Real cost depends on how many roles survive prefiltering and how long their
descriptions are.

---

## 5. Free access

Claude Code requires a paid subscription. If that is a barrier, see
[FREE_TIER.md](FREE_TIER.md).

Being straight about the current state: the alternative providers that used to
serve as the free and local path have been removed, so a genuinely free route is
an open question for this project rather than a solved one. It matters — people
using this tool are often between jobs — and it is recorded here as a known gap
rather than quietly dropped.
