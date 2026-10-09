# The review lifecycle, end to end

How one pull request travels from "someone asked for a review" to "a verdict is
posted, and the PR keeps being watched afterwards".

Everything in this document is daemon code — deterministic TypeScript, no model
in the loop. The model runs inside the per-PR session, which the daemon only
*nudges*; where the session boundary sits is described in
[single-shepherd-invariant.md](../single-shepherd-invariant.md).

## Where to look

| Concern | Module |
| --- | --- |
| Webhook receipt, signature, event interpretation | `src/webhook.ts` |
| The authoritative poll that rebuilds truth from GitHub | `src/reconcile.ts` |
| PR states and the transition table | `src/statemachine.ts` |
| Reading "what review currently stands" off a mark | `src/standing-review.ts` |
| FIFO pump, round order, worktree, pre-checks | `src/dispatch.ts` |
| Lens selection and pass tiers (pure functions) | `src/heuristics.ts` |
| The daemon↔session contract and prompt receipts | `src/types.ts` |
| Verdict file consumption, anomalies, self-requeue | `src/verdicts.ts` |
| Post-approval recheck + the trivial-delta classifier | `src/recheck.ts` |
| Author-reply exchanges | `src/pingpong.ts` |
| Blocked author's PR-level objections and answers | `src/pr-conversation.ts` |
| Holding wakes while a round is in flight | `src/wakes.ts` |
| Posting-time guards, "new evidence" test | `src/guards.ts` |
| CI gate and withheld approvals | `src/cigate.ts` |
| Optional escalation notes (off by default) | `src/escalation.ts` |
| Every GitHub write | `src/gate.ts` |
| Production assembly of all of the above | `src/wire.ts`, `src/daemon.ts` |

## 1. The trigger set

A PR is reviewed only when someone asks. Two asks count, and their union is the
triggered set:

- the trigger label is applied (`[github] trigger_label` in
  `config.example.toml`);
- a review is requested from the configured review team (`[github]
  review_team`).

`src/webhook.ts interpretPullRequest` turns the `labeled` and `review_requested`
actions into a `trigger` interpretation, and rejects everything else — an
individual (non-team) review request, a different label, a different team.
Bot-authored PRs never enter the machine at all (`isBotUser` in `webhook.ts`,
`isBotAuthor` in `src/statemachine.ts`), so the system cannot review its own
improvement PRs.

A push (`synchronize`) is explicitly **not** a trigger: `applyInterpretation`
refreshes metadata and logs the push instant, then hands the event to the
post-approval recheck path (§7). Opening a PR is not a trigger either.

Both triggers are *consumed* at dispatch — the label is removed and the team
review request is deleted through the gated adapter (`consumeTriggers` in
`src/dispatch.ts`) — so a completed round leaves nothing that would re-queue the
PR forever. A consume target that is already gone comes back as a 404 and counts
as consumed.

## 2. The state machine

States live on the PR row (`PrLifecycleState` in `src/state.ts`) and are moved
only by the pure `transition()` in `src/statemachine.ts`:

| State | Meaning |
| --- | --- |
| `tracked` | known, nothing owed — this includes "reviewed and approved" |
| `queued` | a trigger is outstanding, waiting for a dispatch slot |
| `reviewing` | a round is running; the trigger has already been consumed |
| `awaiting_author` | REQUEST_CHANGES stands; the author owes a push or a reply |
| `closed` | merged or closed; session archived, worktree dropped |

There is no "awaiting a human" state. The review is never handed to a person:
sessions always decide on the merits and put residual doubt into a
`### For a human to double-check` section plus inline `[check this]` comments
(grammar in `src/severity.ts`). Nothing in `transition()` can produce a park.

The transition table, as the code implements it:

| event \ current | tracked | queued | reviewing | awaiting_author | closed |
| --- | --- | --- | --- | --- | --- |
| `track` | tracked | queued | reviewing | awaiting_author | closed |
| `trigger` | queued | queued | reviewing ¹ | queued | closed |
| `stale_detected` | queued | queued | reviewing ¹ | queued | closed |
| `dispatched` | reviewing | reviewing | reviewing | reviewing | closed ² |
| `verdict` APPROVE | tracked | tracked | tracked | tracked | closed |
| `verdict` REQUEST_CHANGES | awaiting_author | awaiting_author | awaiting_author | awaiting_author | closed |
| `verdict` NEEDS_HUMAN ³ | tracked | tracked | tracked | tracked | closed |
| `round_overdue` | standing ⁴ | standing ⁴ | standing ⁴ | standing ⁴ | closed |
| `author_reply` | tracked | queued | reviewing | awaiting_author | closed |
| `synchronize` | tracked | queued | reviewing | awaiting_author | closed |
| `human_requested` | tracked | queued | reviewing | awaiting_author | closed |
| `closed` | closed | closed | closed | closed | closed |
| `reopened` | tracked | queued | reviewing | awaiting_author | tracked |

