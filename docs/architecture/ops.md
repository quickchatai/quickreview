# Onboarding, deploy and operations

How an installation comes into existence, how it gets onto a host, and what the
running system exposes to the person and the agent looking after it.

This page is the **architecture** view: which module owns which mechanism, what
the seams are, and which properties an edit must not break. The operator-facing
walkthroughs already exist and are not repeated here — this page links them:

- [../onboarding.md](../onboarding.md) — the guided setup, step by step: what
  each step asks, what it writes, what to do when one goes red.
- [../github-app-setup.md](../github-app-setup.md) — registering the App by
  hand, permission and event tables, where each value lands.
- [../llm-setup.md](../llm-setup.md) — the two model-credential routes.
- [../../docker/README.md](../../docker/README.md) — the compose
  stack: the daemon and memory images, ingress shapes, version pin.
- [../../deploy/ansible/README.md](../../deploy/ansible/README.md) — the
  server route: provisioning, deploy, verification.
- [../memory-embeddings.md](../memory-embeddings.md) — the embedder choice and
  what changing it costs.
- [../ownership.md](../ownership.md) — the owner-only surfaces.

## Where to look

| Mechanism | Files |
|---|---|
| Setup checklist engine, step registry, checklist file, resume | `packages/pi-plugin/src/setupchecklist.ts` |
| The wizard's binding of it (adapters, file path, first-run marker) | `src/onboard/engine.ts` |
| Wizard step registry (order, enablement) | `src/onboard/steps/index.ts` |
| Cross-step handoff keys and value vocabularies | `src/onboard/choices.ts` |
| Wizard tool belt inside pi | `extensions/onboarding.ts`, `prompts/onboarding.md` |
| "Where does the stack run" seam | `src/onboard/steps/transport.ts` |
| Compose helpers shared by the bring-up tail | `src/onboard/steps/compose.ts` |
| GitHub App manifest exchange | `src/onboard/steps/githubapp.ts`, `deploy/github-app-manifest.json` |
| Webhook ingress choice and config | `src/onboard/steps/ingress.ts`, `docker/tunnel/sidecar.mjs` |
| Webhook URL self-heal | `src/webhookheal.ts`, `packages/pi-plugin/src/gate.ts` (`update_own_webhook_url`) |
| Secrets collection (interactive) | `deploy/collect-secrets.sh`, `deploy/collect-slack-secrets.mjs` |
| Laptop topology runtime | `docker-compose.yml`, `docker/README.md` |
| Server topology runtime | `deploy/ansible/playbook.yml`, `deploy/ansible/group_vars/all.yml` |
| Deploy driver and its preflights | `scripts/deploy.sh`, `src/onboard/steps/deploysh.ts` |
| Drain / pause levers | `src/levers.ts`, `src/commands.ts`, `src/tui/deploy-drain.ts` |
| Health endpoint | `src/webhook.ts` (`GET /health`) |
| Heartbeat snapshot | `src/state.ts` (`buildStatusSnapshot`, `writeStatusJson`), `src/daemon.ts` |
| Metrics aggregation | `src/metrics.ts` |
| Token/spend measurement | `src/usage.ts` |
| Operator CLI | `src/cli.ts`, `src/cliops.ts`, `scripts/qcr` |
| Slack concierge | `src/slack/`, `src/wire.ts` (`startSlack`) |
| Publishability lint | `tests/publishability.test.ts`, `tests/helpers/private-tokens.ts` |

## The two topologies

Every installation is one of two shapes, recorded once as the wizard choice
`topology` (`src/onboard/choices.ts`, values `"local" | "vm"`):

- **local** — the daemon and its ingress sidecar run in Docker on the machine
  the operator is sitting at, described by `docker-compose.yml`.
- **vm** — the daemon runs on an ssh-reachable Linux host, provisioned and
  updated by `deploy/ansible/playbook.yml` through `scripts/deploy.sh`.

The difference is confined to **one function**: `stackTransportFor(ctx)` in
`src/onboard/steps/transport.ts`, which returns a `StackTransport` — container
checks, `exec` into the daemon, a health probe, a restart, and the literal
commands the operator would type. Everything the wizard does after bring-up
(memory's second phase, layered verification, the proof round, the go-live
flip) is written once against that interface. The compose implementation
delegates to `src/onboard/steps/compose.ts`; the ssh implementation puts
`ssh <alias> sudo docker …` in front, always with `BatchMode=yes`, and
implements "restart" as a `scripts/deploy.sh release` of the running version — on
that route the config the daemon reads is the one the deploy ships, so
re-running the deploy *is* the restart, with its preflights intact.

