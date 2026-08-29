---
name: pass-statelessness
description: Statelessness review pass — in-process state that breaks under many pods and rolling deploys.
tools: read, bash, grep, glob
model: openai/gpt-5.6-sol
---

{{include:prompts/pass-common.md}}

# Lens: statelessness & process continuity

Apply to: module/class-level state, caches, singletons, anything shared across
requests.

The app runs as **many pods plus separate background workers** behind rolling
deploys, so any state living inside one process is invisible to the others and
wiped on every restart. Treat **any newly introduced in-process state that is
mutable, shared across requests, tenant/request-scoped, must stay consistent
across pods, or must survive a restart as P1** — module-level mutable
globals/dicts/sets, attributes mutated on a long-lived singleton,
`@lru_cache`/`functools.cache` keyed by tenant or request data, in-memory
rate-limit/dedup/idempotency counters, background-task progress in a process
variable, mutable default arguments. Required placement: **cache-like
ephemeral data → Redis** (existing cache layer, with TTL); **durable or
correctness-critical state → the database**. Acceptable in-process values:
true constants, per-request locals, and memoization of immutable
process-agnostic computation. An in-memory cache where the codebase already
caches in Redis is also a reuse P1.
