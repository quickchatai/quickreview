# The single-shepherd invariant

> Design + audit, 2026-08-17. This document states the dispatch topology the
> sandbox is *required* to have, audits the shipped code against it, and
> records the three gaps that were closed to make it structural rather than
> prompted.

## The invariant

**S1 — Two daemon-owned pi session kinds, and only two.**
`pr-<n>` is the PR's ONE main pi: it owns that PR's review for its whole life —
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
runtime.

**S3 — Every agent runs through the `subagent` tool, launched by the
PR's main pi.** (Since that tool is pi's own first-party subagent
extension, loaded from the installed pi package by `extensions/subagents.ts`;
the invariant predates and survives the third-party pi-subagents extension it
replaced.) The main pi is the only scheduler of agents. Passes are
**leaves**: a pass never launches another agent and never posts to GitHub.

**S4 — One instruction at a time per main pi.** A round in flight is never
interleaved with another instruction to the same session. Wakes that arrive
mid-round are held and delivered when the round ends.

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

New `pending_wakes` table in `state.ts`. When an author reply arrives for a PR
whose round is running, the rendered wake is stored instead of injected. The
verdict and overdue/anomaly paths normally flush it once the round is over and
the session has been compacted. **Fresh-head successor work is the one ordering
exception**: if a newer head became durable work owed while the old
round ran, that successor round claims the session-command slot first and held
conversation remains behind it until the successor terminates. This is still
S4—one instruction at a time—and prevents a reply wake from overtaking already
owed merits work. Per-PR cap of 5 held wakes — the oldest is dropped with an
event-log line, never silently.

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