¹ A trigger arriving mid-round is not lost — the running round covers the
current head, and reconcile re-derives the triggered set afterwards. If the head
advanced, a durable *successor* obligation is recorded
(`store.recordSuccessor`).
² `closed` is terminal until a `reopened` event; dispatch filters on `queued`
anyway.
³ A legacy input spelling only (`normalizeVerdict` in `src/types.ts` also folds
the older `ESCALATE` into it). It means "review posted, no approval implied" and
the machine lands it on `tracked`.
⁴ A blown or malformed round returns the PR to the state its *standing* verdict
implies — REQUEST_CHANGES ⇒ `awaiting_author`, otherwise `tracked`. Never an
approval.

`applyEvent()` wraps `transition()` with the bookkeeping: it upserts the row,
maintains `stale_recheck` and `trigger_ts` (both cleared on `dispatched`,
`verdict` and `round_overdue`, so a settled PR carries no trigger residue),
stamps trigger *provenance* (`human` for a fresh label / team re-request /
manual ask or an author reply on a queued PR; `system` for reconcile
re-derivation and staleness), records successors, and logs a `pr_transition`
event.

### Reading what review stands

`reviewed_heads` rows are written in two steps by two writers: the shell posting
route stamps `head_sha` and `posted_event` the moment a review reaches GitHub;
the verdict watcher later enriches the same row with `verdict` and `round_no`.
A crash between the two leaves a substantive row with a null `verdict`.

`src/standing-review.ts` is the single interpretation every lifecycle consumer
uses, in this order:

1. a decided `verdict` wins (normalized);
2. `NEEDS_HUMAN`/`ESCALATE` is **undecided** — it never suppresses a re-run or
   a posting;
3. with no decided verdict, `posted_event` of exactly `APPROVE` or
   `REQUEST_CHANGES` is the same substantive review before enrichment;
4. `posted_event` `COMMENT` alone proves something was posted and nothing about
   what was decided — it is never guessed into a verdict.

`standingLifecycleState()` maps a decided verdict onto the state a restore
returns to, and `restoreStandingLifecycle()` in `src/statemachine.ts` replays it
through the ordinary `verdict` event so a restore can never reach a state a
verdict could not.

## 3. Reconcile is the authority

GitHub never redelivers a failed webhook, so the webhook path is only the fast
one. Every `[daemon] poll_interval_s` (300 in `config.example.toml`) and on
startup, `reconcileOnce()` in `src/reconcile.ts` rebuilds the truth from the API
and forces local state to match. **GitHub always wins**, and every divergence is
logged as a `reconcile_correction` event — a rising correction rate is the
webhook-health signal.

The pass runs as independent steps, each wrapped so one bad PR or flaky call
cannot stall the daemon (failures land in `report.errors`):

1. **open-PR truth** — title/head sync, reopen where GitHub says open;
   fires the push recheck (§7) and its lost-recheck backstop.
2. **triggered-set derivation** — both searches (label, team), with durable
   per-kind level observations so a *remove → re-add* reads as a fresh human
   edge even when its webhook was lost.
3. **successor obligations** — promote durable fresh-head work whose
   predecessor round became terminal.
4. **undelivered recheck-claim sweep** — releases a recheck claim whose prompt
   receipt provably never landed (§8).
5. **stale-trigger residue sweep** — a settled PR carrying `stale_recheck` or a
   `trigger_ts` with no round running is cleaned, so the next explicit
   re-review is not misclassified as a staleness round and cannot jump the FIFO
   on an ancient timestamp.
6. **closed-sync** — locally-live PRs GitHub no longer lists as open.
7. **withheld-approval backstop** — retries an approval withheld for red CI
   (§6).
8. **bot-comment registry backfill** and **human-comment capture sweep** —
   bounded to `COMMENT_SWEEP_MAX_PRS` (25) PRs per pass, freshest first. The
   sweep's read also carries the bot's OWN inline comments; it hands them to
   the outcome capture instead of discarding them (S6).
9. **outcome capture** (`src/outcomes.ts`, S6) — links each posted
   comment to its finding and records each posted finding's fate (fixed,
   refuted and conceded, upheld after a reply, open at close, unknown) from
   state.db and the base clone's git alone. Open PRs and PRs closed in the last
   day, at most 25 a pass and no new one past 10 s, an unmoved PR skipped. Read-only and outside
   `report.errors`: it is bookkeeping, and the pass's health never waits on it.

`reconcileOrphanedRounds()` runs at startup: a round whose tmux session did not
survive a restart is cancelled with the quiet `orphan_sweep` cause and the PR is
requeued (or its recorded successor head promoted).

