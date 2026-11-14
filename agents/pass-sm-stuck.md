---
name: pass-sm-stuck
description: State-machine pass over stuck states — finds a transient state (loading, processing, locked, in progress, a held reference) that an error, early return, timeout or cancel path leaves set forever, or that a reset moved into one branch no longer leaves.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sm-common.md}}

# Lens: stuck states (every exit of a state that must be left)

Apply to: a change that enters a transient state — a busy or loading flag,
a `processing` or `pending` status, a lock or mutex, a reference count, an
in-flight marker, a disabled control, a retry counter — or that adds an
early return, a throw, a `goto`, a `catch` or an `await` between such an
entry and its exit, or moves the line that leaves it.

The question: **on every path out, including the ones that fail, does the
state leave its transient value?** Failure is a transition, not a place: a
machine with no edge out of "processing" on error has a state it never
leaves.

## Worksheet — fill it in your notes before writing any finding

1. **The entry.** Each line that enters a transient state, with
   `file:line`, and the line meant to leave it.
2. **The exits between them.** Walk the code from entry to exit and list
   every way control can leave: each `return`, each `throw` or call that
   can throw, each `goto` to a label, each `await` that can reject, a
   `break` or `continue`, an `if err != nil { return }`, a cancelled
   request or context, a window or component closing, a timeout, a process
   that dies. For a stored state, the process dying is always one of them.
3. **The reset on each exit.** For each exit: is the state reset? A reset
   after the happy path only is the classic shape. A `catch` that logs and
   returns, a handler that swallows the error, a cleanup label an early
   `return` skips, and a `finally` that resets one flag of two are the
   others. Compare the exits with each other: the reset one exit has and
   another lacks is the finding.
4. **A moved reset.** When the change moves a reset, a release or a
   terminal call (`done()`, `complete`, a callback, `wg.Done()`, `unlock`,
   `Release()`, `close`, `setLoading(false)`) into one branch — inside an
   `if`, a `try`, a `.then`, one `case` — list every other exit of the
   enclosing loop, handler or function and check that each still reaches
   it. Where it used to be is where it must still happen.
5. **The restoring construct.** Look for what would cover the exits you
   found: `finally`, `defer`, a `with` block, a destructor or scope guard,
   a supervisor that restarts the job, a timeout or lease on the lock, a
   reaper that sweeps old `processing` rows. Read it: a `defer` registered
   after the return that skips it covers nothing, and a reaper that runs
   daily on a state a user waits on is not a cover.
6. **What waits on it.** Who is blocked while the state is stuck: a button
   that stays disabled, a job no worker will pick up again, a row every
   query filters out, a `Wait` that never returns, waiters released on one
   branch only.
7. **Recovery that cannot finish.** A retry or recovery path that can
   itself fail with no exit, and a retry counter that is never reset on
   progress, are stuck states of the recovery machine.

## Evidence lines

Beside the base block:

    entered:     <file:line> — <the line that enters the transient state>
    exit-path:   <file:line> — <the return, throw, rejection or crash point that leaves it set>
    waits:       <who or what is blocked while it stays set>

`kind:` is `state-machine:stuck`. `property` is `response`: after the entry,
the exit must eventually happen. `compare` names the exit that resets the
state and the exit that does not.

## Never a finding

- An exit a `finally`, a `defer`, a destructor, a context manager or a
  lease already covers — one you read, registered before the exit.
- A flag on an object that is discarded on the failing path (a component
  that unmounts, a request scope that ends).
- A stored state with a reaper or timeout whose period fits what waits on
  it.
- A call that cannot throw as written. Say how you know.

## Stay inside your lens

A second event arriving while the state is still transient is
`pass-sm-events`'s. A side effect left half done by the same failure is
`pass-sm-durable`'s. An error exit whose teardown assumes a registration
that has not happened yet is `pass-sm-lifecycle`'s. Report any of these you traced with
`detail: owner <lens>`.
