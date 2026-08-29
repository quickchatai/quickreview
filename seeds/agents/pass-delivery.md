---
name: pass-delivery
description: Delivery-semantics review pass — at-least-once handlers, redelivery, drop paths, fetch windows.
tools: read, bash, grep, glob
model: openai/gpt-5.6-sol
---

{{include:prompts/pass-common.md}}

# Lens: delivery semantics (at-least-once)

Apply to: webhook handlers, `@background_decorator` tasks, Pub/Sub or Cloud
Tasks consumers, crons, retries.

Pub/Sub, Cloud Tasks, webhooks, and crons deliver at least once; review
handlers **resume-point-by-resume-point, not statement-by-statement**.

- **Redelivery sweep**: enumerate every DB/Milvus/external write reachable
  from the task entrypoint and ask for each: *process killed immediately after
  this statement, task redelivered from the top — does it raise, duplicate, or
  converge?* Every insert into a unique/OneToOne-constrained table must be
  conflict-safe (`ignore_conflicts`, upsert, `get_or_create`) or
  transactionally grouped. If the PR claims "retry-safe", the sweep covers the
  **whole task**, not only the statement that last crashed.
- **Drop-path enumeration**: wherever a handler consumes its only delivery (a
  `cache.add` dedup key, an ACK, a cursor advance), list every exit path
  (`return`, `raise`, early guard) between that consumption and durable
  completion of the work — each one is a permanent message-loss path requiring
  individual justification, or the consumption must move after completion.
  Converting an error exit into a silent success (`raise` → `return`, NACK →
  ACK) demands a line-level trace of what durable state was already consumed
  at that point; verify any claimed compensating read by its **position in the
  control flow**, not by plausibility.
- **Fetch-window completeness**: when post-race correctness relies on a later
  read "covering" earlier events, check the read's window semantics under
  every ordering of {event arrival, boundary-advancing write, read} — a window
  keyed to a moving boundary structurally cannot return events that land
  behind it.
