# Architecture

How QuickReview is built, one mechanism per page. Start with the overview; the
rest go deeper on a single seam and are readable in any order.

Each page cites the module that implements what it describes, so a claim can
always be checked against the code.

| page | what it covers |
|---|---|
| [overview.md](overview.md) | the system map: processes in the container, operator surfaces, the path from a webhook or reconcile poll to a posted review, the directory guide, and how to build and test |
| [lifecycle.md](lifecycle.md) | a PR's journey: triggers, the state machine, dispatch, rounds, verdicts, rechecks and ping-pong |
| [sessions.md](sessions.md) | the LLM side: tmux + pi sessions, worktrees, the wake channel and its delivery receipts, lens fan-out and the validator |
| [data-model.md](data-model.md) | what the daemon persists — the SQLite schema, the state marks that carry cross-feature meaning, and the file drop-boxes |
| [memory.md](memory.md) | reviewer memory: the store seam, the OpenViking engine, per-user confinement, and who may write |
| [boundaries.md](boundaries.md) | the safety seams: the mutation gate, the posting guards, the execution boundary, and the single-shepherd rule |
| [ops.md](ops.md) | running it: deploy routes, configuration, health and heartbeat, logs, and what to do when something is stuck |
| [tui.md](tui.md) | the operator TUI and the companion: layout contract, tabs, and the two writes the board is allowed to make |

## Related documents outside this set

- [../../MANIFESTO.md](../../MANIFESTO.md) — the philosophy the implementation follows
- [../../AGENTS.md](../../AGENTS.md) — the orientation page for an AI agent editing this codebase
- [../onboarding.md](../onboarding.md) — the guided setup, step by step
- [../ownership.md](../ownership.md) — the owner-only surfaces: the dry-run flag, the frozen seeds, ratification
- [../exec-boundary.md](../exec-boundary.md) — the five layers of the no-execution boundary, in full
- [../single-shepherd-invariant.md](../single-shepherd-invariant.md) — why the daemon never schedules an agent
- [../profiles.md](../profiles.md) — repo profiles: house-rule addenda and lens heuristics
- [../tui.md](../tui.md) — the TUI's operator-facing reference
- [../provenance.md](../provenance.md) — what the `FT-####` citations in this codebase mean
- [../../CONTRIBUTING.md](../../CONTRIBUTING.md) — build, test, and the frozen-seed rule
