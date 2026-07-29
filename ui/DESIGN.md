# Frontrunner — design and voice

The rules this interface is built to. Read before changing anything visual or
any user-facing string.

---

## Who this is for

Someone looking for a job. **Not a developer.** They pay for an AI subscription
and came here because someone said it was easy.

Two things follow from that, and almost every decision below traces back to
one of them:

**Job hunting is demoralising.** Rejection is the normal outcome, progress is
invisible for weeks, and people arrive at this screen already discouraged. The
interface should feel calm and competent — never a productivity tool
congratulating you on your streaks.

**They are handing over their entire employment history.** Trust is not a nice
-to-have. Say what happens to their data, link the real job advert so they can
check our work, and never let an AI action spend their allowance unannounced.

---

## Personality

**The agent who has read everything.**

Not an assistant. An assistant waits to be asked and performs willingness —
"How can I help you today?", "I'd be happy to help!" — which is both the
default voice of every AI product and, for someone anxious about work, faintly
patronising. It is the tell that does not show up in a screenshot.

An agent has already done the work:

> **Assistant:** "How can I help you today? I'd be happy to find you some roles!"
> **Agent:** "I read 247 of these. Six are worth your time. Start with Accenture."

Think of a good chief of staff, or the useful half of a talent agent. Someone
who works for you, has read all 247 adverts so you did not have to, tells you
which six matter, and is straight with you when something is weak. The name
carries the same idea: Frontrunner is about being ahead, not about being
helped.

### No persona, no "I"

There is no assistant character here and nothing in the interface says "I".

The moment a product has a named helper saying "I've found some great matches
for you!", two things happen: people start talking to it instead of using it,
and every string has to be written in character. The personality should live
in **what the interface chooses to say and what it refuses to say** — not in a
mascot.

So: speak plainly about the user's situation, in second person, with no
narrator. A well-made instrument has a personality without having a character.

### What that sounds like

| Situation | Assistant voice | Frontrunner voice |
|---|---|---|
| Empty state | "No results found. Try adjusting your filters!" | "Nothing needs your attention." |
| Weak match | "This role might not be the best fit 😕" | "Not worth your time — the clearance requirement is a hard stop." |
| Failure | "Oops! Something went wrong." | "That did not work. The Claude CLI is not signed in." |
| Success | "🎉 Your CV is ready!" | "Your tailored CV is ready. Read it through, then apply on the company's own site." |

What is absent from the right-hand column matters as much as what is present:
no apology, no emoji, no exclamation marks, no hedging. And no harshness
either — this is someone who respects you enough to be direct, not someone
being blunt for its own sake.

### This is a workflow, not a reading experience

The single most useful test for any string here.

People are not reading this interface, they are moving through it: find,
filter, decide, prepare, apply. Every word sitting between someone and their
next action is friction, and explanatory prose belongs in documentation rather
than on a screen someone crosses forty times a week.

So each string earns its place or goes:

| Before | After |
|---|---|
| "Your tailored CV is built. All that is left is to apply." | "CV built. Apply on the company site." |
| "Read why each one fits. If you agree, build a tailored CV from there." | "Read why each fits, then build a CV if you agree." |
| "Each one has already been assessed against your CV." | "Already assessed against your CV." |
| "This usually takes under a minute. You can leave this page — it keeps going." | "Under a minute. You can leave this page." |
| "Builds a CV tailored to this role, using the gaps above. Takes about a minute." | "Rewrites your CV for this role, using the gaps above." |

Nothing in the right-hand column is colder. It is the same information with
the padding removed — and that terseness is itself part of the personality: an
agent who has read everything does not pad.

The one place to spend words is a **failure**, where the user is stuck and
needs a cause and a fix. Everywhere else, cut.

### The five traits

1. **Direct** — lead with the conclusion. "Six worth looking at", then the
   detail.
2. **Candid** — say when something is weak. A tool that likes everything is
   worthless, and this one is judged on the applications you do not waste time
   on as much as the ones you send.
3. **Unhurried** — no manufactured urgency. No "Act now", no countdowns, no
   streaks. Job hunting is long and people are already anxious.
4. **Unsentimental, not cold** — acknowledge that this is hard when it is
   relevant, then get on with it. Never dwell, never commiserate.
