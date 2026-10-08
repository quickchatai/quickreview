# Data model — what persists, and where

Everything this daemon remembers lives in one of four places:

| Store | Path | Written by | Read by |
| --- | --- | --- | --- |
| SQLite database | `state/state.db` | `StateStore` (`src/state.ts`) — the only module with SQL in it | every daemon module, through typed `StateStore` methods |
| Runtime drop-boxes | `inject/`, `verdict/`, `commands/`, `archive/`, `digest/`, `memory/` at the sandbox root | daemon and pi sessions, by file | the opposite side of each channel |
| Derived / scratch state | `state/**` (everything except `state.db`) | daemon, TUI, onboarding | the same, plus the operator CLI |
| Configuration | `config.toml` at the sandbox root | the operator (or `qcr onboard`) | `loadConfig()` in `src/config.ts` |

Two rules cover almost everything below.

1. **All SQL is in `src/state.ts`.** The schema is one `SCHEMA` template
   string; every other module reaches the database through a named
   `StateStore` method. If you need a new query, add a method — do not open
   `store.db` from a feature module.
2. **Nothing under the runtime directories is ever committed.**
   `tests/publishability.test.ts` fails the build if any tracked file appears
   under `state/`, `inject/`, `verdict/`, `commands/`, `digest/`, `archive/`
   or `memory/`, apart from `.gitkeep` markers and `memory/README.md`.

Reviewer *memory* is deliberately not in this document: it lives in a separate
engine, not in SQLite. See [`../../memory/README.md`](../../memory/README.md).

---

## 1. The SQLite database (`state/state.db`)

Opened by `new StateStore(join(stateDir, "state.db"))` — `src/daemon.ts`
builds the production one, `src/cliops.ts` and `src/cli.ts` open the same file
read-mostly for the operator CLI, and tests use `new StateStore(":memory:")`.
The schema is created with `CREATE TABLE IF NOT EXISTS` on every open, so a
fresh file and a live one converge; column additions that a live database
cannot express as DDL are handled by `runDataMigrations()` in the same file.

Timestamps are ISO-8601 strings in `TEXT` columns throughout. Booleans are
`INTEGER` 0/1.

### 1.1 Lifecycle and review history

| Table | Purpose | Key columns | Principal `StateStore` methods |
| --- | --- | --- | --- |
| `pr_state` | one row per PR the system tracks; the lifecycle position | `number` (PK), `state`, `head_sha`, `trigger_ts`, `stale_recheck`, `migration_gate`, `paused` | `getPr`, `allPrs`, `upsertPr`, `setPrState`, `pausePr`, `resumePr` |
| `rounds` | the review history: one row per round ever started | `id` (PK), `pr`, `round_no`, `round_type`, `lenses`, `verdict`, `spend_usd`, `started_at`, `deadline_at`, `status` | `startRound`, `finishRound`, `roundsFor`, `runningRounds`, `markRoundOverdue`, `markRoundCancelled`, `expireOverdueRounds`, `recordRoundUsage` |
| `bot_comments` | the registry of comments this system posted | `comment_id` (PK), `pr`, `kind`, `posted_at` | `registerBotComment`, `botCommentPr` |
| `reviewed_heads` | one row per PR: the head last actually reviewed, and what was decided there | `pr` (PK), `head_sha`, `verdict`, `posted_event`, `round_no`, `last_author_reply_at` | `recordReviewedHead`, `reviewedHead`, `noteAuthorReply` |
| `approval_withheld` | one row per PR whose approval was withheld for red or missing CI | `pr` (PK), `head_sha`, `ci_state`, `reason` | `recordApprovalWithheld`, `approvalWithheld`, `clearApprovalWithheld` |
| `rechecks` | post-approval delta rechecks actually nudged; the unique key is the runaway guard | `(pr, fingerprint)` (PK), `head_sha`, `trigger` | `claimRecheck`, `hasRecheck`, `releaseRecheck`, `recheckClaimsBefore` |
| `trigger_levels` | the previous reconcile observation of each trigger level, so a level already present cannot look like a fresh request | `(pr, kind)` (PK), `present`, `observed_at` | `triggerLevel`, `observeTriggerLevel` |
| `successor_obligations` | a newer head seen while an older round owned the PR — durable work owed | `pr` (PK), `predecessor_round_id`, `head_sha`, `provenance` | `recordSuccessor`, `successorFor`, `settleSuccessor`, `clearSuccessor` |

`reviewed_heads` is deliberately **not** part of `pr_state`: the mark outlives
lifecycle churn. Every lifecycle consumer reads it through the single
interpreter in `src/standing-review.ts`, never by inspecting columns directly.

### 1.2 Round execution and recovery

| Table | Purpose | Key columns | Principal methods |
| --- | --- | --- | --- |
| `session_commands` | the durable daemon→session command slot: one owner per session at a time, with a finite lease | `id` (PK), `pr`, `session`, `kind`, `payload_sha256`, `payload_path`, `inject_path`, `status`, `owner_token`, `next_check_at` | `createSessionCommand`, `claimSessionCommand`, `markSessionCommandStarted`, `finishSessionCommand`, `dueSessionCommands`, `retrySessionCommand` |
| `pending_wakes` | wakes held while the PR's round was in flight, flushed at round end | `id` (PK), `pr`, `payload`, `reason`, `held_at`, `claim_token` | `holdWake`, `heldWakes`, `claimHeldWakeBatch`, `ackHeldWakeBatch`, `dropHeldWakes` |
| `review_failures` | the canonical loud-failure debt; at most one open row per PR | `incident_id` (PK), `pr`, `stage`, `attempts`, `retry_cap`, `retry_epoch`, `next_retry_at`, `next_action`, `work_owed` | `openReviewFailure`, `openReviewFailures`, `recoverReviewFailure`, `resolveTerminalReviewFailure` |
| `round_recovery_instructions` | identity-bound instructions for exactly one recovery successor round | `(pr, target_round_no)` (PK), `target_head_sha`, `stage`, `retry_epoch` | `recordRoundRecoveryInstruction`, `roundRecoveryInstruction`, `roundRecoveryInstructionForDispatch` |
| `supervisor_leases` | heartbeat for local correctness supervisors; `last_attempt_at` advances *before* async work, so a hung callback goes stale | `name` (PK), `last_attempt_at`, `last_success_at`, `last_error_at` | `supervisorLease`, `markSupervisorAttempt`, `markSupervisorSuccess`, `markSupervisorError` |

The `session_commands` partial unique index
`session_commands_one_active ON session_commands(session) WHERE status IN
('pending','running')` is what makes "one instruction per session at a time"
a database property rather than a convention.

### 1.3 Ingest, evidence and telemetry

