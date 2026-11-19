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
- The daemon's GitHub credential is one of three, chosen by `[github] auth`
  (hard rule 3 as amended: two were allowed, and a host-supplied installation
  token is the third):
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

    `[github] token_source = "host"` (with `auth = "user"` or
    `auth = "installation"`) is the marker of a **host-managed** credential: a host that runs the reviewer writes that
    same file (atomically, 0600, the token alone) and keeps a token with at
    least 15 minutes of life in it at all times, and may write the token's
    expiry beside it as `github_token.expires_at`, a note that is never a
    credential. Everything above still holds: polling only, COMMENT reviews,
    the one gate, the file as the only way the token reaches the daemon, and
    the same re-read rules. What changes is that nothing on the machine
    obtains or refreshes a GitHub credential: the onboarding account step
    proves the file's token and neither runs `gh` nor installs the refresh
    crontab entry, `qcr github-token sync` refuses, the local `qcr review`
    route reads that file and no other source (no `gh`, no environment
    variable), and the home offers no GitHub sign-in, no repository pick, no
    switch-on and no go-live of its own. The token's scope and lifetime are
    the host's to set; the reviewer assumes neither and never asks the person
    to sign in to GitHub on such an install.

  - `"installation"`: a GitHub App **installation's** token that the host
    which runs the reviewer mints and supplies. It exists only with
    `token_source = "host"` (config load refuses it otherwise), and reaches
    the daemon exactly as the host-managed token above does: the one file,
    re-read on first use, every five minutes and after a 401. The identity is
    the App's bot, named by `[github] app_slug` (config load requires it and
    derives `bot_login` as `<slug>[bot]`), so reviews post as **APPROVE /
    REQUEST_CHANGES / COMMENT**, as under `"app"`. The COMMENT-only rule is
    bound to the person identity (`auth = "user"`), not to "the token came
    from a file".

    **No App private key is on the machine.** In this mode `app.pem`,
    `app_id` and the webhook secret are never read, no App JWT is signed, and
    every route that needs one is refused before anything is sent. So the mode
    is **polling only** (config load refuses any other `[ingress] shape`), with
    no webhooks, no webhook self-heal and no App self-config; the onboarding
    steps that create an App or ask an App who it is are off. The token is
    proved with a read of the configured repository, never GitHub's user
    endpoint (which refuses an installation token), and the reviewer checks
    that the token's own login is the configured `bot_login`: a slug that
    names another App is refused in words instead of leaving a reviewer that
    cannot recognise its own reviews. The companion gets **no** GitHub token
    in this mode: there is no key to mint a read-only one from, and the
    reviewer's own token, which can post, is never copied to it. The token's
    permissions, repository and lifetime are the host's to set at mint; the
    reviewer assumes none of them, nor the token's length.

  The local `qcr review` route and the GitHub Action may use the person's
  own credential chain. The daemon never reads one from the environment.
- Every GitHub mutation flows through a single gate with posting-time
  guards; `dry_run = true` (the shipped default) writes intended mutations
  to disk instead of executing them.
- Prompt-injection resistance of the review sessions is an explicit design
  concern (quoted PR content is fenced as untrusted data in the round
  prompts); reports demonstrating a working injection from PR-controlled
  content to a reviewer-visible effect are very welcome.
