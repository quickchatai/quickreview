// The state records the review core reads and writes: rounds, the findings
// a round recorded, the prior-finding checks, the reviewed-head mark and the
// migration-collision delivery read. Plain shapes, so the core can hand them
// around without the SQLite store; src/state.ts is their one writer and
// re-exports them.

export interface RoundRow {
  id: number;
  pr: number;
  round_no: number;
  round_type: string;
  lenses: string;
  verdict: string | null;
  /** Legacy self-reported spend column. Never written — boot folds surviving
   * values into est_usd and every consumer reads est_usd. Kept in the DDL
   * because a live DB cannot drop it without a table rebuild. */
  spend_usd: number | null;
  duration_s: number | null;
  /** Session-written 3-4 sentence round summary (verdict file `summary`). */
  summary: string | null;
  started_at: string;
  deadline_at: string;
  finished_at: string | null;
  status: string;
  // ---- metrics / backfill columns (additive, nullable) ----
  /** Diffstat of the head this round reviewed (summed over the files API). */
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  /** 1 for rows imported from GitHub history — never live behaviour. */
  backfilled: number;
  /** GitHub review databaseId — the backfill idempotence key. */
  gh_review_id: number | null;
  gh_commit_id: string | null;
  /** Deterministic shell-post identity and confirmed outcome. Null key
   * means a legacy round whose verdict cannot be receipt-gated. */
  posting_key: string | null;
  posted_event: string | null;
  posted_at: string | null;
  /** The trigger instant this round answered, copied off pr_state at start so
   * time-to-first-verdict survives the `trigger_ts = null` reset at dispatch. */
  trigger_ts: string | null;
  // ---- measured usage (from pi session JSONLs, not self-reported) ----
  tokens_in: number | null;
  /** Output tokens including reasoning tokens. */
  tokens_out: number | null;
  tokens_cache_read: number | null;
  /** Daemon-side USD estimate (config pricing); null when a model is unpriced. */
  est_usd: number | null;
  /** The tier `pass-validate` ran at this round — recorded so a later audit
   * can tell which tier judged which finding. Null on rounds started before
   * the column existed (and on backfilled history), and on a round whose
   * profile switched the validator off. */
  validate_tier: string | null;
  /** Executed-pass telemetry: JSON array of VerdictPassEntry — the
   * passes the session ACTUALLY ran, as reported in the verdict file. Distinct
   * from `lenses`, which is the daemon's PLAN. Null = unknown (round predates
   * the field, or the session ran an older prompt and reported nothing). */
  executed_passes: string | null;
  /** Exact dispatch-time policy for classifying reasoned added passes. */
  pass_plan: string | null;
  addable_passes: string | null;
  /** When the lost-prompt net first observed this round
   * fully silent (prompt consumed, session alive, no JSONL activity). The net
   * fires only on the SECOND consecutive silent sweep; any non-silent
   * observation clears the mark. Same persistence idiom as the
   * reviewed_heads/approval_withheld marks — a mark the daemon writes so a
   * restart cannot forget it — but round-scoped, so it lives on the round
   * row rather than in a per-PR table. Null = never seen silent. */
  silent_since: string | null;
  /** The receipt token stamped into this round's wake file, echoed
   * back by pi into the session JSONL when — and only when — the prompt is
   * ACCEPTED. Null means the round was dispatched by a build that stamped no
   * marker, so its delivery is UNKNOWABLE rather than unconfirmed: readers
   * must fall back to the older inference instead of concluding "lost". */
  prompt_marker: string | null;
  /** How many times this round's prompt has been re-delivered. Cheap
   * recovery (rewrite the wake file, same round and session), bounded on its
   * own rather than out of the `max_self_requeues` budget. */
  redeliveries: number;
  /** The per-round comment count: inline comments this round posted,
   * as the session reports it in its findings record. Null = unknown (no
   * record, or a record that omitted the count) — never confused with 0. */
  comments_posted: number | null;
  /** Why this round was cancelled — null on every round that was not
   * cancelled, and on older cancellations the boot migration could not
   * classify from their prose summary. The prose stays in `summary`; this
   * is the machine-readable half every aggregate groups by. */
  cancel_cause: string | null;
  /** Bracket around dispatch-time migration-precheck posting. Existing
   * rounds migrate as unknown (never auto-replayed); new rounds start none and
   * move through ambiguous before the gated call resolves. */
  preflight_posting_state: "unknown" | "none" | "ambiguous" | "executed" | "dryrun" | "refused";
  /** First exact planned discovery execution observed by the daemon. */
  fanout_started_at: string | null;
  /** The end of this round's usage window while
   * its round-end measurement (usage, the exec-policy audit, the integrity
   * re-check) is OWED — stamped synchronously when the round end fixes the
   * window, cleared when the measurement has finished, whatever it found.
   * A non-null value at boot is a measurement a restart cut short; the
   * verdict watcher resumes it. Null = nothing owed (and every round before
   * the column). */
  usage_owed_to: string | null;
  // ---- follow-up rounds (additive, nullable) ----------------------
  /** The head this round was dispatched to review (the prepared tree's). */
  head_sha: string | null;
  /** The merge base the round's prepared tree had: the next
   * follow-up round checks it is still under its own merge base, so a
   * force-pushed base is a full round, never base drift read as the PR's. */
  merge_base: string | null;
  /** `full` | `delta` — what the round reviewed. NULL on a first round and on
   * every round before the column (a legacy non-first round was a full
   * re-review). */
  scope: string | null;
  /** A delta round's baseline: the last reviewed head it was diffed from. */
  delta_base_sha: string | null;
  /** A delta round's PR-owned change: lines (additions + deletions), files. */
  delta_lines: number | null;
  delta_files: number | null;
  /** 1 when the round's order carried the pre-approval sweep, else 0; NULL
   * on rounds that are not follow-ups. */
  sweep_owed: number | null;
  /** The sweep's plan (JSON PassPlanEntry[]), when owed. */
  sweep_plan: string | null;
  /** ran | not_owed | not_reached | unknown — what became of the sweep. */
  sweep_status: string | null;
}

