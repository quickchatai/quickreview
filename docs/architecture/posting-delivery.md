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
or GitHub write path exists. Every daemon delivery of an APPROVE carries a CI
pre-check (`withApprovalCiPrecheck` in `src/posting-outbox.ts`): CI that cannot
be read holds the delivery (`pr-unreadable`, no POST, retried after any wait
GitHub asked for), so an approval is never posted over unknown CI; CI the
pre-check reads not green (red, pending, or no checks under `no_checks_is_red`)
is carried forward: the delivery asks the gate for the COMMENT with the
approval withheld, the shape guard 4's softening gives, so a red read is never
lost to guard 4's own second read failing open, and a red-CI approval never
loops on a refusal. The confirmed receipt (`delivered_by: "daemon_retry"`)
makes the verdict apply as a withheld approval, as for guard 4's softening. PR state, head drift, unchanged-head
and human approval guards still apply at delivery time. The queue never changes `dry_run` and does not
automatically promote old dry-run obligations to live ones.

## Scheduling and receipt proof

- Retry schedules and attempts are persisted, not held in a timer closure.
  Exponential backoff starts at 30 seconds and caps at 15 minutes. Delivery
  debt is not exhausted by an attempt cap but by time: a job the marker read
  does not find on GitHub `posting_retry_window_min` after it was queued
  (`created_at`) fails, with a `posting_retry_exhausted` anomaly. The window
  is checked apart from when the next attempt is due, so a wait GitHub asked
  for never stretches it, and the job is failed without calling GitHub before
  that wait is over. The failed job carries `exhausted_at`, the terminal proof
  the verdict watcher's posting proof reads as `exhausted`: loud on every
  path, never a requeue. A `prepared` receipt beside it stays, so a POST that
  may have landed still reads as uncertain, never as "not posted".
- Rate limits respect `Retry-After` / rate-limit reset when the adapter can
  read them, on the POST and on the marker read alike. Network errors, 408 and
  5xx retain the obligation. Every outcome is classified once
  (`classifyGitHubFailure`). Explicit
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

## Deferred before any attempt: a read the post depends on failed

`post.approval` reads the checks at the round's head before anything is sent
(`src/postops.ts`). When that read fails after the adapter's own bounded
retries, its cause is classified once (`classifyGitHubFailure`):

- **Transient or rate-limited** (5xx, a timeout, no answer, a checks snapshot
  that kept moving): the queued job is NOT withdrawn. Under the round's lock
  `PostingJournal.deferUnattempted` writes a `deferred` receipt
  (`defer_reason: "ci-unreadable: …"`) beside the job, and never a `prepared`
  one: nothing was sent, nothing may have landed. The session is told the
  daemon owns the approval, re-reads CI before every attempt, posts the
  approval on green CI or a COMMENT with the approval withheld on red, and
  that it must not post again but finish the round normally.
- **Permanent** (a 404 or 403): blocked `pr-unreadable`, the queued approval
  withdrawn, and the message names the next step.

A gate that refuses `pr-unreadable` (guard 3 could not read the PR) on a keyed
round is deferred the same way. Refusals that end the round's posting
(`pr-merged`, `pr-closed`, `head-drift`) withdraw the queued job, so no
orphaned pending job keeps the round's posting proof waiting. A 4xx rejection
of the POST itself is a known outcome: the receipt and the job are taken back
and the session is answered `post_rejected` with GitHub's validation text, so
the corrected review posts under the same key.

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

1. reads the reviews for the marker — found ⇒ confirmed, no POST;
2. stops (`abandoned`) if the round no longer owes the posting (cancelled —
   an operator's `u`); a new push does NOT stop it;
3. POSTs through the ONE gate with `postingRetry` set. Admission confines that
   field to a substantive `create_review` carrying the key's marker at the
   key's head, and it exempts guard 5 only: the review posts at its ORIGINAL
   commit_id. Guards 3, 1, 2 and 4 bind as on any gated review. An APPROVE
   whose CI pre-check read red goes to the gate as the APPROVE, carrying the
   state it read (`approvalCiWithheld`, admitted only on a substantive
   `create_review` with a state that is not green): guard 2 reads an approval,
   and guard 4 withholds it on that state with no read of its own, posting the
   COMMENT. The confirmed receipt (`delivered_by: "daemon_retry"`) makes the
   verdict apply as a withheld approval. Dry-run suppresses it like anything
   else.

An attempt that sends no POST — a failed marker read, a delivery whose own
reads could not read the PR or its CI (`pr-unreadable`), a rate-limited POST —
does not use up one of the POST attempts (the job's `unposted_attempts`). It
moves to the next offset, past the last one at the last offsets' gap, and while
it happens the window stretches to three times `posting_retry_window_min`
(`DEFERRED_READ_WINDOW_FACTOR`), a hard ceiling. A wait GitHub asked for
(`Retry-After`, a rate-limit reset) is kept on the job as `not_before`, across
ticks and restarts, and no attempt runs before it; a wait that outlasts the
window exhausts the row at the window's end with no GitHub call. The least
gap between attempts (one minute) holds only for an attempt whose offset had
already passed when the last one ran; a configured offset still ahead is kept.

A deferral the session's post made before any attempt (`deferUnattempted`)
writes the job, then the receipt. A stop between the two leaves a job with
`deferred_at` and no receipt; the outbox finishes that handoff by writing the
deferred receipt, so the retry delivers or exhausts on its bounded schedule.

A refusal by a guard, a permanent 4xx, a POST failure with the POST attempts
spent, the ceiling reached with reads still failing, or a due time already past
the window (one marker read, no POST) exhausts the row: the
job fails, a `posting_retry_exhausted` anomaly records why, and the verdict
watcher's posting proof reads `failed`/`exhausted`, so whichever path reaches
the round first (verdict sweep, stage limit, deadline) fails it loud — the
FAILED_LOUD hold an operator clears with `u`, its `review_failed_loud` wake and
status.json. Never a requeue: a POST may have been sent (by the session, or
by the retry after a deferral made before any attempt), and the anomaly's
detail says whether the last attempt sent one ("no POST sent").

While a deferred post is owed the PR stays `reviewing` with its round
`running` and its verdict file unapplied; `reviewed_heads` is not stamped
(the gate's after-step stamps it when the retry's POST executes). Every stage
limit, the deadline and the verdict apply read `deferred` as posting in flight
and leave the round alone, without a GitHub read of their own that could race
the retry. When the retry confirms, the round settles as a normally posted one.
The round keeps its dispatch slot for the window.

## Thread replies (`post.reply`)

A session's thread reply (`scripts/reply-thread.sh`) carries a hidden marker,
`<!-- qcr:reply=<pr>:<comment>:<sha8 of body> -->`, and is never posted
blind. `src/postops.ts` reads the PR's review comments for that marker before
every POST; a reply found there answers "already posted". Two requests for
the same reply at once share one owner in the daemon: the second joins the
first and gets its answer, so the read and the POST are never run twice.

A POST GitHub did not answer (no response, a 5xx, a rate limit) is uncertain,
not failed: it may still land. The daemon records the attempt beside the PR's
receipts (`pr-<n>-reply-<hash>.json`) before the POST, and a later run of the
same reply posts again only after the quiet window (two minutes) and two
reads, at least 30 seconds apart, that both find it absent, as the review
outbox does. A read that fails before any POST sends nothing and says so: the
session runs the script again later, and the marker read comes first. A
refused POST (a 4xx) is a known outcome and clears the record.

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