| Table | Purpose | Key columns | Principal methods |
| --- | --- | --- | --- |
| `deliveries` | webhook delivery dedupe | `guid` (PK), `event`, `action` | `recordDelivery` |
| `events` | the append-only daemon event log the CLI, TUI and digest read | `id` (PK), `ts`, `kind`, `pr`, `payload` | `logEvent`, `recentEvents`, `eventsOn`, `anomalies` |
| `pr_comments` | a local copy of every human comment on a tracked PR (identity is GitHub's own `(source, comment_id)`) | `id` (PK), `pr`, `source`, `comment_id`, `author`, `body`, `tagged`, `captured_via`, `review_state` | `recordPrComment`, `prComments`, `hasPrComment` |
| `feedback_signals` | the tuning-loop ledger: tagged comments plus behavioural signals, deduped per kind | `id` (PK), `kind`, `pr`, `comment_id`, `review_id`, `scope`, `day` | `recordFeedbackSignal`, `feedbackCommentsForDay` |
| `round_findings` | the durable per-finding reasoning record, parsed out of the session-written findings file | `id` (PK), `pr`, `round_no`, `finding_key`, `lens`, `lens_ids`, `title`, `severity`, `disposition`, `reason` | `recordRoundFindings`, `roundFindings`, `findingsForRound`, `concededFindings` |
| `backfill_pr_meta` | PR metadata imported by the one-shot history backfill | `pr` (PK), `title`, `author`, `merged`, `imported_at` | `upsertBackfillPrMeta`, `backfillPrMeta`, `allBackfillPrMeta` |

`feedback_signals` carries three partial unique indexes rather than one:
comment-keyed kinds dedupe on `(kind, scope, comment_id)`, review-keyed kinds
on `(kind, review_id)`, and keyless kinds on `(kind, pr, day)`. `scope` is
`NOT NULL` with an empty-string sentinel because SQL `UNIQUE` treats NULLs as
distinct, which would void the comment-key dedupe.

`round_findings` has a unique index on `(pr, round_no, finding_key)`, so
re-recording a round replaces its rows instead of doubling them. `lens_ids`
(S6) is a JSON array of the known pass ids the free-text `lens` names
(`src/lensids.ts`; `[]` for an entry raised outside any lens), filled at boot
for rows recorded before the column; `title` is the posted comment's title as
the record wrote it, null when it wrote none.

#### Outcome capture (S6)

`src/outcomes.ts` creates and owns four more tables on the same file, the way
`src/pingpong.ts` owns its ledger's:

| Table | Purpose | Key columns |
| --- | --- | --- |
| `finding_comments` | one row per ROOT inline comment the bot posted, with its link facts and its link to a `round_findings` row (NULL = unmatched) | `comment_id` (PK), `pr`, `review_id`, `path`, `line` (the line it was posted on; a row only a human reply named holds the reply's drifting line until the bot's own comment is read, which re-opens its link), `marker_round`, `marker_key`, `source`, `round_no`, `finding_key`, `via` |
| `finding_outcomes` | one fate per posted finding, the rule that decided it and when | `(pr, round_no, finding_key)` (PK), `comment_id`, `fate`, `basis`, `evidence`, `decided_at`, `human_replies`, `carried_to`, `fate_changed_at` |
| `review_outcomes` | a whole-review signal (a set-aside, a merge over a block), recorded per review | `signal_id` (PK, the `feedback_signals` row), `pr`, `kind`, `round_no`, `gh_review_id` |
| `outcome_capture_marks` | the input fingerprint a PR was last captured at, so an unmoved PR is skipped | `pr` (PK), `signature`, `captured_at` |

`via` says how a comment was linked, most trusted first: `marker` (the hidden
`<!-- qcr:f=<round>:<key> -->` the live render route appends), `thread_id`
(the record named it), `path_line`, `path_line_title`, `path_line_tag`. The
fate set is closed: `fixed`, `refuted_conceded`, `upheld_after_reply`,
`open_at_close`, `unknown`. Nothing here is written to GitHub.

`pr_comments.review_state` (S8) is a captured REVIEW's own state
(`approved`, `changes_requested`, `commented`), lowercased; null for inline and
top-level comments, and for a review captured before the column (a later sweep
that sees the review again fills it in, once). The learner reads it as "a human
asked for changes"; nothing routes on it.

#### The learner (S8)

`src/learner/learner.ts` creates and owns four more tables on the same file:

| Table | Purpose | Key columns |
| --- | --- | --- |
| `lesson_candidates` | one row per human outcome the miner turned into a candidate lesson, deduped by a deterministic `ref`, and what the EOD curation made of it | `id` (PK, the `c<id>` the packet and the receipt name), `ref` (UNIQUE), `source`, `kind`, `polarity`, `class`, `pr`, `round_no`, `finding_key`, `occurred_at`, `offered_day`, `reopened_day`, `offers`, `status`, `decided_day`, `reason`, `lesson_ids`, `receipt_day` |
| `eod_curations` | one row per EOD day: its packet, the sweep's delivery, the receipt and what did not persist | `day` (PK), `packet_at`, `offered`, `new_today`, `expired`, `fired_at`, `receipt_at`, `missing_woken_at`, `not_persisted`, `not_persisted_since`, `not_persisted_woken` |
| `learner_marks` | once-only marks: the day's mine (`mined:<day>`) and the digest backfill | `key` (PK), `value`, `at` |
| `learner_recall_scans` | per merged PR, the post-merge recall scan's progress and outcome | `pr` (PK), `merged_at`, `attempts`, `merge_commit`, `touches`, `done`, `outcome` |

A candidate's `status` is `open` (queued while `offered_day` is null),
`adopting` (the receipt said adopted; memory not checked yet), `adopted` (a
typed lesson in `experiences/` cites `cand:c<id>`), `declined`, `expired`
(undecided `lessons_expiry_ops_days` after its first offer — or after
`reopened_day`, when a refused write or an unfound adoption put it back in the
packet), or `withdrawn` (a fate candidate whose S6 outcome changed since it was
mined). Nothing is ever deleted. A day stays reported as `missing` in
status.json `memory.curation` until it or a later day is receipted, and as
`not_persisted` until each candidate on its list is decided.

### 1.4 Operator controls and filing

| Table | Purpose | Key columns | Principal methods |
| --- | --- | --- | --- |
| `drain_state` | the deploy-window drain; exactly one row, `id = 1`, persistent so it survives the restart it exists for | `id` (PK, `CHECK (id = 1)`), `draining`, `drained_deliveries`, `since` | `drainState`, `engageDrain`, `liftDrain`, `countDrainedDelivery` |
| `lever_grants` | every bounded drain/pause a *session* was granted, and the minutes it drew from that day's budget | `id` (PK), `kind`, `pr`, `minutes`, `day`, `expires_at` | `recordLeverGrant`, `leverMinutesUsed` |
| `operator_commands` | which operator command files have been handled; keyed by file *version*, not name | `version` (PK), `file`, `handled_at` | `operatorCommandHandled`, `markOperatorCommandHandled` |
| `filed_items` | improvement PRs and issues this system filed, for the day/week caps | `id` (PK), `kind`, `title`, `ref`, `filed_at` | `recordFiledItem`, `filedSince` |
| `escalations` | escalations that actually reached GitHub; empty forever on a default install | `id` (PK), `pr`, `target`, `scope_key`, `shape`, `origin`, `rule` | `recordEscalation`, `escalationDelivered`, `escalationCount` |

`operator_commands` exists because the operator command directory is not
writable by the daemon's uid, so a handled file cannot be archived by rename
the way the session directories do it; the ledger is what stops a restart
executing one twice. The version key is name + inode + mtime + size
(`operatorCommandVersion`), so the same filename rewritten with new content is
a new command.

The `escalations_once` unique index on `(pr, target, scope_key)` buys exactly
one thing: the same person is not pointed at the same file, or the same named
decision, on the same PR twice. Breadth is bounded separately by
`[escalation] max_per_pr`.

### 1.5 Slack

| Table | Purpose | Key columns | Principal methods |
| --- | --- | --- | --- |
| `slack_threads` | one thread per PR in the concierge channel | `pr` (PK), `channel`, `root_ts`, `post_count` | `upsertSlackThread`, `slackThreadForPr`, `slackThreadByRoot`, `touchSlackThread` |
| `slack_events` | inbound events, their tier and what was done with them | `event_id` (PK), `channel`, `ts`, `tier`, `disposition`, `injected_at` | `recordSlackEvent`, `setSlackEventDisposition`, `slackTurnsBetween` |
| `slack_posts` | outbound posts with an idempotency key, for the rate and turn caps | `id` (PK), `idem_key` (UNIQUE), `kind`, `pr`, `thread_ts`, `ok` | `recordSlackPost`, `settleSlackPost`, `slackPostsBetween` |
| `slack_cooldowns` | per-cause cooldown memory: when it last fired, how many repeats folded | `key` (PK), `last_fired_at`, `warsaw_day`, `fire_count`, `fold_count` | `slackCooldown`, `recordSlackCooldownFire`, `foldSlackCooldown` |

`slack_cooldowns.warsaw_day` is a stored column name that predates the
configurable operations timezone. It now holds the ops-day token for whatever
`[ops] timezone` is configured; code reads it through the `day` alias in
`slackCooldown()`, so the legacy spelling appears nowhere outside
`src/state.ts`. Renaming it would migrate live state for nothing.

### 1.6 One legacy column

`pr_state.escalation_worthy` is dead: nothing reads or writes it. It stays in
the DDL because a live database cannot drop a column without a table rebuild,
and its `NOT NULL DEFAULT 0` keeps satisfying itself. `PrLifecycleState` in
`src/state.ts` has five members — `tracked`, `queued`, `reviewing`,
`awaiting_author`, `closed` — and no "awaiting human": the review is never
handed to a person.

---

## 2. Runtime drop-boxes at the sandbox root

These sit beside `state/`, not inside it. Each is a channel between two
processes that do not share memory.

| Directory | Files | Producer | Consumer |
| --- | --- | --- | --- |
| `verdict/` | `pr-<n>-round-<k>.json`, `pr-<n>-recheck-<head12>.json`; each first staged as `<name>.tmp` | the PR's pi session at round end, published by `scripts/commit-verdict.sh` (one rename, H1a) | `VerdictWatcher` (`src/verdicts.ts`) and `RecheckWatcher` (`src/recheck.ts`), which never read a `.tmp`; the path is set in `src/daemon.ts` as `join(root, "verdict")` |
| `inject/<session>/` | `*.md` wake files, plus a `.done/` subdirectory | `SessionManager` (`src/sessions.ts`) | `extensions/inject-bridge.ts` inside pi, which moves consumed files to `.done/` |
| `commands/` | `*.json` command files, plus `results/` and `processed/` | pi sessions (the overseer's action space) | `CommandWatcher` (`src/commands.ts`) |
| `commands/slack/` | the same envelope, tier-checked | the Slack router | the second `CommandWatcher` built in `src/wire.ts` |
| `commands/operator/` | the same envelope, root-owned so the daemon's uid cannot write it | operator tools (`qcr drain`, the board's unwedge key, the deploy tab) | the operator `CommandWatcher`; results are written to `commands/results/` so clients read one place |
| `archive/<session>/` | session JSONL and ledger of a closed PR | `SessionManager.archiveAndClose` | humans, and `qcr why` |
| `digest/` | `<YYYY-MM-DD>.md` | `writeDigest` (`src/digest.ts`) | `latestDigestHeadline`, which `src/wire.ts` points at `join(root, "digest")` |
| `memory/` | empty drop-box; reviewer memory lives in the memory engine | — | see [`../../memory/README.md`](../../memory/README.md) |
| `evidence/` | finished-round evidence copied down by the TUI | `EvidenceStore` (`src/tui/evidence.ts`) | the companion container, read-only. The location is `[companion] evidence_dir`; the shipped default is outside the repo, and an empty value resolves to `<root>/evidence` |
| `pihome/` | pi's home inside the container (auth tokens, sessions) | pi | pi |

Note on the digest path: `writeDigest`/`latestDigestHeadline` default to
`<root>/digest`, and that is what `src/wire.ts` passes for the status
headline. The end-of-day pinned-area watchdog wired in the same file probes
`<root>/state/digest/<date>.md` for its "digest has landed" signal. Two
different paths; read the call site before assuming either.

---

## 3. The `state/` directory

`state/` is derived state: everything here can be rebuilt or lost without
losing the review record, except `state.db` itself.

| Path | Shape | Written by | Notes |
| --- | --- | --- | --- |
| `state/state.db` (`-wal`, `-shm`) | SQLite | `src/state.ts` | the record of everything above |
| `state/status.json` | JSON | `writeStatusJson` (`src/state.ts`), from the daemon's timer | the heartbeat snapshot; written temp + rename |
| `state/dryrun/` | one JSON file per intent | `MutationGate` (`src/gate.ts`) | what a GitHub mutation *would* have been while `dry_run = true` |
| `state/agents/` | built pass agent bodies, one file per lens × tier | `buildAgents` (`src/include.ts`), called from `src/wire.ts` | the only path by which built passes reach the subagent extension |
| `state/findings/` | `pr-<n>-round-<k>.json` | the PR session | parsed into `round_findings` by `src/findingsrecord.ts` |
| `state/posting-receipts/` | `pr-<n>-round-<k>.json` | the shell posting route (`scripts/post-review.sh`) | read by `src/posting-receipt.ts` / `src/verdicts.ts` |
| `state/round-prompts/` | `pr-<n>-round-<k>.md` | `SessionManager` | the exact dispatched bytes, so a redelivery re-sends them rather than re-rendering |
| `state/round-progress/` | `pr-<n>.json` | the pi progress extension | ephemeral live pass telemetry; parsed by `src/round-progress.ts` |
| `state/session-prompts/` | `<session>.md` | `SessionManager` | the session's system prompt |
| `state/session-commands/` | `<id>.md` | `SessionManager` | the payload bytes a `session_commands` row points at |
| `state/sessions/` | `<session>.json`, `<session>.bridge-<generation>.json` | `SessionManager` | birth record and inject-bridge readiness receipt |
| `state/ledgers/` | `pr-<n>.md` / `<session>.md` | the pi session | the running review ledger |
| `state/pi-sessions/` | pi's own JSONL transcripts | pi | path comes from `[pi] session_dir` |
| `state/rubric/<slug>/` | `PROPOSAL.md`, `changes.patch` | the companion or a session | rubric proposals the TUI accepts or rejects (`src/tui/proposals.ts`) |
| `state/companion/feed/` | `snapshot.json`, `events.jsonl`, `screen.txt`, `view.json` | the TUI (`src/tui/feed.ts`) | the companion's read-only ambient view |
| `state/companion/alerts/` | `<iso-ts>-<slug>.json` | the companion | consumed by `src/tui/alerts.ts` |
| `state/companion/alert-policy.json` | JSON | `src/tui/alerts.ts` | per-day cooldown memory, so it survives a TUI restart |
| `state/companion/first-run.json` | JSON | `src/onboard/engine.ts` | the onboarding first-run marker `src/tui/rollover.ts` reads |
| `state/flags/owner.log` | text, one line per flag | the `flag-owner` command handler in `src/wire.ts` | append-only |
| `state/slack/origin/` | JSON | `OriginStore` (`src/slack/origin.ts`) | which Slack message caused which daemon action |
| `state/ingress/hostname` | one bare hostname | the tunnel sidecar | default path from `ingressHostnameFile` (`src/config.ts`) when `[ingress] hostname_file` is empty |
| `state/onboarding/` | `checklist.json`, `config.candidate.toml`, `pi-sessions/` | `src/onboard/` | the wizard's own state |
| `state/changes/` | `change-register.json` | `src/tui/index.ts` | the TUI change log |
| `state/tui-deploy-runs/`, `state/tui-deploy-ceremony.json`, `state/tui-resume-<pid>.json`, `state/tui-help-shown` | JSON / markers | the TUI | deploy run logs and small per-operator markers |
| `state/tui-evidence-sweep.json` | JSON | `SweepProgressFile` (`src/tui/evidence.ts`) | the evidence sweep's per-PR progress (L1): the signature each PR was last cleanly reconciled at and whether the store then held its evidence (`{sig, stored}`), and the evidence store it describes; written temp + rename. Unreadable or another store's ⇒ treated as empty, with a notice |
| `state/tsc-watch.log` | text | `npm run dev` | the TypeScript watcher's output, kept off-screen so a stray compiler line cannot corrupt the alt-screen frame |

---

## 4. The JSON contracts

Five of these are written by a model and read by the daemon. They all follow
the same discipline, which `src/verdicts.ts` sets and the others copy:
**strict shape check, unambiguous digit-strings coerced to numbers, and a
malformed file surfaced rather than silently dropped.**

### 4.1 Verdict file — `verdict/pr-<n>-round-<k>.json`

Declared as `VerdictFile` in `src/types.ts`, consumed by `src/verdicts.ts`.

| Field | Type | Meaning |
| --- | --- | --- |
| `pr`, `round_no` | number (digit-strings coerced) | which round this closes |
| `verdict` | `"APPROVE"` \| `"REQUEST_CHANGES"` \| `"NEEDS_HUMAN"` | `normalizeVerdict` also accepts the retired `ESCALATE` spelling and folds it to `NEEDS_HUMAN`, which lands the PR on `tracked` — review posted, no approval, nothing waiting on a person |
| `outcome` | `"head_moved"` (optional) | the round refused to post because the PR advanced mid-round; the daemon cancels and re-queues instead of treating the session as stuck |
| `head_sha` | string | the head the round actually reviewed |
| `approval_withheld` | boolean (optional) | no blockers, but CI was not green here; the review posted as a comment |
| `ai_approved` | boolean (optional) | soundness marker on `NEEDS_HUMAN`; recorded, never acted on |
| `spend_usd`, `ledger_snapshot`, `summary` | number / string / string (optional) | accounting, ledger digest, and the prose the operator's detail pane shows |
| `passes` | `VerdictPassEntry[]` (optional) | executed-pass telemetry: what actually ran, at which tier, with the validator's survived/killed/downgraded counts. Absent or malformed is *unknown*, logged, never a verdict rejection |
| `escalations` | `unknown[]` (optional) | typed as `unknown[]` on purpose — model-written input, normalised by `src/escalation.ts`; a malformed entry costs a log line and can never alter the verdict |
| `finished_at` | ISO string | — |

The round prompt carries a receipt token (`roundPromptMarker` in
`src/types.ts`) which pi echoes into its session JSONL only when it *accepted*
the message. Present means delivered, absent means never arrived, unreadable
means unknown — and unknown is never read as loss.

### 4.2 Heartbeat — `state/status.json`

`StatusSnapshot` in `src/state.ts`, built by `buildStatusSnapshot` and written
by `writeStatusJson` (temp file + rename, because readers may hit it
mid-write). This is the single surface the operator TUI polls and the status
collector picks up.

Top level: `written_at`, `heartbeat`, `dry_run`, `prs[]`, `running_rounds`,
`max_concurrent_rounds`, `total_spend_usd`, `today_spend_usd`,
`digest_headline`.

Optional blocks, each absent rather than faked when its source has nothing to
say — a reader must default rather than assume:

- `pi_auth_expired` — `{ last_at, hits }` while pi sessions are failing with
  token-expired errors (`src/authwatch.ts`).
- `openviking` — the supervised memory server's reachability, version, RSS and
  CPU (unauthenticated: whether the server is UP).
- `memory` — reviewer-memory HEALTH (S1, `MemoryStatus` in
  `src/memory/health.ts`): `state` (`unknown | healthy | degraded | down |
  auth_failed`), `since`, `last_ok_at`, `last_error`, each credential's latest
  verdict (`credentials.daemon`, `credentials.sessions`), `probe_ms`, request
  counters per operation, gap counts, the open `incident`, and the boot
  `provision` report (with its file fingerprint `id`). Request counters split
  `ok`, `absent` (NOT_FOUND answers), `conflict`, `auth_failed` and `failed`.
  `enabled: false` means not monitored — memory switched off in config.toml,
  never a server that cannot run. What a person sees about memory is read from
  here. Its `curation` sub-block (S8, `CurationStatus` in
  `src/learner/status.ts`) is the learner's: the reported day's state
  (`no_packet | packet_ready | nothing | awaiting | missing | not_persisted |
  received`) and counts, every `unresolved` failure, the oldest of them as the
  `incident` the TUI files one ticket for, and the look-for : don't-raise
  `balance` of the lessons in force (null until memory was read in full).
- `daemon` — the daemon's own load (L2, `DaemonLoadStatus` in
  `src/eventloop.ts`). `event_loop`: `state` (`unknown | ok | stalled`),
  `since`, p50/p99/max of the event-loop delay over the window (`window_s`,
  `covered_s`, `samples`, `max_at`), the `longest_stall` since `started_at`
  with `began_at`/`ended_at`, the `thresholds`, the `stall` (`trigger`
  `max|p99`; `cause` `cpu_starved | loop_blocked | unknown`, each from its
  own evidence — `loop_blocked` from `busy_share`, the daemon process's own
  CPU time across the stall as a share of its wall time (the longest delay's
  span for `max`, the window for `p99`; null when not measured) at 0.5 or
  more, which wins as the stall's own evidence; else `cpu_starved` from the
  throttling below; `unknown` when neither; `detail`) and `last_wake_at`.
  `covered_s` is how much of the window the samples span, and `p99` is judged
  only once they span it all. A reader (`qcr status`, the board) checks every
  field it renders (`readDaemonLoad`): a block it cannot read whole is
  UNKNOWN with why. `cpu`: the container's CFS throttling over the same window
  from `/sys/fs/cgroup/cpu.stat` deltas — `periods`, `throttled_periods`,
  `throttled_ratio`, `throttled_s`, `usage_s` — or `state: "unknown"` with
  the `reason`, never a zero. A stall wakes `daemon_event_loop_stalled`.
