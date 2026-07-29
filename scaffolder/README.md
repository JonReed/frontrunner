# career-ops

One-command installer for [**career-ops**](https://github.com/santifer/career-ops) — the AI-powered job search pipeline built on Claude Code.

```bash
npx @santifer/career-ops init
```

This sets up a ready-to-use workspace:

1. Clones career-ops at the latest stable release
2. Installs dependencies

Then open your AI coding tool in the folder. **On first launch the agent walks you through setup — your CV, profile and target roles — just by chatting.** Nothing to configure by hand.

Frontrunner supports **Claude Code** and **Codex**, plus **Antigravity CLI** for the free tier ([docs/FREE_TIER.md](../docs/FREE_TIER.md)). The modes underneath are CLI-agnostic, so others will very likely work — they are just not tested here, and support questions about them will not get a useful answer.

The installer bootstraps CLI skill entrypoints after clone, so entrypoints exist even when `npx` pulled an older release tag.

## Usage

```bash
npx @santifer/career-ops init [folder]   # default folder: ./career-ops
```

Prefer the manual route? `git clone` still works exactly as before — see the [setup guide](https://github.com/santifer/career-ops/blob/main/docs/SETUP.md).

## Requirements

- Node.js 22.5+
- git

## License

MIT © [Santiago Fernández de Valderrama](https://santifer.io)
