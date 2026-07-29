# Governance

Frontrunner is maintained by [Furls Digital Ltd](https://furls.co.uk). Final
say on architecture, scoring and the data contract rests there.

## How decisions get made

- **Bug fixes** — open a PR with a clear description.
- **New features** — open an issue first, so nobody builds something that will
  not be merged.
- **Docs and translations** — welcome from anyone, low barrier.

## What this project will not trade away

These are the constraints every change is judged against, and the reason to
write them down is that they are easy to erode one convenience at a time.

- **User files are the user's.** The system/user layer split in
  [DATA_CONTRACT.md](DATA_CONTRACT.md) is not weakened for convenience.
- **The human decides.** The tool recommends, scores and drafts. It never
  submits an application.
- **Remote content is hostile.** Job adverts, API responses and
  model-generated fields are treated as untrusted, and a model that sees them
  gets no local tools.
- **No terminal.** The target user is not a developer. Anything that requires
  a command line to accomplish is unfinished, not shipped.

## Scale

There is one maintainer. This file deliberately does not describe a
contributor ladder, promotion criteria or a voting process — the upstream
project's version did, and inheriting that here would have described a
community that does not exist. If Frontrunner ever has a team, this file gains
the structure to match, and not before.
