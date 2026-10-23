# The single-shepherd invariant

This document states the dispatch topology the sandbox is *required* to have,
the audit of the code against it (2026-08-17), and the three fixes that make
it structural rather than prompted. The last section is the amendment on workers: what the
invariant means now that the bot runs in workers.

## The invariant

**S1 — One daemon-owned pi session kind, and only one.**
`pr-<n>` is the PR's ONE main session (pi): it owns that PR's review for its whole life —
every round, every staleness check, every author exchange. There is no global
watcher: the overseer retired into the companion, which lives
on the operator's machine and is a separate boundary. The daemon runs no pi itself: it
starts workers (S5).

A PR's **OpenViking session** (`pr-<n>`) is not a second kind and does
not count against S1: it is a **row in the memory store**, created and deleted
over HTTP, holding that review's raw working notes. Nothing schedules it,
nothing runs in it, and it shares the session's name only so an operator
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
session** (with one engine-side launcher, see the amendment). That tool is
`lens` / `lens_wave` (`src/engine/lens/`) on every route; the native `subagent`
extension and `launch_plan` are gone. The main session is the only scheduler of
agents. Passes are **leaves**: a pass never launches another agent and never
posts to GitHub. `lens_wave` joins the engine-launched wave: it returns the
wave's results, or waits for them without launching duplicates, and extra lenses
go through `lens`.

**S4 — One instruction at a time per main pi.** A round in flight is never
interleaved with another instruction to the same session. Wakes that arrive
mid-round are held and delivered by the round's own worker before it exits. The
exceptions are the operator's, below: a steer, and a message to an idle PR.

**S5 — One host per PR at a time.** A PR's session is hosted by exactly one
of: a round worker, an answer worker, a takeover lease or a debug round. The
one-active command index and the host lease keep it to one; every IPC request
carries its command's generation, so a post, a permit or an event from a past
generation is refused, and the previous host is confirmed gone before the next
one resumes the JSONL, so two writers never append to it.

## Audit against the shipped code (2026-08-17)

| Invariant | Status before | Evidence |
| --- | --- | --- |
| S1 | **held** | PR sessions are born only by `PrSessionLifecycle.ensureSession` (`src/pr-session-lifecycle.ts`), reached only from the worker host (`src/worker-session-host.ts`); `spawnSession` is called only by the replay harness; `ensureOverseerSession` is deleted; `isSandboxSession` bounds the namespace to `pr-<n>`. `eod.ts` writes the day's sweep to the companion inbox. |
| S2 | **held** | `dispatch.ts` computes the plan from the files API via pure `heuristics.ts`; `wire.ts` `onStart` builds *agent definition files* into `state/agents/` for the extension and launches nothing. No `pi` invocation exists outside `sessions.ts`. |
| S3 | **partly** | The main pi's fan-out is correct (round templates mandate the `subagent` tool; `bash-guard.ts` blocks a bash fan-out). But nothing stopped a *pass* from launching further agents: the seeds' `tools:` line is a convention, not enforcement, and the build step never constrained it. → **G1** |
| S3 (diagnostics) | **weak** | `pi`, `node`, `npx` were blocked only by falling off the read-only allowlist, with a generic "not an allowed read-only command" reason that never tells the model to use the `subagent` tool instead. → **G2** |
| S4 | **broken** | `daemon.ts` injected an author-reply wake into `pr-<n>` unconditionally, including while that PR's round was `reviewing` — two competing instructions to the one pi that owns the review, with the reply able to land between pass dispatch and posting. → **G3** |

`prompts/pass-common.md`, `prompts/conversation-system.md` and `agents/pass-*.md`
are canonical seeded content (AGENTS.md invariant 3) and are **not** edited. Every
prompt-side reinforcement below goes through the build-time addendum in
`include.ts`, which is code and already the established seam for exactly this.

## The three fixes

### G1 — passes are leaves, enforced at build time

`buildAgents()` normalizes each built variant's `tools:` frontmatter, dropping
any agent-spawning tool (`subagent`, `subagents`, `task`, `agent`, `agents`,
`dispatch`) should a seed ever grow one, and the addendum appended to
every built agent states the leaf rule outright. The seeds stay byte-identical;
only `state/agents/*.md` — what agent discovery actually reads — carries the
enforcement. (Structurally, a lens session is never given a lens tool either,
so no agent-launching tool exists inside a leaf at all.)

### G2 — bash-guard names the agent-spawn class explicitly

`checkBashCommand` blocks `pi`, `node`, `npx`, `bun`, `deno`, `claude`, `codex`
and friends with a reason that names the rule and points at the right tool:
*"never spawn an agent or a runtime from bash — the lens tool (`lens` /
`lens_wave`) is the only launcher"*.
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
and that no other module opens a second wake channel to a PR session.

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

## Amendment: workers

The invariant above is the authority for the wording; this section says what it
covers now that the bot runs in workers.

- **One lens tool, one rule.** Our own lens tool runs on every route: `lens` /
  `lens_wave`, in `src/engine/lens/` (an interactive pi's — the companion, a
  debug round — through `extensions/cli/lens.ts`). It is called by the PR's main
  session, and nothing else schedules a lens.
- **Exactly two launchers.** The round's engine starts the *planned discovery
  wave* — the task files the engine wrote for this round — at round start.
  Everything else (rows the session raises, lenses it adds, the validator) is
  launched by the PR's main session. The daemon launches no agent and the
  engine never launches pass-validate.
- **Lenses are leaves by construction.** A lens session is never given a lens
  tool, and `include.ts` strips agent-spawning tools at build time (G1), so a
  pass cannot fan out on any route.
- **Held wakes stay held.** Mid-round daemon wakes go to `pending_wakes` and are
  flushed by the round's own worker before it exits (`src/wakes.ts`, G3);
  the worker routes add no second wake channel.
- **The operator's two exceptions.** A steer an operator sends from the viewer
  goes straight to the running session, like the quick-message box above. A
  message to an idle PR is answered now, not held: a short answer worker resumes
  the session under the same id, replies and exits. It has read and chat tools
  and no lens tool; it posts only when the operator marked the message
  `may_post`, through the one gate, and may then approve with the guards. Both
  are human-initiated, never automatic, and neither carries a verdict. They
  apply with the daemon's own wakes still held: the exceptions are for the
  operator, not for the daemon.
- **The permit broker grants, it launches nothing.** The daemon hands out a slot
  per lens across workers (`[daemon] lens_permits`, 20 on the VM), FIFO and
  staggered. Holding the slots is not scheduling an agent: which lens runs, and
  when, stays with the engine and the main session.
