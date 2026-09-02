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

The philosophy — what the human decides, what the machine decides, and the
beliefs this implementation follows — is in [**MANIFESTO.md**](MANIFESTO.md).
It is short.

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
  that dismisses a review. Nominating a human reviewer is possible only
  through the optional, off-by-default escalation feature, and only towards a
  login you configured — see below.
- **Escalation is optional and ships off** (`[escalation]` in
  `config.example.toml`). The reviewer always decides every PR on the merits
  and posts its verdict; escalation, if you turn it on, adds a note *beside*
  that verdict @-mentioning one named person and pointing them at one thing —
  a file and line range, a migration, a named decision. It never asks anyone
  to review the pull request, and it never makes a review wait for a person.
- **Sovereign by construction**: self-hosted daemon, your GitHub App, your
  memory store under your keys, rules as files in your repo. The only thing
  that leaves your infrastructure is the model call, to the provider you
  configured.

Optional extras that degrade cleanly when unconfigured: an operator TUI
(`qcr tui`, board + memory management, over ssh or against local Docker), a
Slack concierge, a local "companion" pi session, and the OpenViking-backed
reviewer memory engine.

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

- **Node ≥ 22**, **Docker**, and the **Compose v2 plugin** (`docker compose`).
  The build and the test suite run offline with no secrets.
- **A GitHub account that can create an App** and install it on the repository
  you want reviewed. No personal access token is used, anywhere — and you do
  not register the App by hand: setup creates it from a manifest in one click.
- **On the server route only**: a Linux machine you already reach as
  `ssh <alias>`, with passwordless sudo there, and `ansible-playbook` installed
  on *your* machine (the deploy runs from here, over your ssh).
- **On Windows**: run everything inside **WSL2**. There is no Windows-native
  path, and the setup wizard says so if it cannot find a POSIX user id.

Everything else — the GitHub App, the webhook ingress, the secrets, the
`config.toml`, the memory keys — is something setup *produces*, not something
you bring. You choose your LLM route during setup; both a ChatGPT subscription
and an OpenAI API key are first-class
([docs/llm-setup.md](docs/llm-setup.md)).

## Quickstart

```sh
git clone <this repo> && cd <repo>
npm ci && npm test && npm run build   # green offline, no secrets needed

scripts/qcr onboard                   # the whole setup, guided
# or, the same thing:  npm run onboard
```

`qcr onboard` is an interactive session: a pi agent talks you through what the
system is while building it, and every act it performs is a named,
deterministic tool whose result you see. It never improvises a shell command,
and it never calls a step done — only the tool's own report does that.

End to end, it:

1. **checks this machine** — Node, Docker, Compose, and your user id (the
   containers run as you, so files stay yours);
2. **asks where the reviewer should live** — a VM or server over ssh, or this
   computer (below), and on the server route proves your ssh alias, agent and
   passwordless sudo *before* anything is built;
3. **asks which LLM route you want**, and makes the whole installation
   consistent with the answer;
4. **interviews you for the handful of values only you can answer** and derives
   the rest, patching `config.toml` in place so every comment survives;
5. **creates your GitHub App in one click** from this repo's pinned manifest —
   the App id, private key and webhook secret come straight back to the wizard
   and land `0600` in your secrets dir, so no credential passes through your
   clipboard — then verifies the install and creates the trigger labels;
6. **wires the webhook tunnel** you picked, or none at all;
7. **mints and places the memory keys**, and proves their confinement;
8. **brings the stack up** (compose here, the real `scripts/deploy.sh` with all
   its preflights on a server) and **verifies it in layers**: containers, the
   health endpoint, then a webhook ping in GitHub's own delivery log;
9. **watches a real review happen.** You label one of your own pull requests,
   and the wizard follows the round and shows you the review it produced —
   read out of the dry-run record, while it is still structurally impossible
   for it to have posted anywhere;
10. **offers the go-live flip, once, and only then** — the new owner's own
    ratification act, taking an explicit confirmation phrase. Declining is a
    complete installation, not a failure;
11. **hands off to the TUI**, where the companion introduces itself and runs a
    first-run interview: a repo tour it confirms with you, your review taste,
    your team's norms — written into memory and distilled into config proposals
    you accept or reject.