The operator TUI makes the same split separately, through `config.toml
[tui] target` and `runnerFor(cfg.tui)` in `src/tui/remote.ts`.

## The onboarding wizard

### Shape

Its door, `qcr onboard`, is gone: a bare `qcr` opens the home, whose first
run is the setup checklist (`src/home/setup.ts`, the plugin's step registry
with the home's steps on it). The wizard's own pi session went with its
door: the home runs the wizard's steps in its own process, switch-on's on the
setup checklist and the rest behind Advanced (`src/home/advanced.ts`).

The wizard's tool belt stays for a pi that loads it by path: exactly one
extension (`extensions/onboarding.ts`) whose `--tools` allowlist names
`read,ls,grep` and then every wizard tool, derived from the step registry
(`src/onboard/toolnames.ts`); bash, write and edit are never on it.

`extensions/onboarding.ts` registers **one tool per engine step**, named
`onboard_<step id>`, plus `onboard_status` (reconcile + listing) and
`finish_and_exit`. The model talks; the tools act. Nothing in the belt runs a
free-form shell command.

On exit, `runOnboard` reads the checklist: complete ⇒ it execs `qcr tui`;
otherwise it prints how to resume.

### The engine and its resumability contract

`OnboardingEngine` (`src/onboard/engine.ts`) is the plugin's setup checklist
(`SetupChecklist` in `packages/pi-plugin/src/setupchecklist.ts`, the step registry
ADR 0001 makes a public seam) bound to the wizard: a checklist state machine
over `OnboardingStep`s behind injected adapters (`OnboardAdapters`: `fetch`, a
`ProcessRunner` that never throws, a clock, an optional prompter, host facts,
the state dir, a log). Nothing in a step touches the network, Docker or pi
except through those adapters, which is why the whole flow is drivable from
tests.

State persists to `state/onboarding/checklist.json` after **every** step, via
tmp+rename. Four properties define the contract, and they are the reason the
wizard doubles as a diagnostic:

1. A step claimed done in the file is **re-verified against reality** on resume
   (`reconcile()`), and demoted to pending with the failures in its `note` if
   `verify()` no longer holds. The file's claim is never trusted alone.
2. `verifyAll()` runs every enabled step's `verify()` — a *pending* step whose
   verify holds is promoted, because reality is the only truth the checklist
   mirrors.
3. A corrupt or unreadable checklist degrades to a fresh one rather than
   crashing; the resume re-verifies everything anyway.
4. `finish()` re-runs the full verification and refuses while anything is red.
   All green ⇒ it stamps `completed_at` and writes the first-run marker
   `state/companion/first-run.json` (`firstRunMarkerPath`) exactly once — the
   file the companion's first-run greeting keys off. An existing marker is left
   untouched, so that timestamp never moves.

Unknown or disabled step ids come back as refusals-as-answers, never throws:
the caller is a model's tool belt.

A step may also declare `detect()`: already true ⇒ `detect()` on the
checklist marks it done with what was found, without running it. The
wizard's steps declare none, and the wizard never calls it; the plugin's
`/qcr-setup` (`packages/pi-plugin/src/plugin/setup.ts`) is a checklist of
detecting steps kept in memory.

### The steps

Registered in `defaultSteps()` (`src/onboard/steps/index.ts`), executed in
`order`. `enabled(choices)` gates the route-specific ones.

| Order | Id | File | What it establishes / verifies |
|---|---|---|---|
| 10 | `preflight` | `preflight.ts` | Node ≥ 26 (older noted, not refused), Docker and Compose present, the release image noted as pullable (it is public; an unreachable tag comes with its likely cause, and a private mirror with its login), the operator's uid captured (later written as `QCR_UID`, the containers' user, so they can read the secrets the operator owns) |
| 20 | `topology` | `topology.ts` | Where the reviewer lives. Both answers first-class; switching later demands an explicit confirmation phrase and tears nothing down behind the operator |
| 22 | `ssh_preflight` | `ssh.ts` | *(vm only, and first on that route)* the alias resolves, an agent holds the key, `ansible-playbook` is on this machine, remote sudo is passwordless — all under `BatchMode=yes` |
| 30 | `llm_auth` | `llmauth.ts` | The model-credential route, and the whole installation made consistent with it (including rewriting model prefixes for the API-key route). No credential value ever reaches an argv or a tool result |
| 35 | `config_fill` | `configfill.ts` | The interview → a comment-preserving patch of `config.toml`. `QUESTIONS` is what a human must answer; `DERIVABLES` is the closed set the step computes instead of asking |
| 36 | `escalation` | `escalation.ts` | The optional escalation feature: targets and triggers, or left off. Enforces the same completeness rules `parseEscalation` enforces at load |
| 38 | `embeddings` | `embeddings.ts` | Which embedder memory uses; local is the default and needs no key. Refuses a config that disagrees with what the boot will render |
| 39 | `ingress` | `ingress.ts` | The webhook shape, the `[ingress]` config it needs, and the `COMPOSE_PROFILES` line — then verifies the **running** shape, not the recorded one |
| 40 | `github_app` | `githubapp.ts` | App created from the manifest, credentials landed, install verified against the App's own installation listing, trigger labels created idempotently |
| 60 | `memory` | `memory.ts` | Memory phase A: the server's root key on disk before the daemon boots, and where each of the three keys may live |
| 65 | `app_slug_reconcile` | `appslug.ts` | Asks `GET /app` with the App JWT and reconciles the real slug into `[github] app_slug` / `bot_login`; the live answer wins over file and checklist |
| 68 | `vm_inventory` | `inventory.ts` | *(vm only)* writes `deploy/ansible/inventory.ini` — the file the manual route already reads — carrying route answers as **host vars**, so no tracked file is dirtied |
| 70 | `bringup` | `bringup.ts` | *(local)* `docker compose pull` then `up -d` on the released images with the profile explicit, the long first pull streamed line by line, noted *before* the wait; with no Docker where the wizard runs (inside the image) it prints the host's commands instead |
| 71 | `vm_deploy` | `vmdeploy.ts` | *(vm)* composes `scripts/deploy.sh` — plan first, always — with every refusal landing unchanged |
| 72 | `memory_user_keys` | `memorykeys.ts` | Memory phase B: drives the *same* memory step again now the server answers, minting and placing the two user keys and proving confinement |
| 74 | `verify_stack` | `verifyup.ts` | Three layers in order: container state, `GET /health`, then a webhook ping read from the App's own delivery log (a failed ping is redelivered once) |
| 76 | `proof_round` | `proof.ts` | Follows a real labelled PR of the operator's through the state store and shows the review read out of `state/dryrun/` — before it could possibly have posted |
| 78 | `go_live` | `golive.ts` | The one place `dry_run` may be written, offered once |

