---
name: pass-sm-transitions
description: State-machine pass over transitions — finds writes of a status or lifecycle state that do not check the state they leave, guards on the wrong state, and transitions that skip the work their siblings do.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sm-common.md}}

# Lens: transitions (who may move it, and from where)

Apply to: a change that writes a field, member, column or variable that
holds a state (`status`, `state_`, `m_state`, `phase`, `stage`, `step`,
`mode`, a connected or running flag), adds a handler, command, route or job
that does, removes or changes a check of the current state, or touches a
transition table or library.

The question: **does every write of the state check the state it is
leaving?** An unguarded write is a transition from *every* state, including
the terminal ones.

## Worksheet — fill it in your notes before writing any finding

1. **The writers.** Search the whole repository for every write of the
   state variable: assignments, setters, `update(...)` calls, raw SQL,
   bulk updates, a reset in an error path, a reload from storage, fixtures
   that ship. Count them. One owner of transitions is the safe shape; many
   writers is where the hole is.
2. **The table.** For each writer: the target state, the source states it
   is meant to run from, and the guard that enforces that — an `if`, an
   assertion, a `WHERE status = ...`, a compare-and-swap, a transition
   function, a caller's check. Write "none" where there is none.
3. **The forbidden source.** For each writer the change adds or changes,
   name a source state it must not run from (a closed connection being
   marked connected, a cancelled job being marked done, a finished
   download being restarted) and write the trace that reaches the writer
   in that state.
4. **The removed guard.** For each state check the change removes or
   loosens, list what it used to stop and whether anything stops it now.
5. **The siblings.** Compare the new or changed transition with the other
   transitions to the same target, line by line: the log or audit record,
   the timestamp, the notification or event, the counter, the reset of a
   partner field, the lock they all take. A transition that skips one is a
   finding when a reader depends on it.
6. **The bypass.** Where a transition function or library exists, a direct
   assignment that goes around it skips its guards and callbacks; an
   invalid transition that returns `false` or an error that is not checked
   moves nothing and reports success.

## Evidence lines

Beside the base block:

    from:        <the source state the write must not run from>
    writers:     <how many writers of the variable you found, and which guard each has>
    siblings:    <the sibling transitions compared, and what this one skips> | n/a

`kind:` is `state-machine:transition`.

## Never a finding

- A write whose guard lives in a caller, a wrapper, a constraint or a
  conditional `WHERE` you have read.
- An initial write on a fresh object or row.
- A transition that is legal from every state by design (a soft delete, an
  admin override, a reset to idle) when the code or its documentation says
  so.
- "This should use a state-machine library."

## Stay inside your lens

Two actors racing through a correct guard is `pass-sm-events`'s (in
process) or `pass-sm-durable`'s (on stored state). A state nobody handles
at a dispatch is `pass-sm-exhaustive`'s. Report any of these you traced with `detail: owner <lens>`.