It is resumable and re-runnable. The checklist persists, a step claimed done is
always **re-verified against reality** before it is believed, and running the
command again on a finished installation is a diagnostic rather than a repeat.

The full walkthrough — every step, every choice, and what to do when one goes
red — is in [**docs/onboarding.md**](docs/onboarding.md).

### Where the reviewer lives

Both answers are first-class; neither is the advanced one.

- **A VM or server over ssh — the recommendation**, because a reviewer that is
  asleep reviews nothing. You bring any ssh-reachable Linux box; setup rides the
  same Ansible deploy the maintainers use, with every one of its preflights
  ([deploy/ansible/README.md](deploy/ansible/README.md)).
- **This computer** — the whole system in Docker on the machine you are sitting
  at. No server to own, no third-party signup on the default path, and it
  reviews only while that machine is awake
  ([docker/daemon/README.md](docker/daemon/README.md)).

Switching later costs you none of your answers: re-run the topology step, and
the repo, the App, the labels, the keys and your config are all kept.

### Webhook ingress

GitHub needs an HTTPS URL to deliver to. Four shapes, chosen during setup, with
their honest trade-offs stated in full in
[docker/daemon/README.md](docker/daemon/README.md):

| shape | what you get | what it costs |
|---|---|---|
| Cloudflare **quick tunnel** (laptop default) | no account, working in seconds | the hostname rotates on every restart — the daemon re-points the App's webhook URL itself — and there is no SLA |
| **ngrok** | a stable hostname with a reserved domain | an account, and free-tier caps (~20k requests/month, ~1 GB transfer, 1 agent, ~120 req/min) |
| your own **named Cloudflare tunnel** (server default) | a permanent hostname on your domain | a Cloudflare account, a zone, and a connector token |
| **polling only** | nothing exposed at all | up to one poll interval of trigger latency, and author-reply routing plus the `[feedback]` loop go quiet — both are webhook-driven |

Any other HTTPS proxy or tunnel pointed at the webhook port works too; nothing
here assumes a vendor.

### Dry-run, and going live

`dry_run = true` ships as the default: the daemon does everything except
execute GitHub mutations, and writes each would-be call to `state/dryrun/` for
you to inspect. The setup wizard raises the question once, at the end, and only
after you have watched a review land in that record — and accepting takes an
explicit confirmation phrase, never a default or a "yes". Nothing else in the
wizard can move that flag in either direction. It is an owner-only surface
([docs/ownership.md](docs/ownership.md)).

Staying in dry-run is a finished, fully working installation, not a lesser one:
labelled PRs get reviewed, the reviewer learns, the TUI and the companion work,
and every review is a file you can read. Flip whenever you like — by running
that step again, or by editing the one line and restarting the daemon.

### Slack, later

The Slack concierge is deliberately not part of onboarding — skipping it costs
nothing. Set it up whenever you like with `npm run slack:setup`, which creates
the app, collects the tokens, picks the channel and patches your config.

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
the fixer and the reviewer are never the same system. Each follows from a
belief in [MANIFESTO.md](MANIFESTO.md) — the reviewer reads and never runs,
judges what shipped and not how it was made — or, for the workflow and the
round budget, from the rule that GitHub owns the PR and volume is cut at the
bottom, never by giving up.

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
scripts/qcr onboard                             # guided setup; also a diagnostic
scripts/qcr status | today | why <pr> | spend   # CLI over daemon state
scripts/qcr tui                                 # operator board
docker compose logs -f daemon                   # daemon logs (laptop route)
```

The TUI reaches the daemon over ssh or against local Docker, per
`config.toml [tui] target` — setup writes the one that matches your topology.

## Documentation map

- [MANIFESTO.md](MANIFESTO.md) — the philosophy: what the human decides, what the machine decides, and the beliefs the implementation follows
- [docs/onboarding.md](docs/onboarding.md) — the guided setup, step by step: what it asks, what it writes, where it can stop
- [docs/github-app-setup.md](docs/github-app-setup.md) — what the GitHub App is, and how to register it by hand
- [docs/llm-setup.md](docs/llm-setup.md) — the two LLM credential routes
- [docker/daemon/README.md](docker/daemon/README.md) — the plain-Docker route: containers, ingress shapes, image pins
- [deploy/ansible/README.md](deploy/ansible/README.md) — the VM/server route: provisioning, deploy, verification
- [docs/profiles.md](docs/profiles.md) — repo profiles: addenda packs + heuristics
- [docs/ownership.md](docs/ownership.md) — the owner-only surfaces (dry-run flag, frozen seeds, ratification)
- [docs/provenance.md](docs/provenance.md) — what the FT-#### citations in this codebase mean
- [CONTRIBUTING.md](CONTRIBUTING.md) — build, test, and the frozen-seed rule
- [SECURITY.md](SECURITY.md) — reporting vulnerabilities

## Appendix — setting up by hand

`qcr onboard` composes the tools below rather than replacing any of them, so
nothing here is a second implementation, and drift between the guided path and
this one is a bug. Do it yourself if you prefer; the wizard remains useful
afterwards as a verifier, since re-running it re-checks every step against
reality without writing anything that already holds.

```sh
git clone <this repo> && cd <repo>
npm ci && npm test && npm run build