## 4. Dispatch: FIFO, and the round order

`dispatchOnce()` in `src/dispatch.ts` is the pump. One pump runs at a time per
store; it starts nothing while a deploy drain is on.

**Ordering.** `queuedInOrder()` sorts `queued`, non-paused PRs by `trigger_ts`
(nulls last, then PR number). `capacity()` is
`daemon.max_concurrent_rounds - runningRounds()` (12 by default). A PR is
skipped when it holds an open review failure, has a blocking session command, or
has held wakes that must drain first — and one PR is one worktree, so a PR with
a round already running never gets a second.

**Two short-circuits, before spending anything.**

- *No new evidence.* With `[guards] skip_unchanged_head`, a re-trigger at a head
  that is already reviewed with no author reply since consumes the triggers,
  posts nothing, and restores the standing lifecycle. This uses exactly the test
  posting guard 2 uses (`hasNewEvidence` in `src/guards.ts`) read through
  `standing-review.ts`, so dispatch and the posting guard can never disagree —
  the failure this prevents is paying for a full round whose review the guard is
  guaranteed to refuse. A mark that cannot be read (`kind: "unknown"`) skips the
  round too, but raises a `standing_review_unknown` anomaly rather than
  inventing a verdict.
- *Trivial system re-trigger.* A `system`-provenance re-trigger on a PR with a
  decided standing verdict runs the delta classifier (§7) against the reviewed
  head first; an empty or trivial delta consumes the trigger and upholds. A
  fresh human ask always gets its round; a first review never short-circuits.

**Building the round.** For a PR that survives both:

1. consume both triggers and add the in-progress label;
2. read `base_ref` and the PR body in one `getPr`, and the changed files once;
3. plan the passes (`buildPassPlan`) and open the round row
   (`store.startRound`) with the diffstat, the plan and the validator tier;
4. **prepare the worktree before building the order** — fetch the PR head and
   the base branch, so the prompt cites the sha the passes actually read; a
   difference from the row's head is logged as `head_drift`;
5. take the round integrity fingerprint (`src/execboundary.ts`, see
   [exec-boundary.md](../exec-boundary.md));
6. run the ecosystem pre-check — for the Django ecosystem, migration-number
   collisions against the base tip, delivered as a gated **COMMENT**, never a
   blocker. A *degraded* pre-check is never quieter than none: the prompt tells
   the session to check collisions itself and an anomaly is raised;
7. detect first-party agent-directive edits and pick the one teammate an
   @-mention comment will name;
8. build the `RoundOrder`, seed the round's memory (one bounded call — a
   memory outage costs a memory-less prompt, never a round), and hand the
   rendered prompt to the session via `hooks.dispatchRound`;
9. only then stamp the prompt receipt marker, set the gates, apply
   `dispatched`, and log `round_dispatched`.

The round is provisional until that handoff completes: if anything before it
throws, the round row is discarded rather than left orphaned. If the durable
session command was already persisted, the round is *retained* instead and the
bounded supervisor owns its recovery.

### Lens selection and tiers

`selectLenses()` in `src/heuristics.ts` is a pure function of the changed-file
shape. `pass-baseline` always runs; the conditional lenses key on paths and on
added-line content signals — UI extensions, serializer/schema/integration dirs,
migrations and raw SQL, auth/secret/dependency-manifest shapes, in-process state
smells, infra and workflow files, webhook/task/queue dirs. Three judgment lenses
have their own thresholds: `pass-placement` (a new or moved code file of ≥ 30
added lines, or ≥ 8 code files — the `default` review preset; `max` restores
any new file / ≥ 4 files),
`pass-simplicity` (≥ 150 code lines, deep added indentation, or a file gaining
≥ 5 branches) and `pass-backcompat` (wire/API/queue/migration/feature-flag
surfaces).

`pass-intent` is the exception: it keys on the PR body, not on files. Its
artifact is the title and body only, and it is selected only when the body
clears a substance bar of `INTENT_MIN_SUBSTANCE_WORDS` (60; 20 under the `max`
preset) words of real prose
after template comments, code and links are stripped — below that the lens's
only honest output is NONE, so it is never dispatched.

Two lenses are deliberately **addable-only** and are never selected by shape:
`pass-concurrency` and `pass-ask-human`. A read-modify-write race has no
filename, and neither does a question nobody wrote down; the session adds them
through the round's add protocol once it has read the diff.

`buildPassPlan()` turns lenses into agents named `${lens}--${tier}`. Risk passes
(`[models] risk_passes`) are pinned at the top tier; `pass-intent` starts at the
cheapest; everything else takes `passTier()` (small quiet diffs start low, a
migration or a diff at/over `small_diff_lines` starts higher) and may be raised
by the session. `pass-validate` always runs last, at `validatorTier()` — the
configured `validate_tier` is a **floor**, raised to the highest lens tier in
the round, because a cheaper model must never veto a more expensive one's
finding. Lenses not planned are offered as `addable_lenses`.