/** One parsed row of the durable reasoning record. */
export interface RoundFindingRow {
  id: number;
  pr: number;
  round_id: number | null;
  round_no: number;
  head_sha: string;
  finding_key: string;
  path: string | null;
  line: number | null;
  lens: string;
  tier: string | null;
  /** 1 when the lens is not in the round's plan — the add protocol ran it. */
  unplanned: number;
  severity: string | null;
  confidence: number | null;
  reachability: string | null;
  kind: string | null;
  disposition: string;
  axis: string | null;
  word: string | null;
  reason: string | null;
  evidence: string | null;
  posted_as: string | null;
  raised_in_round: number | null;
  thread_id: number | null;
  recorded_at: string;
  /** The posted comment's title as the record wrote it; null
   * when the record carries none. */
  title: string | null;
  /** Canonical lens ids, a JSON array (`src/lensids.ts`). Null
   * only on a row the boot migration has not reached yet. */
  lens_ids: string | null;
}

/** One prior finding a follow-up round was handed, or reported on
 * (`prior_finding_checks`). */
export interface PriorFindingCheckRow {
  pr: number;
  checked_round: number;
  head_sha: string;
  round_no: number;
  finding_key: string;
  blocking: number;
  /** fixed | open | conceded | settled | obsolete | unverifiable; null =
   * listed and not (yet) reported. */
  status: string | null;
  evidence: string | null;
  listed_at: string | null;
  reported_at: string | null;
}

/**
 * What the store needs to write one recorded finding. Structural on purpose —
 * `FindingsRecordEntry` (src/findingsrecord.ts) satisfies it without state.ts
 * having to know anything about files, parsing or the record's schema.
 */
export interface RoundFindingInput {
  key: string;
  path?: string | null;
  line?: number | null;
  lens?: string | null;
  tier?: string | null;
  severity?: string | null;
  confidence?: number | null;
  reachability?: string | null;
  kind?: string | null;
  disposition?: string | null;
  axis?: string | null;
  word?: string | null;
  reason?: string | null;
  evidence?: string | null;
  posted_as?: string | null;
  raised_in_round?: number | null;
  thread_id?: number | null;
  title?: string | null;
}

/**
 * The reviewed-head mark: the last head this system actually reviewed on a
 * PR, what it decided there, and the newest author reply seen since. One row
 * per PR — the mark is a *position*, not a history; the rounds table keeps the
 * history.
 *
 * Two readers: the no-new-evidence guard (posting time and dispatch time) and
 * the post-approval delta recheck, which needs exactly `head_sha` to diff the
 * current head against. Lifecycle consumers read it only through
 * `standing-review.ts`.
 */
export interface ReviewedHeadRow {
  pr: number;
  head_sha: string;
  /** When the mark was last (re)stamped — the instant author replies race. */
  reviewed_at: string;
  /** The verdict applied at this head, when one was ("APPROVE" | …). */
  verdict: string | null;
  /** The review event actually POSTed at this head, when one was. */
  posted_event: string | null;
  round_no: number | null;
  /** Newest author reply observed after the mark was stamped (new evidence). */
  last_author_reply_at: string | null;
}

/**
 * What the event log says about one migration-collision COMMENT (the dedupe's
 * delivery read). `unknown` is an unreadable ledger row; `pending` is a
 * readable intent with unconfirmed delivery. Neither permits another POST.
 * A dry-run receipt is recorded intent, never a delivered remedy.
 */
export type CollisionCommentRecord =
  "commented" | "dryrun" | "pending" | "not_commented" | "unknown";
