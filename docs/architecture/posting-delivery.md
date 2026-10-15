# Durable review delivery

A finished review is a delivery obligation, not a reason to run its lenses
again. `scripts/post-review.sh` and `scripts/approve-pr.sh` snapshot their
receipt-keyed review input **before the first GitHub read**. The snapshot lives
next to its receipt at `state/posting-receipts/pr-<n>-round-<k>.outbox.json`.
`scripts/posting-receipt.py` fsyncs the file, atomically renames it, and fsyncs
the directory. Body and inline comments survive loss of session scratch files.
Legacy unkeyed calls cannot be recovered automatically. A guard-4 refusal
(APPROVE unavailable on red or pending CI) withdraws `approve-pr.sh`'s snapshot
before the script exits — `posting-receipt.py withdraw`, only while no receipt
exists — because the session answers it with a COMMENT under the same round
key; the job is kept beside the receipts as `….outbox.json.withdrawn-<stamp>`,
a name no outbox reader picks up.

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

## Deferred postings: a 5xx on the session's own POST

When GitHub answers a receipt-keyed review POST from `post-review.sh` or
`approve-pr.sh` with a 5xx, or does not answer at all (curl's `000`), the
script first reads the PR's reviews for the round's `<!-- qcr-post:KEY -->`
marker at the expected head (`guard_marker_review` in `scripts/guards.sh`):

- **Found** — the review landed; the receipt is confirmed from it exactly as
  from a 2xx, and the script goes on as usual.
- **Not found, or unreadable** — the script hands the POST to the daemon:
  `posting-receipt.py defer` marks the outbox job (which already holds the
  exact payload) pending with `deferred_at` = the first failure, then sets the
  receipt to `deferred`. It stamps nothing (no review exists) and exits 0 with
  a message telling the session to finish its round normally; a second run of
  the script sees `deferred` and exits 0 without a POST. `approve-pr.sh` also
  skips its trigger cleanup (dispatch already consumed both triggers).

The daemon's outbox runs a deferred job on its own, bounded schedule, never on
the open-ended path above. The schedule is a state.db row
(`posting_retries`, adopted from the receipt): attempts at `[daemon]
posting_retry_offsets_min` (default 4, 12, 36) minutes after the first
failure, all inside `posting_retry_window_min` (60). Each attempt is counted in
the row before its first GitHub call (a crash never repeats one), then:

1. reads the reviews for the marker — found ⇒ confirmed, no POST; a failed
   read consumes the attempt;
2. stops (`abandoned`) if the round no longer owes the posting (cancelled —
   an operator's `u`); a new push does NOT stop it;
3. POSTs through the ONE gate with `postingRetry` set. Admission confines that
   field to a substantive `create_review` carrying the key's marker at the
   key's head, and it exempts guard 5 only: the review posts at its ORIGINAL
   commit_id. Guards 3, 1, 2 and 4 bind as on any gated review — guard 4
   softens a red-CI APPROVE to a COMMENT, and the confirmed receipt
   (`delivered_by: "daemon_retry"`) makes the verdict apply as a withheld
   approval. Dry-run suppresses it like anything else.

A refusal by a guard, a permanent 4xx, a failure on the last offset, or a due
time already past the window (one marker read, no POST) exhausts the row: the
job fails, a `posting_retry_exhausted` anomaly records why, and the verdict
watcher's posting proof reads `failed`/`exhausted`, so whichever path reaches
the round first (verdict sweep, stage limit, deadline) fails it loud — the
FAILED_LOUD hold an operator clears with `u`, its `review_failed_loud` wake and
status.json. Never a requeue: the POST was attempted.

While a deferred post is owed the PR stays `reviewing` with its round
`running` and its verdict file unapplied; `reviewed_heads` is not stamped
(the gate's after-step stamps it when the retry's POST executes). Every stage
limit, the deadline and the verdict apply read `deferred` as posting in flight
and leave the round alone, without a GitHub read of their own that could race
the retry. When the retry confirms, the round settles as a normally posted one.
The round keeps its dispatch slot for the window.

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