- `draining`, `drained_deliveries`, `draining_since`, `draining_by`,
  `draining_until`, `drain_failed_loud` — the deploy-window drain.
- `round_stage_supervisor` — `{ healthy, stale_after_s, last_attempt_at, … }`.
- `pipeline` — `{ healthy, failed_loud, causes[], recoveries[], oldest_expired }`;
  cause `key`s are stable alert identities, never prose or timestamps.
- `provider` — provider/auth health, a sibling of the two above so one domain
  never impersonates another.
- `thread_decisions` — breaker state and durable backlog counts.

Each `prs[]` entry carries `number`, `state`, `title`, `head_sha`,
`stale_recheck`, and optionally `trigger_ts`, `updated_at`, `author`,
`paused`, `rounds`, `last_verdict`, `current_round`, `review_failure` and
`pause`. `current_round` is the authoritative plan and timing; live lens
activity is a separate ephemeral sidecar (`state/round-progress/`) and neither
source impersonates the other.

### 4.3 Companion feed — `state/companion/feed/`

Written by `FeedWriter` in `src/tui/feed.ts`; the TUI is the only writer.
Four files, all ambient: writing them costs disk and nothing in the
companion's context, and a feed write never injects a chat turn.

| File | Contents |
| --- | --- |
| `snapshot.json` | the current `StatusSnapshot`, verbatim, rewritten atomically on every successful poll |
| `events.jsonl` | a bounded append-only event tail, deduped on `ts|kind|pr`, capped at `EVENT_TAIL_CAP` (4000) and compacted to half on overflow |
| `screen.txt` | the last painted frame as plain text, ANSI stripped by `clampScreen`, capped at `SCREEN_MAX_CHARS` (20 000) |
| `view.json` | the `TuiView` projection — deliberately small, because the companion pays for it on every turn |