The plan's rows are listed in **launch order, slowest first** (`slowestFirst`,
). The session launches a turn's rows in table order and the subagent
glue runs them under a process-wide cap (`[pi] subagent_max_concurrency`) in
that order, so a 15–27 row plan runs in waves, and a slow row listed late
started in the last wave and set the round's critical path. The order:
`pass-baseline`; then by tier, highest first; within a tier the risk passes,
the focused rows (`pass-behaviour-delta`, then `pass-sweep`) by the changed
lines their focus covers, larger first, every other lens, and the cheap
conditional lenses (intent, the quality lenses, style, lint conformance);
`pass-validate` last. Only the order moves: the rows, their tiers and focus
and the addable list are unchanged, and every consumer that indexes rows —
the task files' numbering, the order's `lenses`, lesson rows, the recorded
`pass_plan` — reads the one ordered array. A follow-up round's carried
`pass-data-safety` row is ordered the same way. The cap itself is not touched
by this.

### The round order and its receipt

`RoundOrder` in `src/types.ts` is the daemon↔session contract: pass plan,
addable lenses, gates, migration collisions, the head/base/merge-base shas the
worktree is actually at, the worktree path, the PR body when the intent lens is
planned, the settled digest carried from the last verdict, and an optional
`escalation_targets` (§9).

A delivered prompt is a **receipt, never an inference**. `roundPromptMarker(pr,
roundNo)` renders an inert HTML comment appended to the prompt by
`stampRoundPrompt()`; the agent echoes it into its session transcript only when
it *accepted* the message. `SessionHooks.roundPromptAccepted()` reads it back:
present means delivered, absent means never arrived, `null` means "cannot tell"
and is never read as loss. `recheckPromptMarker(pr, fingerprint)` is the same
device for a recheck nudge, keyed on the fingerprint the claim is keyed on.

## 5. Verdict consumption

The session writes `verdict/pr-<n>-round-<k>.json` (the directory is
`<root>/verdict`, wired in `src/daemon.ts`). `VerdictWatcher` in
`src/verdicts.ts` watches the directory and sweeps it; the daemon owns
everything that touches GitHub from there. The round templates tell the
session never to write that name in place: it stages the complete JSON at
`verdict/<name>.tmp` and publishes it with `scripts/commit-verdict.sh`, which
checks it is one whole JSON object and renames it onto the name in one step
(H1a, #5885). The watcher never reads a `.tmp`.

`validateVerdict()` is deliberately tolerant of model-written JSON: digit
strings coerce to numbers, `ESCALATE` folds to `NEEDS_HUMAN`, the self-reported
`spend_usd` is dropped outright (real cost is measured from the session
transcripts), and malformed `passes` or `escalations` degrade to "unknown"
rather than rejecting the verdict they ride on. An UNPARSEABLE file is treated
as still being written while its bytes are moving — by its mtime, or between the
watcher's own looks — and is re-read with backoff (`src/settledread.ts`): it is
called malformed only once it has sat unchanged for 3 s across several looks,
or after a 30 s hard window. A file that parses is complete and its shape is
judged at once. (#5885: the session's in-place write left the file empty for
longer than the old 3 × 40 ms tolerance on a CPU-starved container, and a valid
APPROVE was read as "Unexpected end of JSON input".) The recheck outcome file
is read the same way.

`apply()` then, in order: checks the posting receipt, moves the labels, finishes
the round row, records executed-pass telemetry, applies the `verdict` event,
stamps the reviewed-head mark, records or clears the withheld-approval mark,
announces, settles or promotes a successor head, fixes the usage window, delivers
any escalations (§9), requests the session's compaction, schedules — after a
settle delay — the ledger-freshness and findings-record checks, flushes held
wakes (§8), and LAST measures usage over the fixed window.

Finishing the round row is a CLAIM: it lands only while the round still has the
status `apply` read before it awaited anything (the posting proof, the label
calls). An operator's `u` or another terminal path that landed meanwhile stands,
and the apply stops there (`verdict_apply_claim_lost`). The measurement is OWED
from the moment its window is fixed (`rounds.usage_owed_to`), in the same turn
as `verdict_settled`, until it has finished: a restart while it runs — a
deploy's drain sees no running round by then — is resumed at the next start
over the stored window (`round_usage_resumed`; the integrity re-check is
recorded `interrupted`, never re-run against a surface the deploy rewrote), and
a window older than 12 h is recorded UNKNOWN rather than re-read. Every
round-end path owes its measurement the same way. The verdict sweep's paths and
the anomaly path await it; the round-stage supervisor's and the deadline tick's
settlements hand it to the background, so one PR's accounting never holds the
supervisor's serialized scan.

Three endings are not ordinary verdicts:

- **`outcome: "head_moved"`** — the session was refused at posting time because
  the PR advanced mid-round, and said so explicitly instead of idling to the
  deadline. The round is cancelled and self-requeued against the fresh head; the
  session is healthy and is *not* killed; no verdict, no label, no reviewed-head
  mark.
- **`NEEDS_HUMAN` with no executed passes** — the review was not actually done,
  so the round is redone through the same capped self-requeue rather than
  landing an undecided mark.
- **A guard-2 refusal at posting time** — the review was never published, so the
  verdict in the file is never applied; the round settles as a terminal
  no-new-evidence round rather than failing loud.

Malformed files and rounds that blow `[daemon] round_deadline_min` route to
`handleAnomaly()`: the round is marked, the overseer is injected, and the PR
returns to its standing state. **There is no anomaly path that approves.**

**Except when the review is already on GitHub** (H1a). A malformed
verdict file, a round that reaches its deadline with no verdict file, and a
session that settles without writing one are first checked against the round's
posting receipt. A CONFIRMED receipt that proves the decision settles the round
from the receipt rather than failing it (`decidedVerdictFromReceipt`):
REQUEST_CHANGES asked for (whatever guard 1 softened it to) is REQUEST_CHANGES;
APPROVE posted is APPROVE; and a COMMENT the session asked for is the round
templates' withheld-approval shape — the only COMMENT they tell a session to
post — so it is APPROVE with `approval_withheld`, which records the withheld
mark and lets CI turning green re-queue the PR for the session to decide again
(it can never approve anything by itself). The round is applied through the
same `apply()` as a verdict file, its summary saying where the verdict came
from; no FAILED_LOUD is opened and nothing is re-run, because a rerun would post
a second review. A receipt that does not prove the decision — one the daemon
only reconciled from GitHub's marker (its `intended_event` is just the posted
event), or a pairing no posting script writes — keeps the loud path it always
had, as does a missing or ambiguous receipt. A guard-2 `skipped` record settles
as the no-op. A verdict file that lands after any of these settlements
replays inertly, and a settlement a restart cut short (the round finished, the
rest of the apply not) is resumed from its own `verdict_settled_from_receipt`
event, which carries the verdict it was applying — by the malformed file still
in `verdict/`, or by the sweep when there is no file.

