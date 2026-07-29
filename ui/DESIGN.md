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

## Identity and product shell

**The mark is three lanes and one leader.** It also reads as an F at favicon
size, but it is not a generic initial in a coloured tile. The product narrows
many possible roles into a few worth pursuing; the mark is that idea reduced
to one shape. Keep it in ink, with blue reserved for the leading point.

**The shell is quiet and persistent.** The wordmark and four destinations sit
in a translucent paper header on larger screens. Active navigation uses a
simple ink rule, not a filled pill competing with the page. On phones the same
four destinations use familiar line icons and short labels in a fixed bottom
bar. Never introduce a hamburger while there are only four destinations.

**Depth describes layers, not importance.** White surfaces may use a
one-or-two-pixel neutral shadow to separate them from paper. Menus and the
desktop sticky action surface may cast a deeper shadow because they sit above
other content. Do not give every card a dramatic shadow.

**Rounded corners belong to surfaces.** Main surfaces use the same 16px
radius; controls use 8px. Mixing many radii makes the interface feel assembled
from unrelated components.

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

It is the **same rail everywhere** — identical stations, labels and placement.
It sits above the page title because it is navigation one level above the
screen being viewed. List-page counts need no explanatory sentence underneath;
the labels already say what each number counts. A role page still names that
role's exact position (*Step 3 of 6: Preparing — then Ready*).

The stations sit on one continuous neutral lane. Filled blue stations describe
a single role's past, a blue ring is its present, and neutral rings are what
comes next. On population views the count under each station is the primary
signal; colour is not used to imply that a pile of roles is progress.

List pages briefly used a different treatment — bordered cards that scrolled
sideways on a phone. Two visual languages for the one concept the product is
built around made two screens showing the same six steps look like two
different ideas, and the version that scrolled hid the last two steps off the
edge. One rail, six columns, nothing hidden.

The stage names live in one file, `lib/journey.ts`, because a board that says
"Deciding" while a rail says something else makes the whole instrument
untrustworthy.

The homepage no longer repeats the count in prose. It said *"247 more roles
found and not yet scored"* directly above a rail whose first column says
exactly that — and the sentence led with a backlog, which is the wrong first
thing to tell someone whose next action is further down the page.

Two deliberate omissions. It is **not a progress bar** — a percentage would
imply the end is reachable by effort alone, and most roles stop at "Applied".
And `closed` is **not a seventh step**; it is an exit from any point, and
drawing it on the spine would tell someone job hunting that rejection is the
destination.

**Closed is outside the spine, but never hidden.** My applications links to a
separate Closed list. Removing a role clears the live workflow without deleting
its assessment or CV, and the role can be restored. The process model stays
honest without making a reversible decision feel destructive.

**Status words describe observable events.** Applied means the application was
sent and is waiting for an employer response. In process begins only when the
employer has replied; the row then keeps the more specific tracker status such
as Responded, Interview, Offer or Hired. Each of those outcomes is recorded by
a control that names the event the user observed; the interface never infers an
offer or hire from a generic stage move. Employer rejection is also separate
from *Not for me*: one records what the employer decided, the other records the
candidate's decision.

**Applied creates a real follow-up, not a reminder to remember.** The tracker
move seeds the canonical cadence transaction. Due and overdue dates appear on
application rows and role pages, and urgent follow-ups rise to the top of Next
up. Reply and interview cadence begins on the recorded event date rather than
the older evaluation date. A failed side-effect remains recoverable from the
durable workflow marker instead of silently losing the schedule.

**One next action per row.** The visible control says what the person is
deciding — *I want to pursue this* — rather than describing an internal state
transition. Backwards moves and *Not for me* sit in a small secondary menu.
Preparing rows say what remains: CV needed, CV building, or job advert
unavailable. Once a completed CV exists, the primary action becomes
*Application ready* and advances the role to Ready; the interface must never
show both *CV ready* and *CV needed*.

**Changes leave a short undo window.** A successful move replaces the row with
the result and an Undo action before the list refreshes. Found-stage removals
mark the pipeline entry dismissed rather than deleting its source line, so the
same guarantee applies before evaluation.

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

**Sticky action surfaces are desktop-only.** A phone already gives up space to
the bottom navigation. Pinning a second tall surface above it obscures too much
of the assessment someone is meant to read before acting, so role actions stay
in document flow on small screens.

**Stages are lists, not a miniature Kanban board.** Selecting a step in the
rail opens the same list-shaped page filtered to that step. The unfiltered My
applications page stacks those lists in process order. This keeps job cards
wide enough to read and makes the process rail the one navigation model.

**Large source lists have ordinary filters.** Everything found can be narrowed
by title, company and location. The page title does not repeat a total that
combines live and ruled-out roles; each section owns and explains its count.

---

## When the engine is not there

Every AI action spawns the Claude CLI, and it can be missing or signed out.
That state is reported **before** it costs anything, never discovered by
clicking and waiting — a failure after sixty seconds reads as "this product is
broken", not "sign in first".

Three surfaces, one fact. A banner on the screens that offer AI actions, but
**only when something is wrong**: a green "all good" badge on every page is
noise that trains people to ignore the banner that matters. Always-on detail
on My details, where someone goes to ask what the tool is using. And on a role
page it **replaces** the AI button rather than letting it fail.

**The fix is a button, not a command.** Claude Code and the Claude desktop app
keep separate credentials, so someone can install the app, sign into it, use it
to set Frontrunner up, and still have an unauthenticated CLI — which makes this
the state most new users land in. Telling them to open a terminal at that
moment would break the constraint the whole product is built on.

The button never claims a success it has not observed: "connected" appears only
after the CLI itself reports it. After ninety seconds it stops implying
progress and offers the command as a fallback, because a spinner that never
resolves is worse than an honest dead end.

---

## Profile maintenance

My details is the user-facing source of truth, not a one-time onboarding
receipt. Search city and country, working pattern, timezone, work
authorisation, salary currency and target roles remain editable after setup.
Working pattern stays free text: “remote preferred; hybrid in London” is useful
matching evidence, while forcing it into one of three buttons would discard the
part that matters.

Replacing the canonical CV is separate from ordinary field editing. The
replacement is parsed locally, shown back as editable text, and requires an
explicit second confirmation because it changes the evidence used by every
future assessment. The interface says what is and is not affected: existing
reports and generated PDFs remain unchanged. PDF import is intentionally not
offered; extracting a two-column PDF can silently scramble career history, so
the user is asked for the original Word file or pasted text instead.

---

## Exceptions and resumable work

A deterministic rule is a default, not an irreversible verdict. Ruled-out
roles expose “Assess anyway” beside the rule and matched evidence. The action
requires confirmation because a later assessment may spend model allowance,
then records an exception scoped to that exact posting URL and exact rule. A
different role—or the same role matching a different hard limit—still fails
closed.

Long-running work belongs to the application, not the page that launched it.
Returning to a role while its CV is building must reattach to the durable job
and resume the same progress state. It must never show a fresh build button
while another process already owns that role’s model spend.

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