`TuiView` leads with `deploy` (`ViewDeploy`): `deployed` is the marker sha, or
the literal `"absent"` / `"unparseable"`, or `null` for a read that failed and
therefore says nothing. `dirty_files` and `pending_commit_count` are `null`
rather than `0` when the repository could not be read, and
`board.dry_run` is `null` until a heartbeat proves a mode. The rule the file
enforces is that a value published from no data is the same lie as a value
rendered from no data — so the key stays with an explicit `null` instead of
being dropped, because a dropped key reads as "nothing to report".

`writeView` is throttled by `VIEW_MIN_INTERVAL_MS` (500 ms) and returns
`false` when the throttle skipped it — never an error.

### 4.4 Command files — `commands/**/*.json`

Envelope: `{"command": "<name>", …payload}`. Schemas in `src/commands.ts` are
hand-rolled and strict: an unknown field is a rejection, not a warning, and
there is no generic escape hatch. The whitelist is closed:

`rerun-round`, `restart-session`, `resolve-terminal-failure`, `pause-pr`,
`resume-pr`, `flag-owner`, `file-improvement-pr`, `file-issue`, `slack_reply`,
`drain`, `retry-thread-decision`, `eod-curation-receipt` (S8 — the
EOD curator's per-candidate adopted / declined / refused answer to the day's
outcomes packet, `src/learner/receipt.ts`).

