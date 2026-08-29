# quickreviewd — a 24/7 automated PR reviewer for your GitHub repo

quickreviewd reviews pull requests around the clock: a small, deterministic
TypeScript daemon (no LLM in the hot path) receives GitHub App webhooks, runs
an authoritative reconcile poll, and drives sticky **pi** coding-agent
sessions in tmux — one conversation per PR, blank-slate "lens" passes per
review round, a global overseer session, and a daily end-of-day learning
sweep. Reviews post as *your* GitHub App, through one gated mutation path.

**Status: honest beta.** This system has run in production continuously since
2026-08-14 reviewing a busy commercial repository, and the review behaviour
(severity ladder, CI gate, recheck discipline, feedback loop) is
battle-tested there. The *packaging* for third parties — this repo — is
young: expect rough edges in setup, and read the caveats below before
trusting it with approvals (`dry_run = true` is the shipped default, so a
fresh install never posts anything).

## What it does

- **Reviews on trigger, not on every PR**: a label or a team review-request
  marks a PR for review; everything else is ignored.
- **One sticky session per PR**: the same conversation follows the PR through
  pushes, author replies, re-reviews and post-approval rechecks — no
  cold-start per round.
- **Blank-slate lens passes**: each round fans out focused single-concern
  passes (contracts, data safety, concurrency, security, prod risk, intent,
  placement, simplicity, backcompat, …) selected per diff, then a validator
  pass audits every candidate finding before anything posts.
- **A hard severity contract**: P0–P2 blockers, questions, nits — with a
  reachability gate (contrived findings never block), a nit-treadmill cap on
  re-reviews, and a "For a human to double-check" section instead of ever
  handing the review off to a human.
- **CI-aware approvals**: no green CI at the head means approval is withheld
  (the review posts as a COMMENT) until checks pass — infra failures
  included.
- **Post-approval rechecks**: pushes after an approve are re-audited
  (uphold-by-default; the only allowed transition is APPROVE →
  REQUEST_CHANGES, never a silent re-approve).
- **A learning loop**: `[feedback]`-prefixed PR comments and behavioural
  signals (dismissals, merges over a standing block) feed reviewer memory and
  a same-day validator addendum; an end-of-day sweep curates durable
  learnings.
- **One mutation gate**: every GitHub write goes through a single gate with
  posting-time guards; in dry-run mode every would-be mutation is written to
  `state/dryrun/` instead of executed. There is structurally no code path
  that dismisses reviews or nominates human reviewers.

Optional extras that degrade cleanly when unconfigured: an operator TUI
(`qcr tui`, board + memory management over ssh), a Slack concierge, a local
"companion" pi session, and an OpenViking-backed reviewer memory engine.

## Architecture sketch

```
GitHub App webhook (HMAC, dedupe) ─┐
reconcile poll (authoritative) ────┼→ state machine → dispatch (FIFO, lens
verdict watcher (verdict/*.json) ──┘   selection, caps) → RoundOrder
                                          │
                          sessions: tmux + pi, one per PR (+ overseer)
                          worktrees per PR, wake files → inject bridge
                                          │
                          posting via gated scripts (guards + CI gate)
```

`src/` is the daemon (config, gate, GitHub adapter, state machine, dispatch,
guards, recheck, severity, templates, memory seam); `prompts/` + `agents/`
are the frozen prompt seeds (integrity-pinned by tests); `profiles/` carries
repo profiles (house-rule addenda + lens heuristics); `extensions/` are the
pi extensions the sessions run with; `docker/` + `deploy/` are the two
deploy paths.

## Prerequisites

- **Node ≥ 22** (build + tests run offline with no secrets).
- **Docker** (the daemon ships as one container; compose file included).
- **A GitHub App you register** on your repo — a manifest and a step-by-step
  guide are included ([docs/github-app-setup.md](docs/github-app-setup.md),
  [deploy/github-app-manifest.json](deploy/github-app-manifest.json)). No
  personal access token is used, anywhere.
