# The single-shepherd invariant

This document states the dispatch topology the sandbox is *required* to have,
the audit of the code against it (2026-08-17), and the three fixes that make
it structural rather than prompted. The last section is the transitional
amendment (D9, ratified at P-1): what the invariant means while the tmux bot
and the engine routes coexist.

## The invariant

**S1 — Two daemon-owned pi session kinds, and only two.**
`pr-<n>` is the PR's ONE main session (pi): it owns that PR's review for its whole life —
every round, every staleness check, every author exchange. `overseer` is the
global watcher over all reviews in flight (anomalies, commands, the EOD sweep).
The daemon spawns nothing else, ever. (`companion` is a separate boundary and
lives on the owner's PC — see CLAUDE.md.)

A PR's **OpenViking session** (`pr-<n>`) is not a third kind and does
not count against S1: it is a **row in the memory store**, created and deleted
over HTTP, holding that review's raw working notes. Nothing schedules it,
nothing runs in it, and it shares the tmux session's name only so an operator
reading `state/` sees the correspondence at a glance.

**S2 — The daemon nudges; it never schedules an agent.**
Everything the daemon sends a session is a deterministic instruction computed
in daemon code without an LLM: the `RoundOrder` (round type, pass plan, tiers,
gates, escalation criteria) rendered into a wake file, or a ping-pong wake.
The daemon never launches a pass, never runs `pi`, and never picks a lens at
runtime. The SDK is the engine's session host, not a daemon facility:
`@earendil-works/pi-coding-agent` is imported at runtime only by
the engine's SDK host module (`pisdk`, in `src/engine/`) and the extension factory modules, and no daemon module's
import closure reaches `src/engine/` (the engine installs a process-global HTTP
dispatcher). Both are fenced in `tests/single-shepherd.test.ts` and
`tests/fences-engine.test.ts`, which also keeps `src/engine/**` free of
image-only paths (`/opt/qcr`, `/opt/quickreview`, state-home layout literals,
`QCR_STATE_HOME`), so a post-v1 pi package stays possible.

**S3 — Every agent runs through a lens tool, launched by the PR's main
session** (with one engine-side launcher, see the transitional amendment).
On the tmux bot that tool is `subagent`: pi's own first-party subagent
extension, loaded from the installed pi package by `extensions/subagents.ts`.
The main session is the only scheduler of agents. Passes are
**leaves**: a pass never launches another agent and never posts to GitHub.
`launch_plan` (registered by the same glue beside the subagent tool)
does not change this: the main pi calls it, and it launches the round's
discovery task files — confined to a round's `tasks/` and `tasks-sweep/`
dirs of the session's own PR (`QCR_PR`), both from one round per call, never
the validator's — as ONE call through the subagent tool's own
wrapped execute and semaphore. It exists because a main pi asked to launch
every row in one turn does not reliably do so.

**S4 — One instruction at a time per main pi.** A round in flight is never
interleaved with another instruction to the same session. Wakes that arrive
mid-round are held and delivered when the round ends. The one exception is an
operator's steer, below.

## Audit against the shipped code (2026-08-17)

| Invariant | Status before | Evidence |
| --- | --- | --- |
| S1 | **held** | `sessions.ts` — `ensurePrSession` / `ensureOverseerSession` are the only `spawnSession` callers outside the smoke script; `isSandboxSession` bounds the namespace to `pr-<n>` + `overseer`. `eod.ts` injects into the overseer rather than birthing a session. |
| S2 | **held** | `dispatch.ts` computes the plan from the files API via pure `heuristics.ts`; `wire.ts` `onStart` builds *agent definition files* into `state/agents/` for the extension and launches nothing. No `pi` invocation exists outside `sessions.ts`. |
| S3 | **partly** | The main pi's fan-out is correct (round templates mandate the `subagent` tool; `bash-guard.ts` blocks a bash fan-out). But nothing stopped a *pass* from launching further agents: the seeds' `tools:` line is a convention, not enforcement, and the build step never constrained it. → **G1** |
| S3 (diagnostics) | **weak** | `pi`, `node`, `npx` were blocked only by falling off the read-only allowlist, with a generic "not an allowed read-only command" reason that never tells the model to use the `subagent` tool instead. → **G2** |
| S4 | **broken** | `daemon.ts` injected an author-reply wake into `pr-<n>` unconditionally, including while that PR's round was `reviewing` — two competing instructions to the one pi that owns the review, with the reply able to land between pass dispatch and posting. → **G3** |

`prompts/pass-common.md`, `prompts/conversation-system.md` and `agents/pass-*.md`
are canonical seeded content (CLAUDE.md rule 6) and are **not** edited. Every
prompt-side reinforcement below goes through the build-time addendum in
`include.ts`, which is code and already the established seam for exactly this.

## The three fixes

### G1 — passes are leaves, enforced at build time

`buildAgents()` normalizes each built variant's `tools:` frontmatter, dropping
any agent-spawning tool (`subagent`, `subagents`, `task`, `agent`, `agents`,
`dispatch`) should a seed ever grow one, and the addendum appended to
every built agent states the leaf rule outright. The seeds stay byte-identical;
only `state/agents/*.md` — what agent discovery actually reads — carries the
enforcement. (Structurally, children also never load the subagents glue: it
rides per-spawn argv, and a child process loads only the global settings.json
extensions — so the `subagent` tool does not exist inside a leaf at all.)

### G2 — bash-guard names the agent-spawn class explicitly

`checkBashCommand` blocks `pi`, `node`, `npx`, `bun`, `deno`, `claude`, `codex`
and friends with a reason that names the rule and points at the right tool:
*"never spawn an agent from bash — the `subagent` tool is the only launcher"*.
Behaviourally these were already blocked by falling off the allowlist; the win
is a directive error message and an invariant that greps.

### G3 — mid-round wakes are held, not interleaved

The `pending_wakes` table in `state.ts`. When an author reply arrives for a PR
whose round is running, the rendered wake is stored instead of injected. The
verdict and overdue/anomaly paths normally flush it once the round is over and
the session has been compacted. **Fresh-head successor work is the one ordering
exception**: if a newer head became durable work owed while the old
round ran, that successor round claims the session-command slot first and held
conversation remains behind it until the successor terminates. This is still
S4—one instruction at a time—and prevents a reply wake from overtaking already
owed merits work. Per-PR cap of 5 held ORDINARY wakes — push recheck nudges
go first (their claim released, so the reconcile push backstop asks again),
then the oldest other wake (a ci or base-advance recheck among them: its claim
released, its loss recorded as the quiet `recheck_wake_dropped`, since no sweep
re-raises it), each with an event-log line, never silently. Author replies
are never evicted and not counted: each is a claimed obligation
nothing else will raise again, and a burst is one coalesced run of at most ten.
A flush that finds the PR's next round already running delivers nothing: a
round end that awaited long enough for it to be dispatched
leaves the wakes held for that round's end. An acked round command holds no
session slot, so the slot check alone could not see such a round.

Verified end to end: `tests/verdicts.test.ts` proves the watcher actually
flushes on both round-end paths (verdict applied, round abandoned as overdue)
and leaves a wake held while the round still runs; `tests/single-shepherd.test.ts`
adds source-level guards that the author-reply path goes through `wakeOrHold`
and that no other module opens a second wake channel to a PR session. The Slack
router and the TUI alert sink inject into the **overseer** only, so neither can
interrupt a round.

One writer does reach a `pr-<n>` session from outside the daemon: the
operator's quick-message box (`m`, `src/tui/msg.ts`), which writes the inject
file itself over ssh and deliberately does **not** go through `wakeOrHold` — an
operator asking a question mid-round is the operator's call. It is
human-initiated, never automatic, and carries no verdict. It still cannot
interrupt a turn: the inject-bridge delivers every message as a follow-up
queued behind the running agent, never as a steer. `tests/single-shepherd.test.ts`
names it in the exhaustive registry of modules allowed to construct an inject
path, so a second such writer fails the suite.

Known and accepted: the wake is *rendered* at claim time, so its ping-pong
discipline counter reflects the moment the reply arrived. That counter only
advances when the bot replies, which cannot happen while the wake is held.

## Transitional amendment (D9, ratified at P-1)

CLAUDE.md rule 9 is the authority for the wording; this section says what it
covers while the tmux bot and the engine routes coexist.

- **Two lens tools, one rule.** On the tmux bot `extensions/subagents.ts` stays
  the lens tool (`subagent` / `launch_plan`) until the bot moves to workers. On
  engine (SDK) routes our own lens tool runs: `lens` / `lens_wave`, in
  `src/engine/lens/`. Both are called by the PR's main session, and nothing
  else schedules a lens.
- **Exactly two launchers.** The round's engine starts the *planned discovery
  wave* — the task files the engine wrote for this round — at round start.
  Everything else (rows the session raises, lenses it adds, the validator) is
  launched by the PR's main session. The daemon launches nothing and the
  engine never launches pass-validate. If the interim P7.11 is chosen (D36), a
  kill-switched tmux-pi extension command launches the planned wave through the
  native subagent path; it is the engine's launch, not a third launcher.
- **Lenses are leaves by construction.** A lens session is never given a lens
  tool, and `include.ts` strips agent-spawning tools at build time (G1), so a
  pass cannot fan out on either route.
- **Held wakes stay held.** Mid-round daemon wakes go to `pending_wakes` and
  flush at round end (`src/wakes.ts`, G3); the new routes do not add a second
  wake channel.
- **The operator-steer exception.** A steer an operator sends from the viewer
  goes straight to the running session, like the quick-message box above. It is
  human-initiated, never automatic and carries no verdict. It applies with the
  daemon's own wakes still held: the exception is for the operator, not for the
  daemon.
