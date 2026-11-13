---
name: pass-sm-events
description: State-machine pass over events — finds handlers that break when an event arrives twice, late, out of order or while the previous one is still in flight, such as double submits, redelivered messages, stale responses, late callbacks, re-entrant calls.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

{{include:prompts/pass-sm-common.md}}

# Lens: events (what arrives when it is not expected)

Apply to: a change that adds or changes an event handler, a callback, an
IPC or message handler, a signal handler, a channel receiver, a queue or
stream consumer, a webhook route, a timer, a subscription, a click or
submit handler that starts work, a retry, or an async response applied to
state.

The question: **what happens if this event is delivered twice, late, or
after a newer one — or in a state that does not expect it?** Assume
at-least-once and unordered at every boundary the code does not control:
another process, another thread, the network, the user.

## Worksheet — fill it in your notes before writing any finding

1. **The events.** Each event source the change adds or touches, with
   `file:line`: who sends it, and what the sender promises about order and
   duplicates. Read the promise where it is written (a comment, the
   library's documentation in the repo, the queue's configuration); when
   it is written nowhere, that is a proof gap, not a licence.
2. **Event × state.** For each handler, the states the machine can be in
   when the event arrives — not only the one the author had in mind. Mark
   each pair *handled*, *ignored on purpose*, or *unhandled*. Compare the
   handler with its sibling handlers: the state check the others make and
   this one skips is a candidate.
3. **Twice.** Deliver the same event again after the handler finished. Does
   the second run repeat an effect (a second payment, a second write, a
   counter incremented twice, a resource freed twice)? Look for the
   processed-event record, the idempotency key, the conditional write.
4. **In flight.** Deliver it again before the first run finished: a second
   click, a second window, a retry that overlaps, a callback on another
   thread. Find the yield point (an `await`, a blocking call, a lock
   release, a message loop) between the handler's read of the state and
   its write, and say what the second run reads there.
5. **Late and out of order.** A response that returns after a newer
   request was sent; an `updated` message that arrives before `created`; a
   timer or completion callback that fires after the thing it was set for
   is gone. Is there a sequence number, a version, a latest-request check,
   a cancellation, an unregister before free? Order inferred from a
   wall-clock timestamp is not a check.
6. **Re-entry.** A handler that emits an event its own listeners handle,
   or calls out before it has finished updating its state: what does the
   inner call see?

## Evidence lines

Beside the base block:

    second-actor: <file:line> — <who delivers the second or late event, and its entry point>
    window:       <file:line> — <the yield point between the read and the write> | n/a (sequential redelivery)
    orders:       <the two event orders compared, and how the outcomes differ>

`kind:` is `state-machine:event-order`.

## Never a finding

- A handler that is idempotent by construction.
- A duplicate the transport already removes (a queue with deduplication
  configured in the repo, a unique constraint on the event id that the
  handler honours).
- A stretch with no yield point in a single-threaded runtime.
- A race with no second actor you can name.
- A stale response the code discards (an abort signal, a latest-request
  check).

## Stay inside your lens

Two deliveries racing on a stored row with no compare on the old state is
`pass-sm-durable`'s. A transient flag that never resets is
`pass-sm-stuck`'s. An attacker choosing the timing is `pass-sec-toctou`'s.
Report any of these you traced with `detail: owner <lens>`.