`checkDeadlines()` also cancels a round superseded by a newer one, and runs the
lost-prompt net well before the deadline: if the inject was consumed, nothing is
pending in the bridge, no verdict is on disk and the receipt proves the prompt
was never accepted, the round is requeued — a missing prompt is a *delivery*
fault, so redelivery of the exact dispatched bytes comes before anything
expensive. Every requeue draws on the `[daemon] max_self_requeues` budget per
head; exhausting it ends in a loud failure and an operator unwedge, never a
loop.

## 6. CI and withheld approvals

`src/cigate.ts` classifies the checks at a head, collapsing to the most recent
run of each check name. With `[guards] block_approve_on_red_ci`, an approval at
a head that is not green is **withheld**: the review posts as a COMMENT and a
withheld-approval mark is recorded. `retryWithheldApproval()` re-reads the
checks when CI completes and on the reconcile backstop, and re-queues the PR
once the head goes green. Unreadable CI is not evidence of anything — the mark
simply stands.

A withheld approval **carries forward** to a new head when a recheck upholds
(`carryWithheldMark` in `src/recheck.ts`, and the equivalent on dispatch's
short-circuit). That is not a re-approval: nothing was ever posted, and green CI
at the new head is still required before anything does.

## 7. Post-approval recheck

Once a PR is approved, `src/recheck.ts` keeps looking at it. The shape is:

```
trigger ──► planRecheck() ──► no-op (uphold; nothing posted, nothing spent)
                          └─► one nudge to the PR's OWN sticky session
```

Four triggers: a push after an approve, CI completing at the approved head, the
base branch advancing, and an author reply. The author reply is deliberately a
no-op here — `src/pingpong.ts` owns that path end to end (§8).

**The trivial-delta classifier** is what makes a broad trigger set affordable.
`classifyDelta()` narrowly recognises files not worth re-reviewing —
`base-merge` (a file this PR does not own, i.e. it arrived from the base
branch), `migration-renumber`, `pure-rename`, `version-bump` (lockfiles and
version-only manifest edits), `formatting`, `no-content-change` — and anything a
rule does not positively recognise is **significant**. A hand-resolved merge
conflict beats every trivial rule, wherever the file lives: a clean base merge
is identical to git's own auto-merge and stays a no-op, but a resolution is a
decision, and the session is asked to audit each resolved file against *both*
merge parents. A degraded merge check keeps the delta-only classification but is
logged, never silently quieter.

