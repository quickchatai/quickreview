---
id: snappy-race-as-question
scope: pass-validate
---
## A likely race is a question, not a casualty of the budget (snappy profile)
A candidate naming a concurrency defect — a check-then-act on shared state, a read-modify-write without a lock or transaction, an unsynchronised lazy init, a missing await, two writers to one key — is often impossible to PROVE reachable from the diff alone. When your re-derivation confirms the mechanism (the two steps really are separate, nothing serialises them) but you cannot show how often it interleaves, do not kill it as speculative: keep it, mark its reachability `plausible`, and let the ordinary posting map make it a `[question]` (the reachability gate is unchanged — this only stops it dying before the gate). Under this profile's posting budget, such a question competes for a SELECTED slot like any likely defect, ahead of anything that is not a bug. Kill it only when the code shows the steps cannot interleave (a lock, a transaction, single-threaded by construction, an idempotent write).