cp config.example.toml config.toml    # ~10 clearly-marked FILL values:
                                      # repo, app slug/bot login, review
                                      # team/label, owner identity, timezone
bash deploy/collect-secrets.sh        # interactive: App id + private key,
                                      # webhook secret, tunnel token, OpenAI
                                      # key (shape-aware — only what your
                                      # deployment needs)

export QCR_UID=$(id -u)
docker compose up -d --build          # laptop route (docker/daemon/README.md)
curl -s http://127.0.0.1:8787/health

# then: point your HTTPS ingress at the webhook port, install the App on your
# repo, create the trigger label, and label a PR — state/dryrun/ fills up.
```

Each piece has its own page:

1. **The GitHub App** — [docs/github-app-setup.md](docs/github-app-setup.md):
   the manifest, the permission and event tables, where each value lands, the
   install, the repo-side labels, and the four verification checks.
2. **LLM credentials** — [docs/llm-setup.md](docs/llm-setup.md): the two routes,
   the provider-prefix rewrite, the container `/login`, and the embeddings key.
3. **Ingress** — [docker/daemon/README.md](docker/daemon/README.md): the four
   shapes, the compose profiles, and the sidecar credentials.
4. **Memory keys** — the server's root key is any 32 random bytes, written to
   `<secrets>/openviking_root_key`; the daemon needs it at boot, and without it
   the memory engine comes up with no per-user confinement. The two *user* keys
   are issued by the running server, and the setup wizard's memory step is the
   only implementation that mints, places and proves them — run
   `scripts/qcr onboard` for that step even if you did everything else by hand.
   `node scripts/companion-memory-forward.mjs verify` is the confinement check
   on its own. Declining memory is supported too: the reviewer then runs
   memory-less, and rounds are unaffected.
5. **A server instead of a laptop** —
   [deploy/ansible/README.md](deploy/ansible/README.md): the inventory, the
   playbook, and `scripts/deploy.sh sync|rebuild|verify`.
6. **Slack** (optional, any time) — `npm run slack:setup`.

`dry_run = true` ships as the default; flipping it is your own act, by hand in
`config.toml` or through the wizard's go-live step, and the daemon re-reads it
on restart.

## Acknowledgements

QuickReview stands on ideas it is glad to name:

- **[Matt Pocock's skills](https://github.com/mattpocock/skills)** — the
  discipline of *processes as versioned files an agent can follow*. This
  system was not just inspired by that idea; it was **built with it** — the
  wayfinding, spec-writing, ticketing and grilling skills in that collection
  drove the development loop that produced this codebase, and the same
  discipline shaped how the reviewer's own rules are carried as files.
- **[pi](https://github.com/earendil-works/pi)** — the small-sharp-agent
  philosophy: an agent session is a terminal you can attach to, extensions
  compose instead of frameworks accreting, and the machinery stays small
  enough to reason about. QuickReview's review sessions are pi sessions.
- **[OpenViking](https://github.com/volcengine/OpenViking)** — the memory
  engine behind the reviewer's learning, run on your own infrastructure with
  server-side per-user confinement.
- **[pr-agent](https://github.com/qodo-ai/pr-agent)** — studied closely in
  [docs/pr-agent-comparison.md](docs/pr-agent-comparison.md); several of its
  ideas were adopted by conviction and several deliberately not imported,
  and knowing which is which made this system better.

## License

MIT (see [LICENSE](LICENSE)); third-party attributions in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