`planRecheck()` is pure and ordered cheapest-refusal-first: the author reply
returns immediately; anything but a standing APPROVE returns
`no-standing-approval`; an unchanged head with no adverse CI returns
`unchanged-head`; then, and only then, is the delta classified. Empty and
trivial deltas are no-ops. Everything else produces one nudge.

**Two invariants are structural.** The path is planned only from a standing
APPROVE, and the decision file accepts exactly two outcomes — `uphold` and
`request_changes`. Anything else, including a literal `APPROVE`, is coerced to
`uphold` and logged (`validateRecheckDecision`). So a recheck can never
re-approve and can never park. And no GitHub write lives in this module at all:
it reads, and the session posts through the gated route.

The session answers in `verdict/pr-<n>-recheck-<head12>.json` — staged and
published with `scripts/commit-verdict.sh`, like the round verdict. `uphold` posts
nothing and carries a withheld mark forward; `request_changes` clears the
withheld mark and applies a `REQUEST_CHANGES` verdict event, moving the PR to
`awaiting_author`.

`runBaseAdvance()` fans a base-branch move out only to open PRs that target that
branch and hold a standing approval; every other PR is skipped without an API
call.

## 8. Ping-pong, wake holding and self-requeue

**Ping-pong.** When an author replies in one of the bot's threads, the daemon
wakes the PR's session with the thread context and the session posts exactly one
reply through the gate. The mechanical halves are enforced in SQLite by
`PingPongLedger` (`src/pingpong.ts`): `claimAuthorMessage()` is an insert-or-
ignore on the comment id, so a duplicate delivery or a reconcile replay can
never produce a second reply, and `MAX_EXCHANGES_PER_FINDING` (3) caps a thread
before it must concede or hold. The judgment halves are prompt-side and are
restated in every wake message, because a compacted session may no longer hold
them verbatim. The session answers with a thread decision file
(`pr-<n>-thread-<t>-comment-<c>.json`); `ThreadDecisionWatcher` treats that
output as untrusted — ids must match a claimed author message, and the adapter
independently verifies bot ownership before resolving anything.

**PR-level author objections.** While a substantive bot REQUEST_CHANGES stands
on a tracked open PR, an ordinary, nonempty top-level comment from that PR's
verified author is also delivered to its main session. No @mention is needed.
Other conversation stays silent; bots and `[feedback]` remain excluded. This is
an answer obligation, not a review trigger (`PrConversation`,
`src/pr-conversation.ts`). The session must check the objection against base
and current code and explicitly concede, uphold with evidence, or explain what
is missing. The daemon validates a claimed
`pr-<n>-conversation-comment-<c>.json` answer and posts it as an ordinary gated
`create_issue_comment`, with current-PR-state guards and dry-run unchanged.
There is no invented inline thread to resolve. An answer never clears a
standing verdict or automatically requests another review.

SQLite preserves each obligation independently of the held-wake queue. Failed
injections are held; missing answers may be redelivered after five minutes only
when the PR session is idle and no copy is held. Three unsuccessful deliveries
or posting attempts leave a retained failed obligation and an anomaly, not
unbounded retry. Before posting, the daemon reads the conversation for the
exact bot answer and its per-comment marker, so an interrupted successful POST
is recovered rather than duplicated; an unreadable or truncated list cannot
license a blind repost. A separate bounded capture-recovery step admits only
untagged verified-author comments from the last 24 hours, posted after a
proven blocking review. Completed round history retains that proof when a later
review re-stamps the current head; pre-review chatter is excluded before the
recovery batch limit. A late valid answer can satisfy a delivery-exhausted
obligation without another injection; a posting-exhausted answer is not
silently replayed. Capture itself still never routes or wakes anything.
Recent accepted objections and answers are included as quoted evidence in a
later explicitly requested round, including across session restart.

