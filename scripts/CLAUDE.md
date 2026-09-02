# scripts/ — the session posting route and its mirror contract

The PR sessions post to GitHub through these scripts, NOT through the daemon's
MutationGate — so every gate rule has a shell twin here, and the twins must
stay behaviourally identical to the TS side:

- `guards.sh` — sourced, never executed: the mirror of `src/guards.ts` +
  `src/cigate.ts` (human-approval downgrade, unchanged-head no-op,
  merged/closed re-check, red-CI approval refusal). Any new script that posts
  to GitHub MUST source it and call the guards before the mutation, and must
  honour dry-run (write the intent to `state/dryrun/`, send nothing).
  Coverage per script: post-review.sh guards 1+2+3, approve-pr.sh 3+4,
  reply-thread.sh 3. A guard-2 refusal in post-review.sh is RECORDED
 : `guard_on_no_new_evidence` writes a `skipped` record into the
  round's posting-receipt slot via `posting-receipt.py skip`, carrying the
  mark the guard read, so the daemon settles the round as a no-op instead of
  a lost POST. The record is never written over an attempted post and an
  attempt is never written over it; a legacy round (no `QCR_ROUND_NO`)
  records nothing and refuses exactly as before.
- Parity is test-enforced: `tests/guards-shell.test.ts` runs the real scripts
  against a loopback stub over the same cases as `tests/guards.test.ts` runs
  the gate. Change a guard on one side → change it on both + both tests.
- `mint-token.sh` is the only credential source (App JWT → installation
  token, cached, single-flight). Never a personal token, never `GH_TOKEN`.