5. **Never performs** — no enthusiasm theatre, no congratulation, no
   encouragement the user did not earn. If something genuinely went well, the
   fact is the good news.

---

## Voice

The personality above, applied to individual strings.

**Plain, specific, unhurried.**

| Instead of | Write |
|---|---|
| "4.1/5" | "Strong match" |
| "Uses tokens" | "AI" badge, hover explains |
| "Generate tailored CV" | "Build my CV for this job" |
| "Pipeline" / "Board" | "My applications" |
| "No results found" | "No roles need your attention" |
| "Error: exit code 1" | "That did not work" + the actual cause |

### Rules

1. **Second person, active voice.** "Build my CV", not "CV generation".
2. **Never a number where a word will do.** A score means nothing to someone
   who has not read the rubric. Label first, number as supporting detail.
3. **Say what a thing does, not what it is.** "Read the original job advert",
   not "External link".
4. **No cheerleading.** No "Great news!", no "You're crushing it", no
   exclamation marks. Someone who has been rejected eleven times will not
   thank you for enthusiasm.
5. **No apologising for cost.** The old UI reassures constantly that things
   are free, because it has a cost problem. Stating it draws attention to it.
   Mark the AI actions; say nothing else.
6. **Failure states name the cause and the fix.** "The Claude CLI is not
   signed in" beats "exit code 1". Raw output stays behind a disclosure for
   the people who want it.
7. **Never claim progress you cannot see.** Named stages, no percentage bars,
   no fake ETAs.
8. **British English.**

---

## Colour

Four colours. Three carry meaning, one marks AI. Everything else is a neutral,
so any colour on the page is information.

| Token | Meaning |
|---|---|
| `--color-act` blue | You can act on this |
| `--color-ready` green | This is done or prepared |
| `--color-attention` amber | This needs your judgement |
| `--color-ai` ink | This spends your AI allowance |

**Paper, not terminal.** The page is warm off-white (`#faf9f7`), never pure
white and never dark. A dark UI with a bright accent reads "developer tool",
which is the opposite of the promise.

**Never decorate with colour.** If something is coloured, a user should be
able to say why.

---

## Type

**One family: DM Sans.** Bundled locally, so no network request and it works
offline. Hierarchy comes from size and weight only — mixing families is where
interfaces start looking assembled rather than designed.

Numbers that sit in columns use `.tabular`, not a monospace face. Monospace
would drag the developer-tool feel straight back in.

---

## Information architecture

Three questions a job seeker actually asks, in the order they ask them:

| Question | Screen |
|---|---|
| What should I do now? | **Next up** — the default |
| Where does everything stand? | **My applications** |
| What did the scan turn up? | **Everything found** |
| What does it know about me? | **My details** |

**Not "Find roles".** Nothing is found on that screen — the scanner already
did that, and naming a screen after a step that happened elsewhere leaves the
user looking for a search box that does not exist.

It holds both halves of what the scan produced, which is the point:

- **Not assessed yet** — queued; nothing has judged them either way.
- **Ruled out** — a rule in `config/prefilter.yml` matched and the role was
  dropped before any model call.

The second half used to be invisible: `batch/prefilter-rejects.tsv` was
written and never read, so roles vanished silently. That is the wrong default
when the judgement came from a config file rather than an assessment. Each one
now shows the rule that fired and the evidence that triggered it — *matched on
"Software Engineer"* — so the user can see what was decided for them, and
disagree.

**Every screen shows the whole process.** A role page is an opinion about one
job; without context it is a document that could have come from anywhere. So
each screen carries the same six-step rail:

> Found · Deciding · Preparing · Ready · Applied · In process

On a role page it marks that role's position (*Step 3 of 6: Preparing — then
Ready*). On a list page it carries counts, so the shape of the pipeline is
visible without leaving the page. The stage names live in one file,
`lib/journey.ts`, because a board that says "Deciding" while a rail says
something else makes the whole instrument untrustworthy.

Two deliberate omissions. It is **not a progress bar** — a percentage would
imply the end is reachable by effort alone, and most roles stop at "Applied".
And `closed` is **not a seventh step**; it is an exit from any point, and
drawing it on the spine would tell someone job hunting that rejection is the
destination.