Steps interlock, so the order is load-bearing: `config_fill` records the
reviewed repo the App step needs, and `app_slug` corrects what `config_fill`
had to ask for before the App existed.

### The choice vocabulary

`src/onboard/choices.ts` declares every key one step hands another, plus the
value vocabularies (`Topology`, `IngressChoice`, `AuthRoute`, `MemoryChoice`).
Two rules, enforced by `tests/onboard-choices.test.ts`:

- no step carries its own string literal for a shared key — every read and
  write names `CHOICE_KEYS.x`, so a typo is a compile error;
- `CHOICE_WRITERS` names the step that records each key, and the test proves it
  really does — a key that is only ever *read* cannot survive.

A key private to one step stays a local constant in that step. This file is
about the handoffs, and it exists because per-step suites all stayed green
while the composed flow was broken by a reader and a writer disagreeing on a
key name and a value spelling at once.

### What the wizard structurally cannot do

- **Move `dry_run` as a side effect.** Every config-writing step routes its
  edits through `assertNoDryRunEdit` (`configfill.ts`), which refuses an edit
  naming the flag however it is spelled. `flipDryRunToFalse` in `golive.ts` is
  the only function that writes it, and it throws unless handed both the exact
  confirmation phrase (`GO_LIVE_CONFIRMATION`) and a completed proof record,
  re-verified against the daemon's own state store at flip time. With no
  decision in the tool call the step offers and changes nothing; **declining is
  green**, because a dry-run installation is a complete one.
