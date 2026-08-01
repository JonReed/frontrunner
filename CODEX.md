@AGENTS.md
<!-- Codex config — imports AGENTS.md -->

## NOTHING GOES UPSTREAM

`santifer/career-ops` is the parent project. This fork **never** writes to it —
no pull requests, no pushes, no issues, no comments. The `upstream` remote
exists for `git fetch` and commit-by-commit review, nothing else.

Every `gh` command that creates or changes anything must name this fork
explicitly:

```bash
gh pr create --repo Furls-Digital/frontrunner ...
```

Without `--repo`, `gh` picks its own default, and that default has resolved to
the parent — which is how a pull request was once opened in someone else's
repository. A pull request cannot be deleted once it exists.

`src/lib/upstream-guard.mjs` enforces this for hosts that run its hooks, but
the guard is a backstop, not permission to stop thinking about it. Read-only
review — `git fetch upstream`, `gh pr view`, `gh pr list` — is always fine.

<!--
Repeated from AGENTS.md deliberately: the failure it prevents is an agent
acting before it has read AGENTS.md, so the rule has to sit at the entry point.
-->
