# scripts/ — the session posting route and its mirror contract

The PR sessions post to GitHub through these scripts, NOT through the daemon's
MutationGate — so every gate rule has a shell twin here, and the twins must
stay behaviourally identical to the TS side:

- `guards.sh` — sourced, never executed: the mirror of `src/guards.ts` +
  `src/cigate.ts` (guard 1 human-approval downgrade, guard 2 unchanged-head
  no-op, guard 3 merged/closed re-check, guard 4 red-CI approval refusal,
  guard 5 the stale-head refusal — the round must still be posting about the
  sha it reviewed). Any new script that posts to GitHub MUST source it and
  call the guards before the mutation, and must honour dry-run (write the intent to `state/dryrun/`, send nothing).
  Coverage per script: post-review.sh guards 1+2+3+5, approve-pr.sh 3+4+5,
  reply-thread.sh 3 — and that sentence is DERIVED from the call sites by
  `tests/fences-guards.test.ts` [T10] rather than trusted, so it cannot drift
  from what the scripts do. A guard-2 refusal in post-review.sh is RECORDED:
  `guard_on_no_new_evidence` writes a `skipped` record into the round's
  posting-receipt slot via `posting-receipt.py skip`, carrying the
  mark the guard read, so the daemon settles the round as a no-op instead of
  a lost POST. The record is never written over an attempted post and an
  attempt is never written over it; a legacy round (no `QCR_ROUND_NO`)
  records nothing and refuses exactly as before. A guard-4 refusal in
  approve-pr.sh WITHDRAWS the delivery snapshot the script queued before the
  guard read: `guard_on_approval_refused` runs `posting-receipt.py withdraw`,
  which renames the pending outbox job aside only while no receipt exists, so
  the session's COMMENT under the same round key is accepted and the outbox
  never delivers the refused approval.
- **On a daemon-run host the three posting scripts are a thin client.** With
  `QCR_IPC_SOCKET` and `QCR_IPC_CAP_FD` in env (round worker, answer worker,
  debug pi) `post-review.sh`, `approve-pr.sh` and `reply-thread.sh` `exec` the
  Node client `dist/src/ipc/postshim.js` before reading any config: it names
  the result files and the daemon (`src/postops.ts`) validates the paths,
  builds the intent and posts through the one gate with the receipt and
  outbox. Everything below that branch is the legacy tmux route, which P9.3
  deletes with `guards.sh`.
- Parity is test-enforced: `tests/guards-shell-*.test.ts` runs the real scripts
  against a loopback stub over the same cases as `tests/guards.test.ts` runs
  the gate. Change a guard on one side → change it on both + both tests.
- `mint-token.sh` is the only credential source (App JWT → installation
  token, cached, single-flight). Never a personal token, never `GH_TOKEN`.
- `commit-verdict.sh` is sanctioned for sessions but posts nothing: it
  publishes a staged `verdict/<name>.tmp` onto `verdict/<name>` by
  one rename after checking it is one whole JSON object, so the daemon never
  reads a half-written verdict. It accepts only the two verdict-file name
  shapes and writes nothing outside `verdict/`; `mv` itself stays off the
  bash guard's allowlist.