- **Soften a deploy check.** `src/onboard/steps/deploysh.ts` builds the argv for
  `scripts/deploy.sh` and does nothing else: no skip flag (none exists), and no
  environment override, so the wizard cannot point the script at a different
  inventory, config or sandbox than a manual run would use.
- **Mutate the reviewed repo.** The App step creates *label definitions* and the
  verification step can *redeliver the App's own webhook ping*; neither is a
  `MutationKind`, and no wizard path posts a review, applies a label to a PR, or
  pushes a branch.

## Secrets layout

One directory, `0700`, files `0600`, found by the install locator
(`src/install.ts`): a set `[github] secrets_dir`, else
`<config home>/secrets` (`~/.config/qcr/<install>/secrets`). The old
`~/.config/quickreview-bot` is never read: `qcr install where` lists it
as stranded while it holds anything, and `qcr install migrate` moves it (and
repoints a compose `.env` `QCR_SECRETS_DIR` that still names it — recreate the
stack afterwards).
Overridable with `QCR_SECRETS_DIR` (compose) / `QC_SECRETS_DIR` (the wizards);
mounted read-only into the daemon container at `/opt/quickreview/secrets`. The
companion's `openviking-keys.env` is kept out of it, in
`~/.config/qcr-operator/<install>/` — the one credential no container mounts.

| File | Purpose | Required |
|---|---|---|
| `app_id` | numeric GitHub App id | yes |
| `app.pem` | App private key | yes |
| `webhook_secret` | HMAC secret for `POST /webhook` | yes |
| `tunnel_token` | connector token for a named Cloudflare tunnel | only under that ingress shape |
| `ngrok_authtoken` | ngrok client credential (read by the sidecar wrapper) | only under that shape |
| `openai_api_key` | pi's model credential on the API-key route | optional |
| `openai_embeddings_api_key` | the hosted-embeddings opt-in's own key | optional, and never pi's key |
| `openviking_root_key` | the memory server's own credential | for confined memory |
| `openviking_reviewer_key` | the one user key the daemon and review sessions hold | for confined memory |
| `deploy_shape` | `tunnel` or `docker`, remembered by the wizard | written by the wizard |

Two collection paths write the same names with the same validation and mode:
`deploy/collect-secrets.sh` (interactive, hidden input, never echoes a value)
and the wizard's App step, which receives `app_id` / `app.pem` /
`webhook_secret` directly from the manifest exchange so no credential passes
through a clipboard. The **companion's** memory user key deliberately does not
live here: the whole secrets dir is mounted into the container review sessions
run in, so `memory.ts` relocates the operator key file out of it rather than
writing a key somewhere sessions could read.

## The GitHub App manifest flow

`src/onboard/steps/githubapp.ts`, from `deploy/github-app-manifest.json`:

1. Serve a localhost page whose form POSTs the manifest to GitHub's
   app-creation page (personal or organization target), carrying a `state`
   token and a `redirect_url` pointing at this process's loopback listener.
2. Receive the one-time `code` and exchange it at the unauthenticated
   conversion endpoint. The `201` carries id, slug, pem and webhook secret —
   the only moment GitHub reveals that secret — and the three land straight in
   the secrets dir.
3. Guided install click, then **verify** through the App's own installation
   listing (App-JWT authed), bounded polling with progress lines.
4. Create the trigger / in-progress / reviewed labels through the installation
   token, idempotently.

The slug GitHub actually assigns can differ from the one the interview asked
for (uniqueness suffixing, or a later rename), which is why order 65 exists:
`bot_login` is how the daemon recognises its own reviews and comments, and
nothing else in the system checks it.

## Webhook ingress and the self-heal

Four shapes, chosen at order 39 (`src/onboard/steps/ingress.ts`), three of them
a compose profile in `docker-compose.yml` running the same wrapper
(`docker/tunnel/sidecar.mjs`) around a vendor binary; no profile means no
sidecar, which is the polling-only shape.

| Shape | Hostname | `[ingress] shape` |
|---|---|---|
| `quick` (cloudflared quick tunnel) | rotates on every restart | `tunnel-file` |
| `ngrok` | stable with a reserved domain | `tunnel-file` |
| `named` (own Cloudflare tunnel) | permanent, on the operator's domain | `none` |
| `polling` | none — the reconcile poll is the only trigger path | `none` |

No sidecar publishes a port: the tunnel dials out and reaches the daemon over
the compose network. The daemon publishes exactly one port, on loopback by
default; the memory engine's port is never published.

