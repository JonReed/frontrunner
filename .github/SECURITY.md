# Security policy

## Reporting a vulnerability

Do not open a public issue or discussion for a suspected vulnerability.

Use [GitHub's private vulnerability reporting](https://github.com/Furls-Digital/frontrunner/security/advisories/new).
Include the affected version or commit, a minimal reproduction, likely impact,
and any suggested remediation. Do not include real CVs, credentials, tokens, or
other personal data.

The maintainer will acknowledge the report, investigate it, and coordinate a
fix and disclosure with the reporter. Response and release timing depends on
severity and reproducibility; this project does not promise an artificial
fixed-hour SLA.

## Supported versions

Security fixes are made on `main`. Older snapshots and upstream career-ops
releases are not maintained by this fork.

## Scope

Security-sensitive areas include:

- provider and job-description ingestion, including SSRF and redirect handling;
- local file access, path containment, command execution, and update handling;
- the local web interfaces, including origin checks, XSS, and unsafe URL use;
- generated HTML/PDF content and hostile job-description rendering;
- plugin installation, registry validation, permissions, and network egress;
- GitHub Actions, release automation, and dependency supply-chain controls.

Vulnerabilities in third-party dependencies are in scope when they create a
practical risk in Frontrunner. Reports that require physical access to an
already-compromised machine may be closed unless they cross an additional trust
boundary.

## Disclosure

Please allow time for a fix to be prepared and distributed before publishing
details. Reporters will be credited unless they prefer otherwise.
