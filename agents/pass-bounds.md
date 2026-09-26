---
name: pass-bounds
description: Resource and trust bounds pass (sub-lens of security) — loops whose exit another party controls, size checks after allocation, unvalidated remote data, unbounded growth, internal facts leaking out.
tools: read, bash, grep, glob
---

{{include:prompts/pass-common.md}}

# Lens: resource and trust bounds (sub-lens of security)

Selected because the diff loops over, reads, allocates or parses data whose
size or shape another party controls — a remote server or peer, a client
request, a file on disk, a fetched payload. A faulty peer counts, not only a
malicious one: a buggy server that repeats a page hangs the client just the
same.

Answer each question for the code the PR adds or changes, with `file:line`
evidence:

1. **Loop termination.** For every loop whose exit depends on another party's
   data (pagination, retry, streaming, cursor following): what happens if that
   party returns the same page forever, a page that never shrinks, a cursor
   that never advances, or a count that is wrong? Is there a bound on
   iterations, on progress, or on total size?
2. **Size before allocation.** Is every size limit checked BEFORE the data is
   read or allocated — not after the whole file or body is already in memory?
3. **Shape before use.** Is fetched or user-supplied data validated at runtime
   before it is used as a typed value? A cast is not validation — trace what a
   wrongly shaped payload does to the code that consumes it.
4. **Growth.** Does any collection grow with peer- or user-controlled input
   and no cap — accumulated pages, cache keys, queued items?
5. **What leaks out.** Does the change send internal facts to clients —
   hostnames, filesystem paths, environment values, stack traces, internal IDs
   — in responses, headers or error messages?

`NONE` when each bound holds.
