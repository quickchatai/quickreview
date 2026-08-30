# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via **GitHub's private vulnerability reporting on this
repository** (Security tab → "Report a vulnerability"). Reports reach the
maintainer's GitHub notifications directly; no separate email address is
used.

Include: the affected component (webhook handler, mutation gate, posting
scripts, TUI/companion, memory engine), reproduction steps, and impact. You
should receive an acknowledgement within a few days.

## Scope notes for researchers

- The daemon's only network listener is the webhook endpoint
  (`POST /webhook`, constant-time HMAC verification, delivery dedupe) and
  `GET /health`. The memory engine listens on loopback only.
- All GitHub credentials are App credentials (short-lived JWT → installation
  token); no personal token exists anywhere in the system.
- Every GitHub mutation flows through a single gate with posting-time
  guards; `dry_run = true` (the shipped default) writes intended mutations
  to disk instead of executing them.
- Prompt-injection resistance of the review sessions is an explicit design
  concern (quoted PR content is fenced as untrusted data in the round
  prompts); reports demonstrating a working injection from PR-controlled
  content to a reviewer-visible effect are very welcome.