**Held wakes.** A PR has exactly one main session that owns rounds *and* author
exchanges, so two instructions in flight at once is a topology violation, not a
scheduling detail. `wakeOrHold()` in `src/wakes.ts` injects when the PR has no
running round and no blocking session command, and otherwise persists the wake
in `pending_wakes`. `flushHeldWakes()` drains them oldest-first with durable
lease → deliver → ack semantics; a contiguous burst of author replies is
coalesced into one delivery unit so the session handles every distinct response
obligation in one run (at most `MAX_AUTHOR_REPLIES_PER_DELIVERY`, 10, per run;
a longer backlog goes in several). Nothing is dropped silently: the per-PR cap
(`MAX_HELD_WAKES`, 5) bounds the ORDINARY wakes and logs what it evicts
(`wake_dropped` names the evicted reasons), and a failed delivery releases the
whole oldest unit and stops so later messages never overtake it. Since
H1b the cap **never evicts an author reply** — its comment is claimed before it
is held and nothing raises a claimed comment again, so 76 evicted replies went
unanswered between 10-05 and 10-08 — nor an operator-recovered or leased row;
author replies are not counted against it either. Push recheck nudges go
first (oldest first) — the one class a sweep re-raises: the reconcile push
backstop asks the question again once the claim is released; then every other
ordinary wake, oldest first, ci and base-advance rechecks among them. Every
evicted recheck releases its claim as it goes (`recheck_claim_released_evicted`,
`re_raised_by` naming the backstop or null); a ci or base-advance recheck has
no sweep — only an identical webhook asks it again — so its eviction also
records the quiet anomaly `recheck_wake_dropped`. A dropped author reply,
should a later change ever make one possible, is the WAKE anomaly
`author_reply_wake_dropped`.

**Self-requeue.** Round-level recovery lives in `src/verdicts.ts selfRequeue()`
and covers a dead session, a live-but-wedged session (killed first, then
rebirthed), a lost prompt, a `head_moved` ending, an infrastructure stage
failure, and a `NEEDS_HUMAN` with no passes. Every mode is bounded by
`[daemon] max_self_requeues` per head; prompt *redelivery* is bounded
separately by `[daemon] max_prompt_redeliveries`, because re-sending the exact
bytes to a live session is far cheaper than cancelling a round. A live session
with no order is idle, not wedged — killing it is not the recovery.

**A stage limit asks the posting receipt first** (H1a, #5850 round 5).
The round-stage supervisor's limits (`src/session-command-supervisor.ts`:
command start, first pass, passes, parent finalize, the running hard bound)
are wall-clock bounds on a session that is supposed to be reviewing. Once the
round's review is CONFIRMED on GitHub (or refused by guard 2), the session is
writing its tail — ledger, findings record, verdict file — and a limit is no
longer an infrastructure failure: `recoverInfrastructureFailure` answers
`posted_wait`, nothing is cancelled, killed or requeued, and a verdict file
that lands is applied as usual. The tail gets `[daemon]
round_posted_tail_grace_min` (15) from the posting; past it the round settles
from the receipt, as above — or, when the receipt does not prove the decision,
fails loud as `posted_without_verdict`; never a requeue. The round deadline
gives the same grace (a review posted just before it is not settled under a
session still writing its tail). A parent that has already settled gets no
grace (it will write nothing more) and settles at once.
A POST still inside its ambiguous window (a `prepared` receipt within
`posting_receipt_grace_s`) is waited out rather than killed mid-post — and so
is one past it whose marker reconcile could not read GitHub
(`round_stage_posting_ambiguous`): the POST may have landed, so the limit waits
for a read that can decide, bounded by the round deadline, where the same
evidence fails loud. Evidence of a posting that contradicts the round
(conflicting linkage, several matching reviews) fails loud. A verdict
file already on disk defers any limit to the sweep, receipt or none (the
session has finished; the sweep consumes the file within its partial-write
window). With no receipt, or a `prepared` one whose marker GitHub was read for
and does not hold, and no file, the old path runs: cancel, kill, capped
self-requeue.

## 9. Escalation (optional, off by default)

`[escalation] enabled = false` is the shipped default, and off means nothing
happens: no rule is evaluated, no note renders into any prompt, no mutation is
built, no extra API call is made. `promptTargetsFor()` returns undefined, so
`{{escalation_note}}` in `src/templates.ts` renders empty.

Switched on, escalation adds a note **beside** a finished verdict. Two
invariants hold it there, both structural:

1. **The reviewer still decides.** `src/escalation.ts` does not import
   `src/types.js`; nothing in its exported surface returns, accepts or
   constructs a `Verdict`. The decided verdict reaches it as a plain string, to
   be quoted. `deliverEscalations()` resolves to `EscalationOutcome[]` — a
   delivery record with no channel back into the verdict — and the one caller in
   `src/verdicts.ts` invokes it *after* the verdict has been applied and the PR
   transitioned, wrapped so a throw cannot reach the verdict path.
2. **It escalates a question, never a review.** `EscalationScope` is a
   discriminated union of `code` (file, optional line range), `migration` and
   `decision` — there is no whole-PR member. Every path in a scope must be a
   file the PR actually touches, compared exactly against the diff; a
   `decision` is capped to a name, not a paragraph; and the comment body is
   *rendered* from the scope. A free-text heuristic (`asksForWholeReview`) sits
   over the question, the decision and a session's `why` as a belt — it is
   deliberately tuned to under-block, because a false positive is a silent drop
   and the structural checks are what the guarantee rests on.