Nothing inside a command file says who wrote it. The **issuer is decided by
directory**: `commands/` and `commands/slack/` are session-issued;
`commands/operator/` is operator-issued *only if* the operator seal holds —
`operatorSealVerdict` checks that the directory is not writable by the
daemon's own uid. A file in the operator directory without the seal is served
as a session's, loudly. The lever handlers in `src/levers.ts` bound a
session's `drain`/`pause-pr` and never an operator's.

Every handled file produces `<results-root>/<name>.result.json`
(`CommandResultFile`: the outcome plus `command`, `file`, `handled_at`,
`issuer`). Session directories then archive the input into `<dir>/processed/`;
the operator directory cannot be written by the daemon, so the
`operator_commands` table takes that role instead.

Retired command spellings are folded to their current name at validate time
(`LEGACY_COMMAND_NAMES`): accepted on input, never emitted — the parsed
command, the result file and the event ledger all carry the current name.

### 4.5 Alert files — `state/companion/alerts/<iso-ts>-<slug>.json`

The companion's only push channel; schema fixed by its prompt, consumer is
`parseAlert` in `src/tui/alerts.ts`.

| Field | Type | Rule |
| --- | --- | --- |
| `tier` | `"notice"` \| `"alert"` | anything else is a parse failure |
| `cause` | non-empty string | the cooldown key |
| `title` | non-empty string | trimmed to `MAX_TITLE` (60) rather than rejected — the content is right, only the budget is off |
| `pr` | integer or `null` | digit-strings coerce |
| `body` | string (optional) | — |
| `ts` | ISO string (optional) | defaults to now |

Policy: `notice` reaches the TUI status line; `alert` also fires a desktop
notification and an overseer inject. One notification per distinct cause per
`cooldown_min`; repeats inside the window fold into a counter. A malformed
file is surfaced by name in a status-line notice, never silently dropped.

### 4.6 Posting receipts — `state/posting-receipts/pr-<n>-round-<k>.json`

`src/posting-receipt.ts` defines two shapes under one union, `PostingOutcome`.

