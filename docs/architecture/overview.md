# Architecture overview

The system map: what runs, where it runs, and how a labelled pull request
becomes a posted review. Every mechanism below names the file that implements
it, so you can check the claim against the code.

For *why* the system is shaped this way, read
[MANIFESTO.md](../../MANIFESTO.md); for what it does from a user's seat, the
[root README](../../README.md). This page is the engineering map.

## The one-sentence shape

A deterministic TypeScript daemon owns the schedule, the state and every write
to GitHub; long-lived LLM sessions do the reading and judging, and hand their
conclusions back as files the daemon validates.

No model call sits on the daemon's decision path. Everything the daemon
decides — which PR is next, which lens passes run, whether a review may post,
whether an approval is allowed — is plain code with unit tests. The model's
output enters the system only as (a) a verdict file and (b) GitHub writes made
by the session through gated shell scripts.

## Processes in the container

One container runs the daemon and its sessions; on the compose route the memory
engine is a second container beside it (`docker-compose.yml`,
[docker/daemon/README.md](../../docker/daemon/README.md)):

| process | started by | what it is |
|---|---|---|
| tini (PID 1) | `init: true` in `docker-compose.yml` | reaps orphans and forwards signals; required because the daemon supervises a second long-lived process |
| the daemon | `docker/entrypoint.sh` daemon mode (the VM route: `docker/daemon/entrypoint.sh`) → `node dist/src/wire.js` | the whole deterministic core (`src/wire.ts` assembles it, `src/daemon.ts` is its stub-wired core) |
| the OpenViking memory server | on the compose route the `memory` service (`docker/memory/`, `[openviking] endpoint = "remote"`); on the VM route a supervised child of the daemon, `src/openviking/supervisor.ts` | reviewer memory, HTTP on `:1933`; the port is deliberately not published anywhere |
| a tmux server | `docker/entrypoint.sh` daemon mode | holds the LLM sessions; also the jump-in surface for `qcr attach` |
| one **pi** session per triggered PR, plus one `overseer` | `src/sessions.ts` (via `src/tmux.ts`) | the review conversations; see [sessions.md](sessions.md) |

The daemon publishes exactly one port, `8787`, on loopback by default: `POST
/webhook` and `GET /health` (`src/webhook.ts`). Your HTTPS ingress goes in
front of that; the four supported ingress shapes are in
[docker/daemon/README.md](../../docker/daemon/README.md).

## Operator surfaces

| surface | entry point | what it is |
|---|---|---|
| `qcr` CLI | `scripts/qcr` → `src/cli.ts` | read-only over `state/` — `status`, `today`, `why <pr>`, `spend`, `metrics`, `events`, plus `attach`, `drain`, `onboard`, `companion`, `memory reembed`, `memory relayout` |
| the TUI | `qcr tui` → `src/tui/` | the operator board, memory management, deploy and metrics tabs; reaches a remote daemon over ssh or a local one over Docker per `config.toml [tui] target`. See [tui.md](tui.md) and [../tui.md](../tui.md) |
| the companion | `src/tui/companion.ts`, `docker/companion/` | a local pi session beside the TUI, for asking questions about the running system; it reaches the daemon only by injecting into the overseer |
| Slack concierge | `src/slack/` | optional; a Socket Mode client (`src/slack/socket.ts`) with a router, reply path and policy layer over one public channel |
| onboarding wizard | `scripts/qcr onboard` → `src/onboard/` | the guided install; see [../onboarding.md](../onboarding.md) |

The CLI and the TUI read state; they do not review. The only two operator
writes the TUI performs are a message injected into a session (`src/tui/msg.ts`)
and a validated command file (`src/tui/unwedge.ts`), which the daemon
re-validates against its own whitelist in `src/commands.ts`.

## Data flow: from a trigger to a posted review

```
GitHub App webhook ──┐
  (HMAC + dedupe)    │
                     ├─→ state machine ──→ dispatch pump ──→ RoundOrder
reconcile poll ──────┤     src/state-        src/dispatch.ts      │
  (authoritative)    │     machine.ts                             │
                     │                                            ▼
verdict watcher ─────┘                            wake file → inject/<session>/
  src/verdicts.ts                                  ↓
                                          the PR's pi session (tmux)
                                                   ↓ fans out lens passes
                                                   ↓ validator pass
                                          posts via scripts/post-review.sh
                                                   ↓
                                          verdict/pr-<n>-round-<k>.json
                                                   ↓
                                          src/verdicts.ts → labels, round
                                          record, state transition
```

Step by step:

1. **Trigger.** Two independent paths converge on the same state machine. The
   webhook (`src/webhook.ts`) verifies `X-Hub-Signature-256` in constant time
   over the raw body, dedupes on `X-GitHub-Delivery`, answers within GitHub's
   10-second budget, and interprets asynchronously. The reconcile poll
   (`src/reconcile.ts`, every `[daemon] poll_interval_s`, default 300s, and at
   startup) rebuilds the truth from the API and forces local state to match —
   GitHub always wins, and every correction is logged. GitHub never redelivers
   a failed webhook, which is why the poll, not the webhook, is the
   correctness backbone.
