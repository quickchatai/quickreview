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
  `GET /health`. Under `[ingress] shape = "polling"` the webhook endpoint
  refuses every delivery unread. The memory engine listens on loopback only.
- The daemon's GitHub credential is one of two, chosen by `[github] auth`:
  - `"app"`, the default and the only route that takes webhooks: GitHub App
    credentials (short-lived JWT → installation token).
  - `"user"`: the operator's own GitHub token. Owner ruling 2026-10-24,
    amending hard rule 3: the daemon may run on the person's own credential
    instead of a GitHub App. That mode is **polling only** (config load
    refuses any other `[ingress] shape`): no webhooks, no webhook self-heal,
    no App self-config, and every route that needs the App JWT is refused.
    Every mutation still goes through the one gate. Every review posts as a
    **COMMENT** whose body states the verdict, so an automated verdict never
    counts as the person's approval or block. The token reaches the daemon
    only as the **file** `<secrets dir>/github_token` (0600, the token alone,
    rewritten atomically by the host-side `qcr github-token sync`), never
    through the environment or a command line. The daemon re-reads it every
    five minutes and after a 401. In this mode the companion's GitHub token
    is a copy of that file, not a down-scoped read-only token, so the
    companion guard's write veto is its only fence.

  The local `qcr review` route and the GitHub Action may use the person's
  own credential chain. The daemon never reads one from the environment.
- Every GitHub mutation flows through a single gate with posting-time
  guards; `dry_run = true` (the shipped default) writes intended mutations
  to disk instead of executing them.
- Prompt-injection resistance of the review sessions is an explicit design
  concern (quoted PR content is fenced as untrusted data in the round
  prompts); reports demonstrating a working injection from PR-controlled
  content to a reviewer-visible effect are very welcome.
