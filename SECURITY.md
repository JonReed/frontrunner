# Security Policy

## Reporting a Vulnerability

**Do NOT open a public issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/Furls-Digital/frontrunner/security/advisories/new).
The report is visible only to the maintainers of this repository until a fix is
published.

Please include:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

We aim to respond within 72 hours, and will work with you to understand and
address the issue before any public disclosure.

Frontrunner is a fork of [career-ops](https://github.com/santifer/career-ops).
If the issue is in inherited upstream code it may affect both projects, but
report it here — this repository's maintainers will coordinate upstream.
Do not send reports about Frontrunner to the upstream author.

## Scope

Security issues in the following are in scope:

- **Scripts** (`*.mjs`) — command injection, path traversal, SSRF
- **Web interfaces** (`web/`, `ui/`) — unsafe file access, command execution, XSS, or data exposure
- **Templates** (`templates/`) — XSS in generated HTML/PDF
- **Configuration** — secrets exposure, unsafe defaults

## Out of Scope

- Issues in third-party dependencies (report upstream)
- Issues requiring physical access to the user's machine
- Social engineering attacks
- frontrunner is a local tool — there is no hosted service to attack

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit the reporter (unless they prefer anonymity) in the release notes.
