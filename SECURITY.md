# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in relevo, please
**report it privately**. Do not open a public GitHub issue or pull request
that describes the problem before a fix is available.

Preferred channel:

- Open a private security advisory:
  <https://github.com/davo20019/relevo/security/advisories/new>

Alternative channel:

- Email the maintainer at **davo20019@gmail.com** with subject
  `relevo security report`.

When reporting, please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, including a minimal `agents.json` or command sequence
  when relevant.
- The relevo version (`relevo --version` or the installed package version)
  and your operating system and Node.js version.
- Any proof-of-concept code, logs, or screenshots that help us reproduce it.

You can expect:

- An acknowledgement within **3 business days**.
- An initial assessment within **7 business days**.
- A coordinated disclosure timeline once the impact is understood. We aim
  to ship a fix and publish a GitHub Security Advisory before any public
  details are shared.

## Supported Versions

relevo is in active `0.x` development. Security fixes are published against
the latest minor release on npm.

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

## Scope and Threat Model

relevo is a **local orchestration layer** for coding-agent CLIs that the
user has already installed and authenticated. It does not make outbound
network calls of its own; it spawns child processes that do.

In scope for this policy:

- Command, argument, or path injection in how relevo invokes child CLIs.
- Path traversal in task names, agent keys, transcript paths, or other
  filesystem operations relevo performs.
- Unsafe handling of `agents.json` (built-in, user, or project-local).
- Information disclosure in transcripts, session files, or other state
  written by relevo.
- Supply-chain issues in the published `relevo` npm package itself.

Out of scope (please report to the upstream project instead):

- Vulnerabilities in Claude Code, Codex, Cursor, OpenCode, Antigravity (`agy`),
  or any other underlying agent CLI.
- Issues that require an attacker who already has interactive shell access
  as the user running relevo.
- The intentional automation defaults documented in `README.md` (skipping
  permission prompts, sandbox-off, MCP auto-approval, etc.). These are
  documented trade-offs of running headless coding agents in parallel and
  can be tightened in `agents.json`.

Thank you for helping keep relevo and its users safe.
