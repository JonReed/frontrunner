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
| What else is out there? | **Find roles** |
| What does it know about me? | **My details** |

**Next up is sorted by readiness, then by match.** Not by date, not by score
alone. The product exists to get applications out, so the top row is always
the most useful thing available.

**Free actions lead; paid actions follow a decision.** Nothing on a list
spends money. "Build my CV" appears only on the role page, at the bottom,
after the reasons to want it. Asking someone to spend their allowance on a
role they have not read earns the honest answer: *I don't know enough yet.*

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