**Next up is sorted by readiness, then by match.** Not by date, not by score
alone. The product exists to get applications out, so the top row is always
the most useful thing available.

**Free actions lead; paid actions follow a decision.** Nothing on a list
spends money. "Build my CV" appears only on the role page, at the bottom,
after the reasons to want it. Asking someone to spend their allowance on a
role they have not read earns the honest answer: *I don't know enough yet.*

**A weak match is told it is a weak match.** Below 4.0 the role page does not
say "Want to apply?" — it says the application is not worth sending and why,
and demotes the build button behind *Apply anyway*. Inviting someone to spend
their AI allowance on a role the tool has just scored 1.8 contradicts the
assessment directly above it, and being candid about the bad matches is most
of what makes the good ones worth trusting.

It recommends against; it never blocks. The score is a rubric and the user
knows things the rubric does not.

---

## Small screens

People check this on a phone between other things, so the phone layout is a
first-class layout, not a fallback.

**Rows become rows only when there is room for one.** Each list here pairs a
title block with an action block. Side by side at 375px the title loses — it
is `min-w-0`, so it collapses to "Engine…" while a button sits comfortably
beside it. Every such row is `flex-col` up to `sm:`, and titles wrap on a
phone rather than truncating.

**Navigation moves to a fixed bottom bar below `sm`.** Four labels plus the
wordmark do not fit across a phone; the fourth ran off the edge, so a quarter
of the product was invisible. A hamburger would have hidden all four and cost
a tap on every move through what is by design a four-step workflow. The bottom
bar keeps all four visible and in thumb reach. On a laptop, where they fit,
they stay inline in the header.

**The board stacks, it does not wrap.** At two columns the five stages run
1 2 / 3 4 / 5, which puts the last stage under the third and destroys the
progression the layout exists to show. One stage per row keeps the order.

---

## Accessibility

Not a compliance exercise — this audience skews older than a developer tool's
and includes people using this under stress.

- **Contrast**: body text and all semantic colours meet WCAG AA on paper.
  Faint text is metadata only, never the sole carrier of meaning.
- **Focus**: a visible 2px ring on every interactive element. Keyboard users
  must never lose their place mid-task.
- **Skip link**: first tab stop jumps the navigation.
- **Reduced motion**: honoured. The spinner is the only motion in the product
  and becomes static; the wording carries the progress.
- **Semantics**: real `<button>`, `<a>`, `<table>`/`<th>`, one `<h1>` per
  page, landmark elements.
- **Colour is never the only signal.** "CV ready" is green *and* says so.
- **Hover is never the only way in.** Tooltips open on focus too.
- **40px minimum touch target on a phone**, including links that look like
  text. Only the hit area grows — "View CV" still reads as a link. At desktop
  sizes these were 19–30px controls, which is a miss for anyone whose hands
  are less steady than a designer's.

---

## Things we do not do

Checked against the catalogue of
[vibe-coded design tells](https://github.com/JCarterJohnson/vibecoded-design-tells)
— the recognisable marks of an interface a model produced without anyone
deciding anything.

| Tell | Our position |
|---|---|
| shadcn/Tailwind defaults | Tailwind for utilities only. Every colour, radius and type decision is ours. No component library. |
| **"AI purple" gradient** | **AI actions were violet. They are now ink.** Violet was chosen *because* it is "the AI convention" — which is the exact reasoning that produces a generic look. |
| Gradient hero text | Never. |
| Unprompted neon glow | Never. |
| Emoji as icons | Never in the interface. Inline SVG only. (The tracker file format uses ✅ — that is data we parse, not an icon we render.) |
| Centred hero + three cards | Never. Content is left-aligned and list-shaped, because the content is a list. |
| Bento grids | Never. |
| **Glassmorphism** | **Removed.** The header had `backdrop-blur`; it is now solid. |
| Aurora / mesh / blob backgrounds | Never. |

The meta-tell in that research is *"they all look the same"* — the failure is
not any single effect but making choices by default rather than by decision.
Which is why this file exists: every rule above has a reason attached, and a
reason is the thing that survives review.

**If you add a visual flourish, write down why here. If you cannot, delete
the flourish.**