Under `tunnel-file`, the sidecar writes the bare public hostname into a file on
a small shared volume and `WebhookHealer` (`src/webhookheal.ts`) re-points the
App's **own** webhook URL to match. Its shape mirrors the verdict watcher:
`fs.watch` is the fast path, a periodic sweep (`[ingress] sweep_interval_s`) is
the reliable one, with a debounce (`debounce_ms`) because quick tunnels
sometimes rewrite the file within a second. Outcomes are explicit — `noop`,
`healed`, `missing`, `invalid`, `failed` — and every failure surfaces as a log
event plus an anomaly, never a crash and never silence.

The mutation itself is `update_own_webhook_url` in `packages/pi-plugin/src/gate.ts` — a JWT-authed
`PATCH /app/hook/config`. It is the sole member of `APP_SELF_CONFIG_KINDS`, the
one class the gate executes even in dry-run, because a new installation runs
dry-run during exactly the window the self-heal matters, and because the call
can only reach the App's own configuration. That class is a closed set pinned
by deep equality in `tests/gate.test.ts`; adding a second kind fails a test.
Rotation costs latency at worst either way: the reconcile poll is the
correctness backbone, and a webhook that never arrives never loses a PR.

## The plain Docker path

`docker-compose.yml` runs the released images (the release image and the
memory image); `docker/README.md` is the guide. Salient points an editor
should know:

- `init: true`, because a supervised memory-engine process runs beside the
  daemon and PID 1 must reap.
- The ingress volume is nested inside the state mount so a sidecar sees the
  hostname file and nothing else — no SQLite, no memory, no dry-run record.
- pi's home is its own named volume: OAuth tokens and session JSONLs must
  survive a rebuild.
- Image pins (pi, tmux in `docker/Dockerfile`; the memory server,
  `llama-cpp-python` and the model file in `docker/memory/Dockerfile`) are the
  Dockerfiles' `ARG` defaults, mirrored against `config.toml` and
  `deploy/ansible/group_vars/all.yml` and checked by
  `tests/release-image.test.ts` and `tests/memory-image.test.ts`.

## The Ansible path

`deploy/ansible/playbook.yml`, driven from the operator's machine over their
own ssh. It is **provision only**: it never pulls, builds or starts an image. Three plays:
host preflight (refuse to trample an existing service — webhook port already
bound by something else, a foreign cloudflared, not enough free disk), host
setup (packages, Docker, optionally cloudflared as a systemd service, gated on
`cloudflared_enabled`), then the provision play (directory layout under the
container uid, secrets into place, the thin updater `/usr/local/sbin/qcr-update`
and its run spec `/etc/qcr/update.conf`). The containers are the updater's
(`deploy/qcr-update.sh`); see `deploy/ansible/README.md`.

`inventory.ini` is gitignored and operator-local; `inventory.example.ini` is the
tracked template. The wizard writes route answers as **host vars on the host
line** rather than editing `group_vars/all.yml`: inventory host vars outrank
playbook group vars, so the operator's answer wins without dirtying a tracked
file — which matters because a dirty tree is exactly what `scripts/deploy.sh`
refuses to deploy.

## `scripts/deploy.sh`

Three modes. `provision` runs the playbook (packages, secrets, directories, the
updater and its run spec; no image). `release <version>` reads CI's deploy
manifest and runs `tar | ssh vm sudo qcr-update <version>@<digest> ...`: the
VM pulls the images CI built, by digest; nothing is rsynced, built or
installed. `verify` runs the post-deploy checks only. `sync`, `dev` and
`rebuild` are gone and refuse with a pointer to `release`. `--dry-run` prints the
plan and stops.

**Preflights, all fatal, all before anything runs:**

- config, ansible dir, group vars and playbook all present;
- **clean tracked working tree** — what runs on the host must be a commit you
  can point at, and the refusal prints the dirty paths;
- **pin coherence**, refusing both drift and the `PIN-ME` placeholder:
  `config.toml [pi] version` against `group_vars pi_version`; the memory
  server's version and `llama_cpp_python_version` the same way; the vendored pi
  extension's base commit against its `upstream.json`; the memory auth mode,
  key-file names and provisioned user list; the embedder provider, model,
  dimension and key file against the **effective** ansible value (host var,
  else group var), because that is what the boot will render and an embedder
  disagreement is a vector-store reset rather than a version bump; and the
  local English embedder's model-file pin (file, URL, sha256) with its port
  and threads;
