---
name: pass-sm-lifecycle
description: State-machine pass over lifecycle order — finds APIs and objects that only work when their calls come in an order nothing enforces, such as use before init, use after close or dispose, missing or doubled teardown.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sm-common.md}}

# Lens: lifecycle (the order calls must come in)

Apply to: a change that adds or changes an `init`, `start`, `open`,
`connect`, `begin`, `close`, `stop`, `dispose`, `shutdown`, `release` or
`teardown`, a constructor or destructor, a setup or teardown sequence, a
window's or a component's creation and close, a callback or listener
registered or removed, or a check of an object's phase (`initialized`,
`closed`, `ready`, `destroyed`).

The question: **does this object only work if its methods are called in an
order nothing enforces — and does a caller break that order?** The phase
is state; the calls are its events.

## Worksheet — fill it in your notes before writing any finding

1. **The protocol.** The phases of the object (created, started, closed)
   and which methods are legal in which. Find where the requirement is
   stated: a thrown or logged "not initialized" or "already closed", an
   assertion, a comment, the documentation, or — when it is stated
   nowhere — what its other callers consistently do.
2. **The call sites.** Every caller of the methods the change adds or
   changes. For each, the phase the object is in when the call is made.
3. **Before init.** A use reachable before the start has finished: an
   async `init` that is not awaited, a field read by a callback registered
   before it is assigned, a request served while the connection is still
   being opened, a goroutine or thread started in a constructor before the
   fields it reads are set.
4. **After the end.** A use reachable after close, dispose or destruction:
   a timer, a subscription, an IPC message or an in-flight request that
   calls back into an object already torn down; a callback a library fires
   after its owner was freed; a handle returned to a pool and used again.
5. **The pairs.** Every start has its stop on every path: a listener or
   callback added and never removed, a resource acquired and released on
   one branch only, a teardown that runs twice (a double free, a double
   `close`), a second `start` with no `stop` between. When the change moves
   a teardown call into one branch, check every other exit still reaches
   it; that defect is `pass-sm-stuck`'s, so report it with
   `detail: owner pass-sm-stuck`.
6. **The order inside setup and teardown.** Steps the change reorders:
   something used before the step that creates it, or destroyed before the
   step that still needs it (a member destroyed before the thread that
   uses it is joined). Read each early error exit of a function the change
   touches, and of a callee it now calls during setup, against the
   registration order: an exit whose teardown assumes a setup step that has
   not run yet (it removes the object from a list or registry it was never
   added to, decrements a count never incremented, or asserts that it is
   registered), or after which the caller goes on to register or use the
   object the callee freed, is a finding. Freeing an object that was never
   registered, on an exit that then leaves setup, is the right cleanup.

## Evidence lines

Beside the base block:

    protocol:    <file:line> — <where the required order is stated, or the sibling call sites that show it>
    violation:   <file:line> — <the call made in the wrong phase, and the phase it is made in>

`kind:` is `state-machine:lifecycle`. `property` is `precedence` (use
before init, use after close) or `response` (a start with no stop on some
path).

## Never a finding

- An order the type enforces (a value that exists only after the step
  that returns it), or a callee that tolerates the wrong phase by design
  (an idempotent `close`, a lazy `init`).
- A teardown the runtime performs (a process exit, a framework that owns
  the object's disposal) — name the framework hook you read.
- A phase check that is missing where no caller can reach the method in
  the wrong phase.

## Stay inside your lens

A flag left set by a failing path is `pass-sm-stuck`'s. A late event
arriving at a live object is `pass-sm-events`'s. A leaked resource with no
phase question (an unclosed file in a script) is `pass-baseline`'s. Report any of these you traced with `detail: owner <lens>`.