2. **Lifecycle.** `src/statemachine.ts` folds each event into one of five
   states: `tracked`, `queued`, `reviewing`, `awaiting_author`, `closed`. The
   full transition table is in that file's header. There is no state in which
   a PR waits for a human to review it.
3. **Dispatch.** `src/dispatch.ts` is the deterministic scheduler: FIFO by
   trigger time, at most `[daemon] max_concurrent_rounds` in flight. Before
   building the order it prepares the PR's worktree at the resolved head sha
   (`src/worktrees.ts`), so the prompt cites the sha the passes actually read;
   it selects lens passes from the diff (`src/heuristics.ts`, extended by the
   repo profile), raises the validator to the round's highest lens tier, and
   runs the ecosystem pre-check (`src/migrations.ts` for Django) whose remedy
   posts as a comment, never a blocker.
4. **Wake.** The order is written as a Markdown file into `inject/<session>/`.
   The `extensions/inject-bridge.ts` pi extension watches that directory and
   hands the oldest pending file to the session. Delivery is a **receipt**, not
   an inference: the order carries a marker the session echoes only if it
   accepted the message, so a lost prompt is detected and redelivered rather
   than guessed at. A wake that arrives mid-round is held and flushed at round
   end (`src/wakes.ts`).
5. **Fan-out and validation.** The PR's session launches the planned passes as
   blank-slate leaves through the subagents extension; each pass is built from
   a frozen seed plus composed addenda (`src/include.ts`). An adversarial
   validator pass re-derives every candidate finding before anything posts.
   Severity, reachability and the tag vocabulary are decided by code:
   `src/severity.ts`.
6. **Posting.** The session posts through `scripts/post-review.sh`,
   `scripts/approve-pr.sh` and `scripts/reply-thread.sh`, all of which source
   `scripts/guards.sh` — the shell mirror of the daemon's posting-time guards
   (`src/guards.ts`) and CI gate (`src/cigate.ts`). Credentials come only from
   `scripts/mint-token.sh` (App JWT → installation token).
7. **Verdict.** The session writes `verdict/pr-<n>-round-<k>.json` (staged,
   then published by one rename through `scripts/commit-verdict.sh`).
   `src/verdicts.ts` consumes it and owns everything that follows: labels, the
   round record, the state transition, and the optional escalation note. A
   malformed or overdue verdict becomes an anomaly — never an approval —
   unless the round's review is already confirmed on GitHub, in which case the
   round is settled from its posting receipt and never re-run.
8. **Recheck and ping-pong.** Pushes, CI completions, base advances and author
   replies wake the same session rather than starting a new one
   (`src/recheck.ts`, `src/pingpong.ts`).

The lifecycle in full detail — every trigger, every guard, every terminal
state — is [lifecycle.md](lifecycle.md).

## The mutation boundary

Every GitHub write the daemon makes is a `MutationIntent` passed through the
single gate in `src/gate.ts`. In dry-run the intent is written to
`state/dryrun/` instead of executed. There is deliberately no
review-dismissal intent kind, so "never dismisses a review" is a structural
property rather than a prompt instruction.

The session-side posting scripts are the other half of that boundary and carry
a behaviourally identical shell mirror of the guards; parity is test-enforced
(`tests/guards-shell-*.test.ts` runs the real scripts against the same cases
`tests/guards.test.ts` runs the gate).

What the sessions may and may not execute is a separate, five-layer boundary
documented in [../exec-boundary.md](../exec-boundary.md). The rule that the
daemon never schedules an agent — it nudges a session, and the session owns
its own fan-out — is [../single-shepherd-invariant.md](../single-shepherd-invariant.md).
Both are summarised in [boundaries.md](boundaries.md).

## Directory guide

| directory | what lives there |
|---|---|
| `src/` | the daemon. `config.ts` (every knob), `gate.ts`/`github.ts`/`githubAuth.ts` (writes, reads, App auth), `webhook.ts`, `reconcile.ts`, `statemachine.ts`, `dispatch.ts`, `verdicts.ts`, `sessions.ts`/`tmux.ts`/`worktrees.ts`, `guards.ts`/`cigate.ts`, `recheck.ts`/`pingpong.ts`, `severity.ts`/`posting.ts`/`anchors.ts`, `include.ts`/`templates.ts` (prompt and agent assembly), `state.ts` (SQLite), `wire.ts` (production assembly) |
| `src/memory/`, `src/openviking/` | the memory seam and its single engine — see [memory.md](memory.md) |
| `src/tui/` | the operator TUI and the companion controller |
| `src/slack/` | the Slack concierge |
| `src/onboard/` | the guided setup wizard's steps and engine |
| `extensions/` | pi extensions loaded per session: `inject-bridge.ts` (the wake channel), `ledger-pin.ts` (a findings ledger that survives compaction), `bash-guard.ts` (the command guard), `subagents.ts`, plus `vendor/` for third-party extensions carried with recorded patches |
| `scripts/` | the shell surface: the session posting route (`post-review.sh`, `approve-pr.sh`, `reply-thread.sh`, all sourcing `guards.sh`), `mint-token.sh`, `qcr`, `deploy.sh`, and the memory-forward relay |
| `prompts/` | system prompts and round templates. Half frozen seeds, half editable templates |
| `agents/` | the lens pass definitions (`pass-*.md`). Mostly frozen seeds |
| `seeds/` | the canonical byte-for-byte copies of every frozen file under `prompts/` and `agents/`; `tests/seed-integrity.test.ts` compares the two and fails on drift |
| `profiles/` | repo profiles: house-rule addenda packs plus lens-selection heuristics — see [../profiles.md](../profiles.md) |
| `docker/` | the daemon image, the companion image, the ingress sidecars |
| `deploy/` | the Ansible route for a managed VM, plus the secrets wizards |
| `tests/` | the suite (vitest); all I/O is mocked except the worktree tests, which drive a real scratch git repo |
| `docs/` | this documentation set |

