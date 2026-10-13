# Durable review delivery

A finished review is a delivery obligation, not a reason to run its lenses
again. `scripts/post-review.sh` and `scripts/approve-pr.sh` snapshot their
receipt-keyed review input **before the first GitHub read**. The snapshot lives
next to its receipt at `state/posting-receipts/pr-<n>-round-<k>.outbox.json`.
`scripts/posting-receipt.py` fsyncs the file, atomically renames it, and fsyncs
the directory. Body and inline comments survive loss of session scratch files.
Legacy unkeyed calls cannot be recovered automatically.

`src/posting-outbox.ts` processes due obligations independently of reconcile,
round dispatch and model sessions. `src/daemon.ts` ticks it on startup and every
15 seconds; `src/wire.ts` supplies the existing `GitHubAdapter.createReview`
route through `MutationGate`. No new mutation kind, guard exemption, session,
or GitHub write path exists. An approval retains the shell route's green-CI
precondition. PR state, head drift, unchanged-head and human approval guards
still apply at delivery time. The queue never changes `dry_run` and does not
automatically promote old dry-run obligations to live ones.

## Scheduling and receipt proof

- Retry schedules and attempts are persisted, not held in a timer closure.
  Exponential backoff starts at 30 seconds and caps at 15 minutes. Delivery
  debt is **not exhausted by an attempt cap**.
- Rate limits respect `Retry-After` / rate-limit reset when the adapter can
  read them. Network errors, 408 and 5xx retain the obligation. Explicit
  permission, authentication or validation rejection fails visibly instead
  of retrying forever. Closed/superseded/head-moved jobs are not sent.
- All retries first read the **complete** review list and reconcile the exact
  posting marker, head and configured bot identity. An unreadable list is
  unknown, never permission to repost. Multiple matching reviews or corrupt
  receipts fail closed.
- A confirmed response or matching GitHub review durably writes the same
  confirmed receipt the verdict watcher already understands. Receipt
  confirmation precedes marking the outbox done, so interruption between those
  writes is recoverable without another POST.
- After an ambiguous attempt, automatic resend requires the original poster's
  lock to be released, at least two minutes of quiet, and two complete negative
  marker reads separated by at least 30 seconds. REST and shell transports are
  bounded at 60 seconds. Only an aged lock with a dead owner (PID, process start
  and boot identity), or aged interrupted owner initialization, is reclaimed.

**Exactly-once is not a GitHub API guarantee.** A posting marker is duplicate
reconciliation, not a server-enforced idempotency key. The quiet window and
separated reads protect ordinary response-loss and transient outage scenarios;
an exceptionally delayed GitHub acceptance/visibility beyond these windows
can still make a resend duplicate. We do not claim that finite negative reads
prove a distributed POST was never accepted.

## Lifecycle and visibility

`src/verdicts.ts` leaves a pending outbox's round and verdict waiting beyond
posting grace, stage limits and the round deadline. It does not fail posting
proof merely because GitHub is down. When delivery succeeds, ordinary receipt
settlement applies the verdict, including its existing missing-tail handling.
Permanent delivery failures release that wait into the existing loud failure
path; nothing claims completion without posting proof.

The board detail shows **POSTING PENDING**, attempts, next retry and the latest
error from the status snapshot. `posting_delivery` events audit delivery
progress. A GitHub outage alone requires no operator retry or new review round.
Already-failed historical rounds are not retroactively reconstructed: no
replayable payload was retained for them.

## Regression seams

- `tests/posting-outbox.test.ts`: 503 recovery, response-loss reconciliation,
  outage beyond deadline, persisted rate-limit backoff, ownership, stale input,
  corrupt receipts/payload, permanent errors and mode isolation.
- `tests/guards-shell-receipts.test.ts`: snapshot before guard reads, receipt
  checks under lock, dry-run completion and confirmed replay.
- `tests/receipt-aware-finalize.test.ts`: real supervisor and verdict watcher
  keep pending delivery alive beyond stage limits/deadline, then settle without
  another round.
- `tests/tui-board.test.ts`: pending delivery renders even before detail loads.