- **An LLM route** for the pi review sessions — two supported routes,
  documented in [docs/llm-setup.md](docs/llm-setup.md):
  1. **ChatGPT OAuth** (subscription; the shipped default — model strings use
     the `openai-codex/` prefix, one `/login` inside the container), or
  2. **OpenAI API key** (usage-billed; switch the model strings' provider
     prefix in config).
- **HTTPS ingress of your choice** to the webhook port (8787): any reverse
  proxy or tunnel works; nothing here assumes a particular vendor.

## Quickstart

```sh
git clone <this repo> && cd <repo>
npm ci && npm test && npm run build   # green offline, no secrets needed

cp config.example.toml config.toml    # ~10 clearly-marked FILL values:
                                      # repo, app id/slug/bot login, review
                                      # team/label, owner identity, profile
bash deploy/collect-secrets.sh        # interactive: App private key, webhook
                                      # secret, ... (shape-aware — only what
                                      # your deployment needs)

export QCR_UID=$(id -u)
docker compose up -d --build          # plain-Docker path (docker/daemon/README.md)
curl -s http://127.0.0.1:8787/health

# point your HTTPS ingress at :8787, install the App on your repo,
# then label a PR with your review trigger and watch state/dryrun/ fill up.
```

`dry_run = true` ships as the default: the daemon does everything except
execute GitHub mutations, and writes each would-be call to `state/dryrun/`
for you to inspect. Flip `dry_run = false` only when you trust what you see —
that flip is the owner's manual act (see
[docs/ownership.md](docs/ownership.md)).

The Ansible route under `deploy/ansible/` remains the advanced path for a
managed VM; both produce the same runtime.

## Configuring the reviewer for *your* repo

- **Repo profile** ([docs/profiles.md](docs/profiles.md)): house-rule addenda
  packs + lens-selection heuristics. Ship-included: `profiles/example-django/`
  (a worked Django profile: migration discipline, ORM usage, test doctrine)
  and `profiles/minimal/` (generic only). Start from minimal, or copy the
  Django example and edit.
- **Ecosystem pre-checks**: the Django migration-collision pre-check is
  selected by the profile (`ecosystem = "django"`); every other ecosystem is
  cleanly off (`"none"`) — no false findings, no degraded-check noise.
- **Owner identity** (`[owner]` in config): name, chat id, GitHub login —
  every surface (mentions, tiers, prose) renders identity from config.
- **Issue sink**: where operational defects and tuning output land is
  pluggable — GitHub Issues on your repo (gated + capped), a local
  filesystem tracker, or none.

## What it costs to run

The deterministic daemon is negligible (one small container). The LLM spend
is per review round and scales with diff size and lens count: a typical round
runs several lens passes plus a validator over the diff, and a busy repo can
consume a serious share of a ChatGPT subscription's capacity — or, on the
API route, real per-token money. Use `qcr spend` / `qcr today` to watch
usage, start with the trigger label on a few PRs, and widen from there. The
system's own history is a warning here: undisciplined re-review loops are
exactly why the recheck/no-op/nit-cap machinery exists.

## Operating

```sh
scripts/qcr status | today | why <pr> | spend   # CLI over daemon state
scripts/qcr tui                                 # operator board (over ssh)
docker compose logs -f daemon                   # daemon logs
```

## Documentation map

- [docs/github-app-setup.md](docs/github-app-setup.md) — register the App in minutes
- [docs/llm-setup.md](docs/llm-setup.md) — the two LLM credential routes
- [docker/daemon/README.md](docker/daemon/README.md) — the plain-Docker deploy path
- [docs/profiles.md](docs/profiles.md) — repo profiles: addenda packs + heuristics
- [docs/ownership.md](docs/ownership.md) — the owner-only surfaces (dry-run flag, frozen seeds, ratification)
- [docs/provenance.md](docs/provenance.md) — what the FT-#### citations in this codebase mean
- [CONTRIBUTING.md](CONTRIBUTING.md) — build, test, and the frozen-seed rule
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities

## License

Apache-2.0 (see [LICENSE](LICENSE)); third-party attributions in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
