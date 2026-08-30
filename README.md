# QuickReview — a sovereign, 24/7 AI code reviewer for your GitHub repo

QuickReview reviews pull requests around the clock: a small, deterministic
TypeScript daemon (no LLM in the hot path) receives GitHub App webhooks, runs
an authoritative reconcile poll, and drives sticky **pi** coding-agent
sessions — one conversation per PR, blank-slate "lens" passes per review
round, an adversarial validator before anything posts, and a continuous
learning loop your organization owns end to end. Reviews post as *your*
GitHub App, through one gated mutation path, typically within minutes of
being requested.

**Status: honest beta.** This system has run in production continuously
since mid-August 2026 reviewing a busy commercial repository, and the review
behaviour (severity ladder, CI gate, recheck discipline, feedback loop) is
battle-tested there. The *packaging* for third parties — this repo — is
young: expect rough edges in setup, and read the caveats below before
trusting it with approvals (`dry_run = true` is the shipped default, so a
fresh install never posts anything).

## Why this exists

> Nobody on your team is actually reviewing the volume of code your team now
> produces. The author asks their agent to write the code, the reviewer asks
> their agent to review it, the author replies "address the comments" — two
> humans spending a day as slow message brokers between two AIs. The review
> was already AI on both sides. The dead time was ours.
>
> QuickReview stops pretending. Human judgment moves up a level — "is this
> something we need and want?" — while the machine checks what is checkable:
> conformance, security posture, migration safety, completeness, intent.
> And the whole loop, from the harness to the reviewer's memory to its
> accumulated learnings, runs on your infrastructure under your keys.

The full argument — including the eight design beliefs this system was built
on and the non-goals it refuses to unrefuse — is in
[**MANIFESTO.md**](MANIFESTO.md). It is worth the five minutes.

## What it does

- **Reviews on trigger, not on every PR**: a label or a team review-request
  marks a PR for review; everything else is ignored.
- **One sticky session per PR**: the same conversation follows the PR through
  pushes, author replies, re-reviews and post-approval rechecks — no
  cold-start per round, with a pinned findings ledger that survives context
  compaction.
- **Blank-slate lens passes**: each round fans out focused single-concern
  passes (contracts, data safety, concurrency, security, prod risk, intent,
  placement, simplicity, backcompat, …) selected per diff, then an
  adversarial validator re-derives every candidate finding from the code
  before anything posts.
- **A hard severity contract**: P0–P2 blockers, questions, nits — with a
  reachability gate (contrived findings never block), a nit-treadmill cap on
  re-reviews, self-sufficient blocker bodies an AI implementer can fix from
  the comment alone, and a "For a human to double-check" section instead of
  ever handing the review off.