**`PostingReceipt`** — a review the shell route *attempted* to post:

`version: 1`, `posting_key`, `marker`, `pr`, `round_no`, `head_sha`,
`intended_event`, `actual_event`, `status`, `payload_sha256`, `prepared_at`,
and on success `confirmed_at`, `gh_review_id`, `gh_commit_id`, `gh_state`.
`status` is `prepared` (the ambiguous transport window is open), `confirmed`
(GitHub returned an identity) or `dryrun` (the intent went to `state/dryrun/`
instead of being sent).

**`GuardedNoopReceipt`** — a review the route was *forbidden* to post:

`version: 1`, the same identity fields, `status: "skipped"`,
`skip_reason: "no-new-evidence"`, `intended_event`, `mode`, `skipped_at`, and
`standing_mark` (the snapshot of the mark the guard read). It has no
`actual_event`, no payload hash and no GitHub identity, because nothing was
posted — a deliberately separate shape so every consumer that handles it has
to say so by name. It is written only by `scripts/post-review.sh`, only before
`prepare`, and the writer refuses to put it over any attempted-post status.

Identity is `roundPostingKey(pr, roundNo, headSha)` → `v1:<pr>:<round>:<sha>`,
embedded in the review body as `postingMarker(key)`. A *missing* receipt is
still a loud failure; a `skipped` one settles the round terminally; a
`confirmed` one whose round has a malformed or missing verdict file settles
the round from the receipt (H1a) when `decidedVerdictFromReceipt`
can read the decision off `intended_event`/`actual_event` — a COMMENT the
session asked for is the templates' withheld approval (APPROVE,
`approval_withheld`); a receipt the daemon reconciled from GitHub, whose
`intended_event` is only the posted event, proves no decision off a COMMENT and
keeps the loud path.

---

## 5. `config.toml`

One file at the sandbox root, parsed by `parseConfig` in `src/config.ts` and
loaded through `loadConfig()`. Every runtime knob lives there —
[`config.example.toml`](../../config.example.toml) is the annotated copy with
the shipped defaults, and it is validated on every test run by
`tests/publishability.test.ts` and `tests/config.test.ts`.

The values below are the defaults **as shipped in `config.example.toml` and
the `*_DEFAULTS` constants in `src/config.ts`**. A section marked *optional*
may be omitted entirely; its defaults constant then supplies the whole block.

### 5.1 Sections at a glance

| Section | Optional? | Parsed by (`src/config.ts`) | Primary consumers |
| --- | --- | --- | --- |
| root `dry_run` | no | `parseConfig` | `src/gate.ts` |
| `[ops]` | yes (`OPS_DEFAULTS`) | `parseConfig` | every day-scoped feature |
| `[github]` | no | `parseConfig` | `src/github.ts`, `src/reconcile.ts` |
| `[owner]` | yes (`OWNER_DEFAULTS`) | `parseConfig` | rendered prose, Slack tiering |
| `[server]` | no | `parseConfig` | `src/webhook.ts` |
| `[ingress]` | yes (`INGRESS_DEFAULTS`) | `parseConfig` | `src/webhookheal.ts` |
| `[daemon]` | no | `parseConfig` | `src/daemon.ts`, `src/dispatch.ts`, `src/session-command-supervisor.ts` |
| `[eod]` | no | `parseConfig` | `src/eod.ts`, `src/eodpinwatch.ts` |
| `[caps]` | no | `parseCaps` | `src/improvements.ts` |
| `[models]` (+ `.tiers`, `.pricing`) | no | `parseModels` | `src/include.ts`, `src/dispatch.ts`, `src/usage.ts` |
| `[pi]` | no | `parseConfig` | `src/sessions.ts` |
| `[memory]` | yes (`MEMORY_DEFAULTS`) | `parseConfig` | `src/memory/context.ts` |
| `[openviking]` | yes (`OPENVIKING_DEFAULTS`) | `parseOpenViking` | `src/openviking/` |
| `[tui]` | yes (`TUI_DEFAULTS`) | `parseConfig` | `src/tui/` |
| `[companion]` | yes (`COMPANION_DEFAULTS`) | `parseConfig` + `resolveCompanionPaths` | `src/tui/companion.ts` |
| `[sink]` | yes (`SINK_DEFAULTS`) | `parseSink` | `src/tui/issuesink.ts`, `src/tui/trackertickets.ts` |
| `[backfill]` | yes (defaults off `[github]`) | `parseConfig` | `src/backfill.ts` |
| `[guards]` | yes (`GUARDS_DEFAULTS`) | `parseConfig` | `src/guards.ts`, `scripts/guards.sh` |
| `[recheck]` | yes (`RECHECK_DEFAULTS`) | `parseConfig` | `src/recheck.ts` |
| `[review]` (+ `.directives`) | yes (`REVIEW_DEFAULTS`) | `parseConfig` | `src/severity.ts`, `src/profiles.ts` |
| `[escalation]` | yes (`ESCALATION_DEFAULTS`) | `parseEscalation` | `src/escalation.ts` |
| `[levers]` | yes (`LEVERS_DEFAULTS`) | `parseLevers` | `src/levers.ts` |
| `[slack]` (+ `.users`, `.policy`, `.policy.causes`) | yes (`SLACK_DEFAULTS`) | `parseSlack` | `src/slack/` |

Two sections validate rather than merely parse, and refuse to load on a
half-written configuration:

- **`parseCaps`** checks every numeric cap instead of casting it. A cap the
  daemon cannot compare against is a startup refusal — the improvement channel
  is the one place this system pushes code, and it must never run uncapped.
- **`parseEscalation`** refuses `enabled = true` with no targets, a rule
  pointing at a login that is not a target, a rule declaring no condition, or
  a bad shape/severity/cap. With `enabled = false` none of it is checked, so a
  switched-off draft cannot wedge startup — and the whole set fires the moment
  the switch flips.

`parseLevers` and `parseSink` likewise reject contradictory values (a budget
below its own per-grant cap; a `wayfinder` sink with no effort or parent).

### 5.2 Knobs

Root: `dry_run` (bool, `true` in the example). While true, every GitHub
mutation is recorded to `state/dryrun/` instead of executed.

**`[ops]`** — `timezone` (string, `"UTC"`). The one calendar-day source; the
`[eod]` and `[slack.policy]` `timezone` keys default from it.

**`[github]`**

| Key | Type | Default |
| --- | --- | --- |
| `repo` | string | `""` (must be filled: `owner/name`) |
| `app_slug` | string | `""` |
| `bot_login` | string | `""` (`<app_slug>[bot]`) |
| `review_team` | string | `""` (`org/team`) |
| `trigger_label` | string | `"AI review requested"` |
| `in_progress_label` | string | `"AI review in progress"` |
| `reviewed_label` | string | `"Automatic Review"` |
| `improvement_label` | string | `"Bot improvement"` |
| `issue_label` | string | `"bot-filed"` |
| `secrets_dir` | path | `""` (the install locator: `<config home>/secrets`) |
| `base_branch` | string | `"main"` |
| `clone_dir` | path | `""` (derived) |

