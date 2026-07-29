# Inherited web source — archived

This directory preserves the upstream career-ops web application for reference
and future merge analysis. It is **not a Frontrunner runtime**.

The inherited application contains privileged agent, browser-driving and direct
process endpoints that do not satisfy Frontrunner's hostile-content or
application-service boundaries. Consequently:

- `npm run dev` and `npm run start` exit unsuccessfully with migration guidance.
- A request-wide proxy returns `410 Gone` for every route if Next.js is launched
  directly.
- There is no environment-variable bypass or development escape hatch.

Use the workflow-first interface instead:

```bash
npm -C ui run dev
```

The archived source is still buildable and type-checkable so upstream changes
can be inspected safely:

```bash
npm run typecheck
npm run build
```