- the live config found through the install locator — a config that lives
  only in the checkout, or a `[review] profile` (or any base it extends) found
  neither in the config home nor among the checkout's generic examples, is
  refused;
- for a release, the manifest's pins (the images' labels) held to `config.toml` and
  `group_vars`, and the VM's run-spec fingerprint held to the one `group_vars`
  renders ("re-run provision");
- `ansible-playbook` on this machine and an inventory to run against.

**Then the plan is printed, and the drain advisory runs** (below). Execution
builds `dist/` locally (`npm run build`, then `node scripts/verify-dist.mjs` —
refusing to ship a tree whose build is incomplete), writes the `BUILD_SHA`
marker (`<short sha> <iso-utc> <mode>`, gitignored, read by the TUI's deploy tab
to answer "what commit runs here?"), runs the playbook, and finishes with
post-deploy checks over ssh plus a refresh of the host-side memory forward when
that unit is the one running it.

The script performs no remote operation beyond ansible and ssh, and it never
bumps a pin for you.

## The drain valve

Draining stops review work so a container can be recreated without orphaning a
round in flight.

- **Engaging it.** `qcr drain on|off` (`src/cli.ts` `cmdDrain`), the TUI deploy
  tab (`src/tui/deploy-drain.ts`), or `--local` inside the container. All three
  write **one validated command file** — `{"command":"drain","on":true}` — into
  `commands/operator/` and read back the result the daemon writes to
  `commands/results/`. Nothing here touches GitHub or the mutation gate.
- **Effect.** While draining, `src/webhook.ts` answers deliveries `200` and
  **drops** them (counted, so the lift line can say how many the poll must make
  up); `GET /health` is untouched, and the dispatch pump starts no new rounds.
  Terminal failure obligations stay visible but do not count as live rounds.