**`[owner]`** — `name` (string, `""`), `slack_id` (string, `""`),
`github_login` (string, `""`; the escalation-mention fallback).

**`[server]`** — `hostname` (string, `""`), `port` (number, `8787`, loopback).

**`[ingress]`** — `shape` (`"none"` \| `"tunnel-file"`, default `"none"`),
`hostname_file` (path, `""` → `<root>/state/ingress/hostname`), `debounce_ms`
(number, `3000`), `sweep_interval_s` (number, `300`).

**`[daemon]`**

| Key | Type | Default |
| --- | --- | --- |
| `poll_interval_s` | number | `300` |
| `max_concurrent_rounds` | number | `12` |
| `round_deadline_min` | number | `75` |
| `overseer_rotation_days` | number | `7` |
| `max_self_requeues` | number | `2` |
| `round_stall_grace_min` | number | `10` |
| `max_prompt_redeliveries` | number | `2` (`DEFAULT_MAX_PROMPT_REDELIVERIES`) |
| `session_command_start_lease_s` | number | `120` |
| `session_bridge_ready_timeout_s` | number | `30` (`DEFAULT_SESSION_BRIDGE_READY_TIMEOUT_S`) |
| `session_command_running_max_min` | number | `45` |
| `round_first_pass_max_min` | number | `5` |
| `round_passes_max_min` | number | `35` |
| `round_finalize_grace_min` | number | `5` |
| `round_posted_tail_grace_min` | number | `15` (H1a: after a CONFIRMED posting, how long a stage limit waits for the session's tail before settling the round from the receipt) |
| `posting_receipt_grace_s` | number | `120` |
| `session_command_unknown_grace_s` | number | `60` |
| `session_command_unknown_max_checks` | number | `1` |
| `session_command_max_start_retries` | number | `2` |
| `round_stage_supervisor_stale_s` | number | `180` |
| `event_loop_window_s` | number | `300` (clamped 60–3600; L2, `src/eventloop.ts`) |
| `event_loop_stall_max_s` | number | `10` (one delay this long is a stall; clamped 1–600) |
| `event_loop_stall_p99_s` | number | `2` (a p99 this high over a full window is a stall; clamped 0.1–60) |
| `event_loop_wake_cooldown_min` | number | `60` (one `daemon_event_loop_stalled` wake per cooldown; clamped 5–1440) |
| `event_loop_starved_throttle_ratio` | number | `0.2` (a stall with this share of CFS periods throttled or more is "CPU starved") |
| `expire_overdue_after_h` | number | `24` (0 disables the sweep) |

**`[eod]`** — `time` (`"18:00"`), `timezone` (defaults from `[ops]`),
`heartbeat_time` (`"09:00"`), `pinned_watchdog` (bool, `true`),
`pinned_watchdog_window_min` (number, `90`).

**`[caps]`** — `improvement_pr_max_lines` (`50`), `improvement_pr_max_files`
(`3`), `improvement_pr_per_day` (`1`), `improvement_pr_per_week` (`3`),
`issues_per_day` (`3`), `improvement_pr_deny_prefixes` (string array;
shipped default `["migrations/", "infra/", "ansible/", ".github/workflows/"]`
— a configured value *replaces* the list, and `.env`-named files are refused
regardless).

**`[models]`** — `default`, `conversation`, `overseer` (model spec strings,
all `"openai-codex/gpt-6-sol"` in the example), `risk_passes` (string array,
`["pass-security", "pass-prod-risk", "pass-data-safety"]`), `validate_tier`
(`PassTier`, `"sol-high"` — a *floor*, raised per round by `validatorTier` in
`src/dispatch.ts`, never lowered), `small_diff_lines` (number, `150`).
`[models.tiers]` maps each `PassTier` to a model spec; `[models.pricing]` maps
a bare model id to `{ input_per_mtok, output_per_mtok }` for spend accounting.

**`[pi]`** — `package` (`"@earendil-works/pi-coding-agent"`), `version`
(pinned; mirrored in `package.json` and the deploy variables), `session_dir`
(`"state/pi-sessions"`), `subagent_max_concurrency` (number; `6` in the
example, `4` in code).

**`[memory]`** — `context_tokens` (`2000`), `context_timeout_ms` (`3000`),
`context_quotas` (table, `{ experiences = 24 }` — since S5 only the
`experiences` key is honoured, any other is ignored with a log line), and memory
health (S1): `probe_interval_s` (`120`), `down_after_min` (`10`),
`boot_grace_min` (`5`), `rewake_h` (`6`), `incident_ticket_after_min` (`120`).
The retired `alert_cooldown_min` is ignored if still present.

**`[openviking]`** — the memory engine. `enabled` (`true`), the three pins
`version`, `llama_cpp_python_version` and `extension_commit`; identity
`user` (`"reviewer"`), `account`, `reviewer_key_file`, `auth_mode`
(`"api_key"`), `root_key_file`, `provision_users`; client behaviour
`request_timeout_ms` (`10000`), `search_timeout_ms` (`2500`),
`default_category` (`"experiences"`), `read_cache_ttl_ms` (`15000`);
process `host` (`"127.0.0.1"` — loopback only, the port is never published),
`port` (`1933`), `bin`, `home`, `config_file`, `workspace`, `workers` (`1`),
`queue_concurrency` (`2`); supervision `health_interval_s` (`30`),
`health_timeout_ms` (`2000`), `restart_backoff_ms` (array,
`[1000, 2000, 5000, 15000, 30000, 60000]`), `restart_reset_after_s` (`120`);
embeddings `embedding_provider` (`"local"`), `embedding_model`
(`"bge-small-en-v1.5-f16"` under local), `embedding_dimension` (`384` under
local), `embedding_key_file`; the local English embedder (S4)
`local_embedder_file`, `local_embedder_url`, `local_embedder_sha256` (the
model-file pin), `local_embedder_port` (`1934`), `local_embedder_threads`
(`1`).

**`[tui]`** — `target` (`"ssh"` \| `"local"`, default `"ssh"`; always
explicit, an empty `ssh_host` does not mean local), `ssh_host`, `container`
(`"quickreview-sandbox"`), `remote_state_dir` (`"/opt/quickreview/state"`),
`remote_sandbox_root` (`"/opt/quickreview/sandbox"`), `sudo_docker` (`true`),
`poll_interval_s` (`3`), `stale_after_s` (`90`), `msg_timeout_s` (`30`),
`evidence_timeout_s` (`60`), `evidence_why_interval_s` (`10`, clamped to
5–600: the evidence sweep's minimum gap between `qcr why` execs, L1).

**`[companion]`** — every key is commented out in the example because
`COMPANION_DEFAULTS` is the shipped configuration: `enabled` (`true`),
`container_name` (`"qcr-companion"`), `image`, `pihome_volume`, `session`,
`model`, and the host paths `repo_dir`, `tracker_dir`, `tracker_docs_dir`,
`reviewed_repo_dir`, `evidence_dir`, `feed_dir`, `alerts_dir`, `ssh_dir`,
`build_context` (the shipped path defaults are operator-specific — read
`COMPANION_DEFAULTS` in `src/config.ts`), plus the watcher knobs
`overdue_grace_min` (`30`), `stale_alert_s` (`300`), `awaiting_age_h` (`24`),
`cooldown_min` (`20`). `resolveCompanionPaths` expands `~` and fills the empty
ones from the sandbox root.

**`[sink]`** — `kind` (`"github"` \| `"wayfinder"` \| `"none"`, default
`"none"`), and for the wayfinder kind `root`, `effort`, `parent`,
`tickets_effort` (all `""`).

**`[backfill]`** — `bot_login`, `bot_actor`, `reviewed_label`,
`trigger_label`, `in_progress_label`, `review_team_slug`, `concurrency` (`2`),
`max_search_pages` (`10`). Each defaults off the matching `[github]` value.

**`[guards]`** — all boolean, all `true`: `downgrade_on_human_approval`,
`skip_unchanged_head`, `recheck_pr_state_before_post`,
`block_approve_on_red_ci`, `no_checks_is_red`, `refuse_on_head_drift`. Both
posting routes read these knobs — `src/guards.ts` for the daemon's own gate
and `scripts/guards.sh` for the sessions' shell route — so no route goes
around them.

**`[recheck]`** — `enabled`, `on_push`, `on_ci`, `on_base_advance`, all
boolean, all `true`. The fourth trigger, an author reply, belongs to
`src/pingpong.ts` and has no knob.

**`[review]`** — `escalation_mention_default` (string, `""`), `profile`
(string, `""`; names a directory under `profiles/`). `[review.directives]`
carries five extend-only string arrays, all `[]`:
`extra_basenames`, `extra_dir_segments`, `extra_root_dirs`, `extra_files`,
`extra_vendored_segments`. They *add* to the built-in agent-directive
vocabulary in `src/severity.ts`; nothing can remove a built-in.

**`[escalation]`** — `enabled` (bool, `false`), `shape` (`"comment"` \|
`"review_request"`, default `"comment"`), `targets` (string array of logins,
`[]`), `session_judgement` (bool, `false`), `max_per_pr` (number, `2`), and
`[[escalation.rules]]` entries (`name`, `to`, `why`, plus at least one
condition from `paths`, `labels`, `min_severity`, `failing_checks` — see
`EscalationRule` in `src/config.ts`). With
`enabled = false` nothing here is read, no rule is evaluated, no extra API
call is made, and the round prompts render no escalation text.

**`[levers]`** — `session_drain_max_min` (`30`),
`session_drain_budget_min_per_day` (`90`), `session_pause_max_min` (`240`),
`session_pause_budget_min_per_day` (`480`). Minutes, counted per `[ops]`
timezone day, and binding on *session*-issued levers only.

**`[slack]`** — `enabled` (`false`), `channel`, `channel_kind` (`"public"`),
`bot_token_file` (`"slack_bot_token"`), `app_token_file`
(`"slack_app_token"`), `post_min_interval_ms` (`1100`),
`reconnect_backoff_ms` (`[1000, 2000, 5000, 15000, 30000]`),
`server_ping_timeout_ms` (`30000`), `catchup_max_age_s` (`300`),
`max_reply_chars` (`3000`), `name_cache_ttl_s` (`86400`). One legacy alias key
for the owner's Slack id is still accepted on input and folded to
`[owner] slack_id`.

`[slack.users]` maps Slack user ids to GitHub logins.

`[slack.policy]` — `daily_turns` (`80`), `per_user_daily_turns` (`20`),
`thread_replies_per_day` (`6`), `soft_exchange_limit` (`3`),
`announcements_per_hour` (`20`), `default_cooldown_min` (`60`), `timezone`
(defaults from `[ops]`), `pickup_grace_min` (`20`), `downtime_notice_min`
(`5`), `heartbeat_interval_min` (`5`), `storm_corrections` (`5`),
`awaiting_author_stale_h` (`48`), `broadcast_verdicts` (`"never"`).

`[slack.policy.causes]` — per-cause `{ enabled, cooldown_min }`. Shipped set:
`round.overdue` (on, 60), `round.malformed_verdict` (on, 60),
`review.failed_loud` (on, 60), `pr.not_picked_up` (on, 120), `daemon.up`
(on, 0), `daemon.stopping` (on, 0), `slack.cap_reached` (on, 0),
`reconcile.storm` (off, 180), `digest.eod` (off, 0),
`pr.awaiting_author_stale` (off, 1440). Keys become per-PR at runtime
(`round.overdue:1234`), so one stuck PR can never silence another.

---

## 6. Where to look

| Question | File |
| --- | --- |
| What tables exist, and what does a column mean? | `src/state.ts` (the `SCHEMA` template, top of file) |
| How do I read or write a table? | a named method on `StateStore`, same file |
| What does a verdict file look like? | `VerdictFile` in `src/types.ts`; consumer `src/verdicts.ts` |
| What does the heartbeat contain? | `StatusSnapshot` + `buildStatusSnapshot` in `src/state.ts` |
| What does the companion see? | `TuiView` / `FeedWriter` in `src/tui/feed.ts` |
| What commands exist and who may issue them? | `COMMAND_WHITELIST` + `operatorSealVerdict` in `src/commands.ts` |
| What is a posting receipt? | `src/posting-receipt.ts`; writer `scripts/post-review.sh` |
| What does an alert file look like? | `parseAlert` in `src/tui/alerts.ts` |
| Where does a config knob get read? | `src/config.ts` — the `Config` interface and the `*_DEFAULTS` constants |
| What is a safe starting `config.toml`? | `config.example.toml` (annotated, validated by the suite) |
| Where does reviewer memory live? | `memory/README.md`, `src/memory/`, `src/openviking/` |

## See also

- [`../../config.example.toml`](../../config.example.toml) — the annotated configuration with shipped defaults
- [`../onboarding.md`](../onboarding.md) — what the guided setup writes into `config.toml`
- [`../profiles.md`](../profiles.md) — the `[review] profile` mechanism
- [`../exec-boundary.md`](../exec-boundary.md) — what the reviewer may and may not run
- [`../single-shepherd-invariant.md`](../single-shepherd-invariant.md) — the session model behind `session_commands` and `pending_wakes`
- [`../../memory/README.md`](../../memory/README.md) — reviewer memory, which is not in this database