Two triggers. Operator-defined deterministic rules (paths, label, severity
floor, a named failing check) are evaluated by the pure `evaluateEscalationRules()`
with no model in the loop. Additionally, if `session_judgement = true`, the PR's
session may propose escalations in its verdict file — bounded three ways: it can
reach only a login in `[escalation] targets` (filtered daemon-side, not asked of
the model), it can never touch a verdict, and it rides the same `max_per_pr` cap
and the same never-twice ledger. Which half a candidate belongs to is decided by
the **call site**: `deliverEscalations()` takes the two groups as separate
arguments, so a session cannot label itself as a rule to buy an exemption.

Two delivery shapes. `comment` (the default) posts a gated `create_review`
COMMENT with `reviewPurpose: "escalation"` — the same mechanically-authored
gated comment the migration pre-check uses. `review_request` additionally makes
the GitHub reviewer request, and the comment is not optional on that shape: it
is what carries the narrow ask, and it is posted first.

The ledger records **deliveries, not attempts**: a dry-run or guard-refused
escalation writes no row, so a bring-up can never consume the dedup key or the
cap a later live run needs. With `enabled = true` the config parser refuses a
half-written configuration (no targets, a rule pointing outside targets, a rule
with no condition, a bad shape or cap); with `enabled = false` none of that is
checked, so a draft rule can never wedge startup.

## 10. Sequence

One trigger, one round, one verdict, then the after-life. Time flows downward.

```
 human        GitHub        daemon                     PR session      gate/GitHub
   |            |             |                             |               |
   |-- label -->|             |                             |               |
   |            |-- webhook ->| webhook.ts: verify HMAC,    |               |
   |            |             |   dedupe, interpret         |               |
   |            |             | statemachine: trigger       |               |
   |            |             |   -> queued (trigger_ts)    |               |
   |            |             |                             |               |
   |            |<--- poll ---| reconcile.ts (every 300s)   |               |
   |            |---- truth ->|   GitHub wins; corrections  |               |
   |            |             |   logged                    |               |
   |            |             |                             |               |
   |            |             | dispatch.ts pump:           |               |
   |            |             |   FIFO by trigger_ts        |               |
   |            |             |   capacity check            |               |
   |            |             |   no-new-evidence? --------> (skip, uphold) |
   |            |             |   trivial system delta? ---> (skip, uphold) |
   |            |<-- consume -|   remove label + team req. --------------> ok
   |            |--- files -->|   selectLenses, buildPassPlan               |
   |            |             |   prepare worktree at head_sha              |
   |            |<-- COMMENT -|   migration pre-check ------------------> ok
   |            |             |   build RoundOrder + receipt marker         |
   |            |             |--- wake file (prompt) ----->|               |
   |            |             | statemachine: dispatched    |               |
   |            |             |   -> reviewing              | fan out lens  |
   |            |             |                             |   passes      |
   |            |             |                             | validate      |
   |            |             |                             |-- post -----> review
   |            |             |<-- verdict/pr-N-round-K.json|               |
   |            |             | verdicts.ts: receipt check, |               |
   |            |<-- labels --|   labels, round row, mark ------------> ok  |
   |            |             | statemachine: verdict       |               |
   |            |             |   APPROVE -> tracked        |               |
   |            |             |   REQ_CHANGES -> awaiting_author            |
   |            |             | escalation (if enabled) --------------> comment
   |            |             | request compaction -------->| (bridge runs  |
   |            |             | flush held wakes ---------->|  it first)    |
   |            |             |                             |               |
   |-- push --->|-- webhook ->| recheck.ts: classify delta  |               |
   |            |             |   trivial/empty -> no-op    |               |
   |            |             |   significant --- nudge --->|               |
   |            |             |<-- pr-N-recheck-<head>.json |               |
   |            |             |   uphold | request_changes  |               |
   |            |             |                             |               |
   |- reply --->|-- webhook ->| pingpong.ts: claim message, |               |
   |            |             |   <=3 exchanges --- wake -->|               |
   |            |             |<-- thread decision file ----|               |
   |            |<-- reply ---|   post reply / resolve ----------------> ok |
```

While a round is running, any wake in the middle column is **held** in
`pending_wakes` and flushed at round end — that is the single-shepherd rule, not
a queueing optimisation.

## Related

- [../single-shepherd-invariant.md](../single-shepherd-invariant.md) — why one
  session owns a PR, and what the daemon may and may not schedule.
- [../exec-boundary.md](../exec-boundary.md) — the reviewer reads code and CI
  results; it never runs them.
- [../deferral-protocol.md](../deferral-protocol.md) — what happens to a real
  finding that is not this PR's to fix.
- [../ownership.md](../ownership.md) — the owner-only surfaces: the dry-run
  flag, the frozen prompt seeds, ratification.
- [../../README.md](../../README.md) — the system in one page, and setup.
