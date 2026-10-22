---
name: pass-deferred
description: Deferred-work review pass (sub-lens of concurrency) — when work moves onto a queue, loop, timer or batch, checks who wakes it, who reads before it drains, and what coalescing merges.
tools: read, bash, grep
---

{{include:prompts/pass-common.md}}

# Lens: deferred work (sub-lens of concurrency)

Selected because the diff moves work that used to happen immediately onto a
queue, an event loop, a timer, a background task or a batch — or merges
repeated requests into one later pass. The defects live in the gap between
"requested" and "done".

For each deferred operation, answer with `file:line` evidence:

1. **Who wakes the consumer?** After something is queued, what guarantees the
   queue is drained — a wakeup, a notify, the next loop iteration? Look for an
   entry point that queues without waking (a synchronous API, an IPC handler,
   an early return): its work waits until something unrelated happens.
2. **Who reads before the drain?** List every reader of the state the
   deferred work updates — a getter called right after the setter, the
   command's own reply, a property observer, a test. Each now sees the OLD
   value until the queue drains. Is that a contract change for it?
3. **What does merging change?** If duplicate requests are merged or only the
   last value is kept, list the handlers that apply RELATIVE changes (toggle,
   increment, scale, append): merging pairs of those changes the result.
4. **Order and errors.** Are queued operations still applied in the order
   they were requested? Does an error in deferred work still reach the caller
   that used to receive it synchronously?
5. **Teardown.** What happens to queued work when its owner is destroyed or
   the request is cancelled?

`NONE` when every answer holds.