- **Three markers with one meaning each**: `[check this]` (a human should
  verify — the bot structurally cannot resolve the thread), `[ask your
  human]` (the author's AI implementer must put it to its person), and
  `[deferred]` (real finding, not this PR — the reviewer files the tracking
  issue itself).
- **CI-aware approvals**: no green CI at the head means approval is withheld
  (the review posts as a COMMENT) until checks pass — infra failures
  included; the withheld approval carries forward across upheld rechecks.
- **Post-approval rechecks**: pushes after an approve are re-audited
  (uphold-by-default; the only allowed transition is APPROVE →
  REQUEST_CHANGES, never a silent re-approve); a hand-resolved merge
  conflict is audited against both merge parents.
- **A learning loop**: `[feedback]`-prefixed PR comments and behavioural
  signals (dismissals, merges over a standing block) bite the same day
  through a demotion-only validator addendum; an end-of-day sweep curates
  durable learnings; rubric changes land only via one-click human
  ratification; and accumulated evidence is mined *back into your
  implementing agents' instructions* so recurring finding classes stop
  being written at all.
- **One mutation gate**: every GitHub write goes through a single gate with
  posting-time guards; in dry-run mode every would-be mutation is written to
  `state/dryrun/` instead of executed. There is structurally no code path
  that dismisses reviews or nominates human reviewers.
- **Sovereign by construction**: self-hosted daemon, your GitHub App, your
  memory store under your keys, rules as files in your repo. The only thing
  that leaves your infrastructure is the model call, to the provider you
  configured.

Optional extras that degrade cleanly when unconfigured: an operator TUI
(`qcr tui`, board + memory management over ssh), a Slack concierge, a local
"companion" pi session, and the OpenViking-backed reviewer memory engine.

## How a review runs

1. **Trigger** — someone labels the PR (or requests the review team).
   Triggered PRs only; bot-authored PRs never enter the queue. Webhooks are
   HMAC-verified and deduped; a reconcile poll is the authority behind them,
   and where local state and GitHub disagree, GitHub wins.
2. **Dispatch** — the daemon (plain code, no model) resolves the head sha,
   prepares a worktree at exactly that sha, plans the round — which lenses,
   at what model tiers, with what gates — runs the deterministic
   migration-collision pre-check, and delivers a receipt-tokened wake to the
   PR's own session. A round in flight is never interleaved.
3. **Fan-out** — the PR's session launches the planned lens passes as
   blank-slate leaves: no memory, no ability to post, no ability to spawn.
   Each returns findings with severity, confidence, reachability, and exact
   changed-line anchors.
4. **Validate** — an adversarial validator, never cheaper than the strongest
   lens in the round, re-derives every claim from the code and kills or
   downgrades from a closed vocabulary; both sides are recorded. Then the
   deterministic mapping fires: contrived never blocks; any surviving
   blocker means REQUEST_CHANGES; otherwise APPROVE. There is no third
   verdict.
5. **Post** — through the one gate, guards firing seconds before the write:
   unchanged head posts nothing; a human approval downgrades a block to a
   comment; merged/closed is re-checked; no green CI means approval is
   withheld. The verdict lands as a file the daemon validates — malformed
   routes to an anomaly, never to an approve.
6. **Recheck & ping-pong** — pushes, CI completions, base advances and
   author replies wake the same session. Trivial deltas cost one
   classification and a no-op. Author replies get at most three exchanges
   per finding, then concede or hold.
7. **Learn** — every round leaves a per-finding reasoning record; feedback
   and behavioural signals land the same day; the nightly curator promotes
   durable learnings; humans ratify rubric changes with one click.

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
  proxy or tunnel works; nothing here assumes a particular vendor. The compose
  file ships three optional tunnel sidecars — a Cloudflare **quick tunnel**
  (no account at all; the rotating hostname is re-pointed automatically),
  **ngrok**, and your own **named Cloudflare tunnel** — plus the option of no
  tunnel at all, with the reconcile poll as the trigger path
  ([docker/daemon/README.md](docker/daemon/README.md)).

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

## Roadmap

Direction, honestly stated (the past tells you how we ship: deliberately,
with the safety rule written first):

1. **The posting boundary moves fully into the daemon** — review assembly
   and anchor validation onto the live path, retiring the session-side
   posting scripts.
2. **Findings telemetry matures into lens tuning** — the per-finding
   reasoning record already lands as queryable rows; next is closing the
   loop from measured kill/raise patterns to evidenced rubric proposals.
3. **The profile ecosystem grows** — more ecosystems beyond Django, and
   community-authored profile packs as the natural contribution surface.
4. **The implementer-feedback loop deepens** — review history clustered by
   author-side root cause, driven into your implementing agents'
   instructions, measured by fewer late blockers and fewer rounds per PR.

**Non-goals** — refusals recorded so they cannot be silently unrefused: no
rebuilding GitHub's PR workflow; the reviewer never executes anything; no
hard round budget; the reviewer never reads the implementing conversation;
the fixer and the reviewer are never the same system. The reasoning for each
is in [MANIFESTO.md](MANIFESTO.md#non-goals).

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

- [MANIFESTO.md](MANIFESTO.md) — why this exists: the argument, the eight design beliefs, the non-goals, the acknowledgements
- [docs/github-app-setup.md](docs/github-app-setup.md) — register the App in minutes
- [docs/llm-setup.md](docs/llm-setup.md) — the two LLM credential routes
- [docker/daemon/README.md](docker/daemon/README.md) — the plain-Docker deploy path
- [docs/profiles.md](docs/profiles.md) — repo profiles: addenda packs + heuristics
- [docs/ownership.md](docs/ownership.md) — the owner-only surfaces (dry-run flag, frozen seeds, ratification)
- [docs/provenance.md](docs/provenance.md) — what the FT-#### citations in this codebase mean
- [CONTRIBUTING.md](CONTRIBUTING.md) — build, test, and the frozen-seed rule
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities

## Acknowledgements

QuickReview names its influences gladly — Matt Pocock's skills (process as
versioned files; this system was *built with* them), pi (small sharp agents;
the review sessions are pi sessions), OpenViking (the memory engine), and
pr-agent (studied honestly; adopted by conviction, declined by conviction).
The full acknowledgements are in [MANIFESTO.md](MANIFESTO.md#acknowledgements).

## License

MIT (see [LICENSE](LICENSE)); third-party attributions in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