- **Lifting it.** The operator's drain has no expiry, and the boot's **first**
  reconcile pass lifts it — only that pass, and only when it completed with no
  errors (`src/daemon.ts`), so a broken deploy never resumes work blind.
  `qcr drain off` lifts it immediately. Two drains the boot never lifts: a
  system's (`draining_reason`, the worker crash-loop breaker) and the
  operator's **hold** — `qcr drain on --hold` (`{"command":"drain","on":true,
  "hold":true}`), the cutover's — which only an explicit `qcr drain off` lifts;
  the boot logs `drain_hold_kept` instead. A hold is refused to any issuer but
  the sealed operator channel, and never carries an expiry. The boot that adds
  the `hold` column to state.db carries a standing operator drain over as one
  (`drain_hold_carried`): that is how the legacy daemon's cutover drain holds.
- **Who is asking is decided by channel, never by a field.** `commands/` is the
  session directory; `commands/operator/` is root-owned and unwritable by the
  uid the daemon and every session run as. `operatorSealVerdict`
  (`src/commands.ts`) checks that seal on the directory *and* the file; an
  unsealed file is served as a session's command and logged
  (`operator_channel_unsealed`). `src/levers.ts` then applies the bound: an
  operator grant may be until-lifted, a **session** grant always carries an
  expiry and always draws on a per-day minute budget (`[levers]`, defaults 30
  min per drain / 90 per day; 240 min per PR pause / 480 per PR per day). The
  grant type has no member that spells a session hold without an expiry, a
  session can neither lift nor narrow an operator's hold, and an operator's
  grant upgrades a session's.
- **In the deploy.** `drain_advisory` in `scripts/deploy.sh` reads the heartbeat
  and **warns** — never refuses — when rounds are still running, and says so
  again if the drain is on but the board is not yet quiet.

## Health, heartbeat, metrics, spend

**Health.** `GET /health` on the webhook server (`src/webhook.ts`) is the
liveness probe: `{ok: true}`, plus a `pipeline` block when the daemon supplies
one — process liveness and review-pipeline health are deliberately separate
answers, so one can never impersonate the other.

**Heartbeat.** Every 30 s (`STATUS_TICK_S` in `src/daemon.ts`) and at each
significant transition, `buildStatusSnapshot` + `writeStatusJson`
(`src/state.ts`) write `state/status.json` atomically. `StatusSnapshot` is the
one published operational surface: mode, tracked PRs with their current round
and any pause, running rounds, spend, digest headline, drain state and holder,
memory-engine health, provider/auth health, the round-stage supervisor, the
pipeline block, and `heartbeat`. Optional fields are genuinely optional — a
snapshot from an older daemon simply lacks them, and every reader must default
rather than invent a value.

**Metrics.** `src/metrics.ts` is pure aggregation over the daemon's SQLite: no
GitHub calls, no mutations, no gate. `computeMetrics` renders three windows (7
day, 30 day, all) of the same `MetricsWindow` — time-to-first-verdict, time in
state, verdict mix, spend by round type and lens, rounds until resolution,
round duration and overruns, author response, review depth, PR size buckets,
ping-pong exchanges, event kinds, and cancellations grouped by cause.
`computeTimeline` is the per-PR view. `qcr metrics [--pr N] [--json]` and the
TUI's metrics tab render exactly these payloads. Day bucketing goes through the
`Intl` helpers in `src/eod.ts` — never a manual offset. Rounds imported from
GitHub history carry timestamps and verdicts but no spend or duration, so they
count in the mix and not in the money; every `n` is real data points.
`readOps` reads `status.json` and the `BUILD_SHA` marker for the ops line, and
returns nulls when either is missing.

**Spend.** `src/usage.ts` measures a round from the pi session JSONLs rather
than trusting a verdict file's self-reported figure (models copy the template's
example number). It sums per-model input/output tokens from assistant messages
inside the round window, attributes them via `model_change` records, and prices
them with `estimateUsd`. Subagent transcripts land in pi's global store with no
marker we control, so they are matched by file mtime inside the round window —
best-effort, and surfaced as `passes_included` rather than silently folded in.
Everything is pure logic over injectable reads: a malformed line or unreadable
file is skipped, never thrown. `qcr spend` and `qcr today` report it.

## The Slack concierge

Optional, off unless `[slack] enabled = true`, and assembled in exactly one
place: `startSlack` in `src/wire.ts`, which returns before touching a token
when Slack is off. A missing token or a half-filled `[slack]` block fails loud
at boot (`validateSlackConfig`).

- `src/slack/types.ts` is the transport seam; `socket.ts` is Socket Mode over
  Node's global `WebSocket` (the only inbound transport — there is no HTTP
  events endpoint), and `api.ts` is the Web API poster with one serialized post
  queue and a minimum interval. Slack failures never throw into callers: a post
  is retried twice, then logged and dropped. A new message
  (`chat.postMessage`) whose attempt may have reached Slack — the connection
  failed after sending, or the answer was unreadable — is not retried, so it
  can never post twice.
- `router.ts` turns one inbound message into at most one overseer turn, with a
  fixed check order (channel, echo, subtype, dedupe, staleness, turn cap) and
  **a row per drop** in `slack_events`, so "why did the bot ignore me?" is
  answerable from SQLite alone. It never takes a channel id or a tier from
  message text.
- `origin.ts` is the sole authority on what a Slack-driven turn may do: the
  router writes the rights to disk next to the inject file, and the command
  path reads them from there — never from anything the model repeats back.
- `announce.ts` decides *whether, where and exactly once*; `messages.ts` owns
  the wording as pure functions, so no model can reword an announcement. Every
  interpolated user string is escaped, and a `<@U…>` mention is only emitted
  for an id the daemon itself resolved.
- `policy.ts` holds the caps and cooldowns, enforced in daemon code over the
  SQLite ledgers — never by prompt.
- `reply.ts` is the overseer's only way to speak: the session holds no token and
  names no channel, so a wrong channel is unrepresentable.

Setup is separate from onboarding and can be run at any time:
`npm run slack:setup` (`deploy/collect-slack-secrets.mjs`).

## The `qcr` CLI

`scripts/qcr` is a thin wrapper that builds `dist/` if it is missing and execs
`dist/src/cli.js`. `src/cli.ts` is read-only against `state/` (`status.json` +
`state.db`) except for the command-file writes noted above; heavier commands
live in `src/cliops.ts` and are dynamically imported so the common path stays
cheap.

| Command | What it does |
|---|---|
| `onboard` | the guided setup, and a diagnostic on a finished install |
| `status` | render `status.json` — mode, PRs, rounds, spend, reviewer-memory health, drain and holds |
| `spend`, `today` | spend totals and the current ops day |
| `why <pr> [--json]` | the decision trail for one PR from the state store and its archive |
| `metrics [--pr <n>] [--json]` | `src/metrics.ts` payloads, rendered or raw |
| `events [--tail <k>] [--json]` | the recent event log |
| `drain <on\|off> [--local]` | the deploy valve (see above) |
| `tui [pr]` | the operator board (`src/tui/`) |
| `companion <up\|down\|status\|rebuild>` | the local companion container lifecycle |
| `memory reembed [--user <name>…]` | re-embed a memory namespace after an embedder change |
| `memory relayout [--plan\|--apply] [--user <name>]` | sort a namespace into the memory layout — print the plan, or carry it out (operator-run, idempotent, never a delete) |
| `install <where\|migrate>` | show where the install's config, state and secrets live (and anything stranded in old locations), or move the old locations' files into the install's homes |
| `setup [validate [<profile>] \| commit]` | ask the companion to run setup; validate a repo profile; commit the profile changes setup asked for |
| `history <digest\|pull>` | read the repo's review history through the App (read-only), or pull it into the state home for setup |
| `outcomes [--days <n>] [--capture]` | the per-lens fate table of posted findings |
| `lessons …` | mine lesson candidates, the shadow report, and the operator's lesson kill switch |
| `archive <status\|run\|restore\|extract>` | the closed-PR archiver: status and plan, one tick, restore a PR, extract a PR's archive to a directory |
| `backfill [--dry-run] [--limit <n>]` | import review history into the state store (read-only against GitHub) |
| `checklist` | the cutover checklist harness (`src/checklist.ts`) |
| `compare <pr…>` | dry-run review comparison (`src/compare.ts`) |
| `regression …` | run the regression set (`src/regression.ts`) |
| `live [RUN_ID\|DIR] [--lens ID] [--round N] [--follow]` | read a review's LiveEvent log as a transcript (on the bot's box: a round directory `state/live/pr-<n>/r<k>`) |
| `open pr <n> [--round R] [--lens ID]` | open the bot's session for a PR in pi on this machine, forked (read from the box first) |
| `takeover\|debug-round\|release <n>` | the operator's leases: work in the PR's real session, or run its next round in interactive pi; each prints how to reach its `takeover-pr-<n>` / `debug-pr-<n>` pi |

There is no `attach` verb: the bot's rounds run in workers, with no `pr-<n>`
tmux session to attach to.

An unrecognised command prints the usage line **and** loads the config, so a
broken `config.toml` surfaces even on a typo.

## Publishability

The repository is public in full; `tests/publishability.test.ts` keeps private
tokens out of every tracked file. It reads them from a denylist kept outside
the repository (`tests/helpers/private-tokens.ts` says where and in what
format), so the tree names none of them; without that file the private-token
checks skip and say why, while the credential-shape checks always run. Its
one exemption channel is an in-file `ALLOWLIST` whose every entry names the
file, the kind of token and the reason. A negative control plants a canary and
proves the scanner bites. Prefer role words ("the owner", "the operator", "the
reviewed repo") to any concrete identity in a new doc.

## Invariants to preserve

If you are editing anything on this page, these are the properties that must
survive the edit:

1. **One mutation gate.** Every GitHub write goes through `packages/pi-plugin/src/gate.ts`.
   `APP_SELF_CONFIG_KINDS` stays a closed set of one, pinned by deep equality.
2. **`dry_run` is not a wizard output.** Only `flipDryRunToFalse` writes it, and
   only with the confirmation phrase and a re-verified proof record.
3. **The guided path is the manual path.** `deploysh.ts` must stay unable to
   pass a softening flag or an environment override, and the wizard composes
   `scripts/deploy.sh` rather than reimplementing any of it.
4. **A claimed step is re-verified, never believed.** `verify()` must stay safe
   to call any number of times and must read reality, not the checklist.
5. **One transport decision.** New bring-up-tail behaviour asks
   `stackTransportFor`; it never grows a per-topology copy.
6. **Issuer comes from the channel.** Never add a field to a command file that
   names who sent it.
7. **A missing value is unknown, not a default.** Snapshot readers default to
   "unknown" rather than to a plausible number, and no published field is
   inferred from data the writer did not have.
8. **The publishability lint is a gate, not a report.** Adding an allowlist
   entry requires naming the file, the kind of token and the reason.
