# state-machines — a review of implicit state machines, and nothing else

`extends = "default"`, then makes the review a state-machine review. Select
it with `[review] profile = "state-machines"` (or `--profile state-machines`
for a one-shot review).

An **implicit state machine** is behaviour that depends on which state a
thing is in, where nobody wrote the states and the moves between them down
in one place. The state hides in boolean flags, nullable fields, a status
string, a stored column, a lifecycle phase, or the order calls must come
in. The defects it produces are the ones a diff shows least: nothing on the
changed line is wrong, and the bug is a sequence of events.

## What runs

- **The eight state-machine lenses**, the `pass-sm-*` family. Each reads
  the change for one class of defect and nothing else:

  | Lens | Looks for |
  |---|---|
  | `pass-sm-states` | a combination of flags, nullable fields and status values that must never exist, which a writer produces and a reader mishandles |
  | `pass-sm-transitions` | a write of the state with no check of the state it leaves; a guard removed; a transition that skips what its siblings do |
  | `pass-sm-exhaustive` | a state added, renamed or removed, and a dispatch, a list, a map or a filter over the set that was not updated |
  | `pass-sm-stuck` | a transient state (loading, processing, locked) that an error, an early return, a timeout or a cancel leaves set |
  | `pass-sm-events` | an event that arrives twice, late, out of order, or while the last one is still in flight |
  | `pass-sm-derived` | a stored copy or summary of other state, and a writer of the source that leaves it stale |
  | `pass-sm-lifecycle` | calls that must come in an order nothing enforces: use before init, use after close, a missing teardown |
  | `pass-sm-durable` | stored state: a persisted shape changed with no migration or version change (server or client), a state write and its side effect that are not atomic, sequential writes outside a transaction, a stored transition with no compare on the old state, recovery after a crash, old data meeting new code |

- **The validator**, at `deep` whatever the preset says
  (`[lenses.pass-validate] min_tier`). Every finding claims that a sequence
  of events reaches a state the code mishandles; the validator replays that
  sequence step by step and hunts the guard the lens may have missed. It
  removes any candidate that is not a state-machine defect.

## What a finding looks like

Every finding names, each with a file and line: the **state variable**, the
**state** it is in, the **event** that arrives, a numbered **trace** from an
entry point that reaches the pair, the **line that acts with no check**,
and the **consequence** someone would observe. A second actor (another
request, a retry, a worker) is named with its entry point.

The reviewer reads code and never runs it. A finding says "by reading", and
recommends the test that would confirm it — a stateful property test, a
two-request repro — rather than claiming the sequence was observed. When a
step of the trace rests on a fact the repository does not hold (whether a
provider redelivers an event), the finding is asked as a question that
names that gap.

## What a lens is given

Each family lens session holds `state_explore`, a read-only tool over the
pull request's committed objects: lines where something may be missing
from the diff's shape (anchors), and the writes, reads, exits and siblings
of a name. It runs no code and reaches no network
([`docs/exec-boundary.md`](../../docs/exec-boundary.md)); what it prints is
where to look, never a finding of its own.

## What it does not post

- An inventory: "this module holds five implicit state machines".
- A proposal to introduce a state machine, an enum or a library where the
  change made nothing worse. A machine that was implicit before the change
  is context, not a finding.
- A combination the type can hold that nothing writes and nothing
  mishandles: representable is not reachable.
- Flags that are independent facts; a boolean computed from other state.
- A dispatch the build already proves exhaustive, and "add a default case".
- A race with no named second actor.

## What does not run

Everything else. `[state_machines] only = true` switches off every lens
outside the family and the validator: `pass-baseline`, the per-file sweep,
`pass-tests`, the security family, the quality and style lenses and every
content-triggered sub-lens. None of them is planned or addable, and a
repository's `.qcr/profile.toml` cannot switch one back on. A lens added to
the code later is off here too, with no edit to this profile.

So **an APPROVE from this profile means "no state-machine finding"**. It
does not mean the change is correct, tested or secure: nothing here looked.
Run the default profile on the same repository when you want that review
too.

## When each lens is planned

- **Every content trigger plans its lens** (`[state_machines] triggers =
  "all"`): the strong signals (a check of the current state removed, a
  member added to an existing enumeration, two status flags added side by
  side, a transient state entered with no failure handling in the file, an
  effect that only copies state, a migration that changes a stored state, a
  PR that speaks of duplicates or ordering) and the weak ones (any status
  write, a dispatch over a state-like value, an event handler, a lifecycle
  method, a stored count).
- **All eight are planned on every PR that changes code or config**
  (`plan = "always"`). A PR that changes only documentation plans none of
  them.

## What posts

Only state-machine findings post (`[posting] scope = "state"`): every other
survivor, a `[blocker]` included, is withheld with the word `state-scope`.
The validator kills every other candidate `out-of-scope` first, and posting
withholds whatever it missed. A real state-machine defect raised by a lens
outside the family is recorded with a `state-machine` kind, so it posts.

## Scans

A scan under this profile is a deep state-machine scan:

- only the family runs (`[scan] lenses`), and only state-machine findings
  are kept (`[scan] kinds = ["state-machine"]`);
- four lenses read every file stage 1 reads (`[scan] deep_lenses`):
  transitions, stuck states, illegal states and stored state;
- stage 1 reports state-machine defects only and points only state-machine
  lenses (the `scan-stage1-state` addendum).

A scan has no change to anchor on, so it holds the same evidence standard
with nothing to excuse an inventory: a finding still needs its trace.

## Cost

On any PR that changes code or config that is eight lens runs plus the
validator at `deep`. Every family lens runs at the `deep` tier (high
reasoning), whatever the diff size: a `[models.pass_tiers]` entry lowers
one (`"pass-sm-stuck" = "standard"`), `[lenses.<pass>] effort` in a child
profile lowers its thinking, and `[models] effort` lowers every tier at
once. Every re-review is a full round: a state-machine-only review has no
follow-up delta yet.

## Without this profile

The default profile already runs part of the family: a strong trigger plans
its lens (`[state_machines] triggers = "strong"`), and a state-machine
review can be asked for on any PR, on top of the default plan:

- the `qcr:state-machines` label (`[state_machines] label` in config.toml);
- a `@<bot> state-machines` comment from an owner, member or collaborator
  (`[state_machines] command`);
- `qcr review-now <pr> --state-machines` from the operator;
- `/qcr-review --state-machines` in pi, or `qcr review --state-machines` in
  the terminal. `/qcr-review state-machines` (the preset) is this profile's
  lens set for one run.

A request plans the whole family, but never a lens a profile switched off.