**Frozen seeds.** Files under `prompts/` and `agents/` that appear in
`seeds/` are byte-pinned; editing one fails the suite. Changing what a pass
does is done by adding to the `PASS_ADDENDA` registry in `src/include.ts`,
which composes binding rules onto the *built* bodies in `state/agents/`, never
onto a seed. Ratified passages inside the editable files are additionally
fenced with `<!-- RATIFIED … -->` markers and hashed by
`tests/invariant-fences.test.ts`. See [../ownership.md](../ownership.md).

## Runtime directories

These are drop-boxes: empty in git (a `.gitkeep`, occasionally a README),
populated only at runtime, never committed.

| directory | written by | read by |
|---|---|---|
| `state/` | the daemon | `state.db` (SQLite, `src/state.ts`), `status.json` (the heartbeat), `agents/` (built pass bodies), `dryrun/` (would-be mutations) |
| `inject/<session>/` | the daemon | `extensions/inject-bridge.ts` — the wake channel |
| `verdict/` | the sessions | `src/verdicts.ts` |
| `commands/` | the overseer and the operator | `src/commands.ts` (`commands/operator/` is the sealed operator directory) |
| `digest/` | the end-of-day sweep | `src/digest.ts`, the TUI |
| `archive/pr-<n>/` | `src/sessions.ts` on close | `qcr why` |
| `wt/pr-<n>/` | `src/worktrees.ts` | the lens passes — read-only working copies; nothing here ever commits or pushes |
| `memory/` | nothing durable | a drop-box only; reviewer memory lives in OpenViking (`memory/README.md` explains) |

## Configuration

One file, `config.toml`, copied from `config.example.toml` and typed by
`src/config.ts`. Its sections map onto the map above: `[github]`, `[owner]`,
`[server]`/`[ingress]`, `[daemon]` (poll interval, concurrency, deadlines),
`[models]`, `[memory]`/`[openviking]`, `[tui]`/`[companion]`, `[guards]`,
`[recheck]`, `[review]`, `[escalation]` (off by default), `[slack]`, `[caps]`.
`dry_run` is on by default and is an owner-only surface
([../ownership.md](../ownership.md)).

## Build, test, run

```sh
npm ci
npm test                 # vitest, offline, no secrets
npm run build            # tsc + scripts/verify-dist.mjs
npm run typecheck:tests  # tests/ is excluded from the build; this checks it
```

All three must be green. `npm run build` emits to `dist/`; the daemon runs
`dist/src/wire.js`.

```sh
npm run daemon           # run the daemon locally (needs a secrets dir)
npm run dev              # build, then tsc --watch in the background + qcr tui
docker compose up -d           # the container route (pulled images; docker/daemon/README.md)
```

`npm run dev` writes the compiler's output to `state/tsc-watch.log` rather
than the terminal — a stray compiler line corrupts the TUI's alternate-screen
frame — and the TUI re-execs itself whenever `dist/` changes.

## Where to look

| question | file |
|---|---|
| what happens when a PR is labelled | `src/webhook.ts`, `src/statemachine.ts` |
| why a round did or did not run | `src/dispatch.ts`, `src/heuristics.ts` |
| why a review posted as a comment instead of an approval | `src/guards.ts`, `src/cigate.ts`, `scripts/guards.sh` |
| what may be written to GitHub at all | `src/gate.ts` |
| how a pass's instructions are assembled | `src/include.ts` (`PASS_ADDENDA`), `agents/`, `prompts/pass-common.md` |
| how findings become tags and blockers | `src/severity.ts` |
| what a session is allowed to run | `extensions/bash-guard.ts`, `src/execboundary.ts` |
| what the daemon persists | `src/state.ts` |
| how the operator sees any of it | `src/cli.ts`, `src/tui/` |

## Siblings

The rest of this set: [README.md](README.md) is the index;
[lifecycle.md](lifecycle.md), [sessions.md](sessions.md),
[data-model.md](data-model.md), [memory.md](memory.md),
[boundaries.md](boundaries.md), [ops.md](ops.md) and [tui.md](tui.md) each
take one mechanism further than this page does.
