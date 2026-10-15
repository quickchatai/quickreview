// Shared contracts: dispatch emits RoundOrder, the session manager consumes
// it, and verdict files close the loop.
import type { MigrationCollision } from "./migrations.js";
import type { PostingPolicy } from "./postingpolicy.js";
import type { SessionBridgeCompaction } from "./session-bridge.js";
import type { SweepClaim } from "./sweepstatus.js";

export type RoundType = "first" | "re-review" | "staleness";

/**
 * Round outcomes. `NEEDS_HUMAN` is a legacy INPUT spelling only: the review is
 * never handed to a human and there is no lifecycle state for it. A verdict
 * file that still says NEEDS_HUMAN lands the PR on `tracked`: the review is
 * posted, no approval is implied, and the AI keeps driving. Nothing waits for
 * a person.
 */
export const VERDICTS = ["APPROVE", "REQUEST_CHANGES", "NEEDS_HUMAN"] as const;

export type Verdict = (typeof VERDICTS)[number];

/**
 * Accept a verdict string, tolerating the legacy `ESCALATE` spelling.
 *
 * The alias stays because escalation is a real (default-off) feature, so the
 * vocabulary is live rather than dead. It never parks: ESCALATE folds to
 * NEEDS_HUMAN, which the state machine lands on `tracked`. Returns null for
 * anything else.
 */
export function normalizeVerdict(raw: unknown): Verdict | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  if (v === "ESCALATE") return "NEEDS_HUMAN";
  return (VERDICTS as readonly string[]).includes(v) ? (v as Verdict) : null;
}

/**
 * The per-round prompt receipt token.
 *
 * Deliberately plain ASCII with no JSON metacharacters, so it survives the
 * session JSONL's string encoding byte-for-byte and a raw substring search
 * over the file is exact. Deliberately an HTML comment, so it is inert to the
 * model reading the prompt.
 *
 * Keyed on (pr, round_no) rather than round_id: round_no is what the session
 * writes into its verdict file and its ledger, so a human reading a JSONL can
 * match the token to the round without opening the database.
 */
export function roundPromptMarker(pr: number, roundNo: number): string {
  return `<!-- qcr-round: pr-${pr} round-${roundNo} -->`;
}

/**
 * The per-nudge receipt token for a post-approval recheck.
 *
 * A recheck needs a receipt more than a round does: a round has a deadline
 * underneath it, but a `rechecks` claim has none. Without a receipt, a nudge
 * dropped in delivery would leave a claim that suppresses the reconcile
 * push-backstop forever, so a delta on an APPROVED PR would never be
 * audited.
 *
 * Keyed on the recheck fingerprint, which is exactly what the claim is keyed
 * on — so the sweep can ask "did the nudge I claimed actually land?".
 */
export function recheckPromptMarker(pr: number, fingerprint: string): string {
  return `<!-- qcr-recheck: pr-${pr} ${fingerprint} -->`;
}

/** The inverse of `recheckPromptMarker`: the claim a stamped recheck nudge
 * carries (a nudge evicted from the held queue releases exactly that
 * claim). The LAST marker wins, as `stampPrompt` appends it; null when the
 * text carries none. */
export function parseRecheckPromptMarker(text: string): { pr: number; fingerprint: string } | null {
  let found: { pr: number; fingerprint: string } | null = null;
  for (const m of text.matchAll(/<!-- qcr-recheck: pr-(\d+) (\S+) -->/g))
    found = { pr: Number(m[1]), fingerprint: m[2]! };
  return found;
}

/** Append a receipt token to a rendered prompt. Appended, not prepended: the
 * templates open with the instruction that sets the session's frame, and
 * nothing should come before it. */
export function stampPrompt(renderedPrompt: string, marker: string): string {
  return `${renderedPrompt.replace(/\s+$/, "")}\n\n${marker}\n`;
}

/** The round-shaped wrapper around `stampPrompt`. */
export function stampRoundPrompt(renderedPrompt: string, pr: number, roundNo: number): string {
  return stampPrompt(renderedPrompt, roundPromptMarker(pr, roundNo));
}

/** The tier ladder, ascending by capability/cost. The one place the tiers
 * and their order are written down. */
export const PASS_TIER_ORDER = ["terra-med", "sol-med", "sol-high"] as const;

/** Pass model tiers. */
export type PassTier = (typeof PASS_TIER_ORDER)[number];

/** The higher of two tiers (equal tiers return that tier). */
export function higherTier(a: PassTier, b: PassTier): PassTier {
  return PASS_TIER_ORDER.indexOf(b) > PASS_TIER_ORDER.indexOf(a) ? b : a;
}

/** Every tier at or above `floor`, ascending. */
export function tiersAtOrAbove(floor: PassTier): PassTier[] {
  return PASS_TIER_ORDER.slice(PASS_TIER_ORDER.indexOf(floor));
}

/** One planned pass in a round: the lens, the tier-variant agent that runs it
 * (`${lens}--${tier}`), and the higher-tier variant agent names the session
 * may raise to ([] when already at the top or the tier is fixed). */
export interface PassPlanEntry {
  lens: string;
  agent: string;
  tier: PassTier;
  raisable_to: string[];
  /** Why a content-triggered sub-lens is in the plan (heuristics.ts
   * SUBLENS_TRIGGERS) — shown to the session and passed on as the lens's
   * starting point. Absent for path-selected lenses. */
  why?: string;
  /** The files this row's pass covers — set on sweep rows only: one row per
   * group of changed files, several rows calling the same agent. */
  focus?: string[];
  /** Set on the rows a round may not post without: pass-baseline (every
   * split row) and the risk passes (`[models] risk_passes`). One of these
   * failed and never completed is a round that posts nothing and is
   * requeued (src/requiredpasses.ts). Absent on every other row, and on
   * plans recorded before the field existed. */
  required?: true;
}

/** One prior open finding as a lens's task file carries it. */
export interface PriorTaskEntry {
  /** `<round_no>:<finding_key>` — the ref the session reports. */
  ref: string;
  /** `path:line`, or `(no anchor)`. */
  where: string;
  /** Posted tag and severity, e.g. `[blocker] P1`. */
  tag: string;
  /** The lens(es) that raised it. */
  lens: string;
  title: string;
  /** Its file has no change since the last review (not in the delta). */
  unchanged: boolean;
  /** The last round's report left it open (or it was posted then). */
  held_last_round: boolean;
}

/** The prior findings the daemon put into one plan row's task file. */
export interface PriorAssignment {
  /** Index into `pass_plan`. */
  row: number;
  priors: PriorTaskEntry[];
}

export interface RoundRecoveryContext {
  /** Only the exact, pre-publication stage is eligible for automatic replay. */
  stage: "first_pass_start";
  source_round_no: number;
  source_command_id: string;
  /** The head this successor order actually reviews. */
  target_head_sha: string;
  /** 1..N inside the ordinary immediate retry burst. */
  immediate_attempt: number;
  /** Zero for immediate retries; increments for each delayed circuit-breaker
   * generation and is carried through any same-generation fast retries. */
  retry_epoch: number;
  source_incident_id?: string;
}

export interface RoundOrder {
  pr: number;
  title: string;
  round_id: number;
  round_no: number;
  /** Posting identity carried through the guarded shell posting route. */
  posting_key?: string;
  /** The PR's review age: prior VERDICTED rounds + 1. round_no stays the
   * audit-unique sequence (cancelled rounds included); review_no drives
   * age-keyed behaviour (nit cap) so failed rounds don't age the PR. */
  review_no?: number;
  round_type: RoundType;
  /** Compat: the pass_plan lenses, in order (pass_plan is authoritative). */
  lenses: string[];
  /** The planned passes for this round, tiered. */
  pass_plan: PassPlanEntry[];
  /** Lenses NOT selected for this round that the session may add. */
  addable_lenses: string[];
  /** The addable lenses whose add variant is NOT the templates' own
   * rule (`sol-med`, or `sol-high` for a risk pass) — the ones a profile
   * `min_tier` floors higher, lens → tier. Absent ⇒ the rule holds for all. */
  addable_tiers?: Record<string, PassTier>;
  /** Changed files past the sweep's per-round cap — named in the plan so a
   * capped sweep never reads as full coverage. */
  sweep_unswept?: string[];
  /** The rendered third-party-sources block (src/depsources.ts), carried
   * into every pass's task string. Absent or "" ⇒ nothing was unpacked. */
  dependency_note?: string;
  /** `[review] nits = "open"`: the round lifts the nit limits. Absent ⇒ strict. */
  nit_policy?: "open";
  /** The profile's `[posting]` policy (src/postingpolicy.ts). Absent ⇒
   * the default posting: no note renders and nothing is enforced. */
  posting_policy?: PostingPolicy;
  migration_gate: boolean;
  /**
   * Migration-number collisions with the base branch that the daemon detected
   * itself and already delivered to the PR as a COMMENT. Mechanics:
   * they are not findings, they never block, and they consume no verdict.
   * Absent on orders built before the pre-check existed.
   */
  migration_collisions?: MigrationCollision[];
  /**
   * True when those collisions' COMMENT did NOT reach the PR this round
   * (withheld over an unreadable ledger row, refused by a posting guard, or
   * the gated call failed). The gate note then tells the session to carry the
   * remedy in its review body — still mechanics, never a blocker — instead of
   * claiming it was posted. Absent ⇒ delivered (or no collisions).
   */
  migration_collisions_undelivered?: boolean;
  /**
   * True when this PR touches migrations and the collision pre-check could
   * NOT run this round (no base reader, no base sha, or the base read threw).
   * The prompt then tells the session the pre-check did not run and that IT
   * must check base-branch migration-number collisions itself — which is what
   * conditionally lifts the pass-data-safety withdrawal (a degraded pre-check
   * is never quieter). Absent on orders built before the field existed.
   */
  migration_precheck_degraded?: boolean;
  /**
   * The PR touches first-party agent-directive files (.claude/**,
   * prompts/**, AGENTS.md/CLAUDE.md and kin — `isFirstPartyDirectivePath`).
   * `files` lists them; `mention` is the deterministically-picked teammate
   * the one security-attention comment @-mentions (most recent human author
   * of the touched directive files at the merge base, falling back to config
   * `[review] escalation_mention_default`; the pick is logged). That comment
   * is posted only when a malicious or source-to-sink injection finding in
   * those files survives (`renderDirectiveEscalationNote`). Absent when
   * the PR touches no such file — and on orders built before the field
   * existed.
   */
  first_party_directives?: { files: string[]; mention: string };
  /**
   * The logins this round's session may escalate to on its own
   * judgement. Present ONLY when `[escalation] enabled = true` AND
   * `session_judgement = true` — so on a default install (escalation off) the
   * field is absent and `{{escalation_note}}` renders empty, so the round
   * prompt carries no escalation text at all — differing from a build without
   * the feature by whitespace only, which tests/escalation.test.ts pins.
   *
   * The list is advisory to the session and BINDING on the daemon: an
   * escalation naming anything else is dropped in `escalation.ts`, not argued
   * with. The deterministic rules do not appear here at all — the daemon
   * evaluates and delivers those itself, with no model in the loop.
   */
  escalation_targets?: string[];
  /** Daemon-authored, exact predecessor identity for a fresh parent
   * recovering a proven pre-fanout stall. Absent on ordinary rounds. */
  recovery?: RoundRecoveryContext;
  /** The sha the worktree is ACTUALLY at — reconciled against the fetched
   * `refs/pull/<n>/head` before the order is built, not the webhook snapshot. */
  head_sha: string;
  /** The branch this PR targets (GitHub `base.ref`), fetched fresh each round
   * into `refs/remotes/origin/<base_ref>` in the base clone. */
  base_ref: string;
  /** Tip of `base_ref` at fetch time — what "against master" means this round. */
  base_sha: string;
  /** merge-base(base_sha, head_sha): where this PR left the base branch.
   * Empty when git could not compute one (shallow/unrelated histories). */
  merge_base: string;
  worktree: string;
  /** The PR body as GitHub returned it: rendered verbatim into the
   * round prompt's INTENT block when `pass-intent` is planned — the lens's
   * entire intent artifact. Absent on orders built before the field existed
   * and on orders whose adapter read failed (no intent lens either way). */
  pr_body?: string;
  /** SETTLED digest: the `SETTLED:` items of the PR's mirrored ledger
   * (`state/ledgers/pr-<n>.md`), bounded — src/ledgercarry.ts. ""
   * when there is no ledger or it settles nothing. */
  settled_digest: string;
  /** The PR's ledger as ledger-pin last mirrored it, re-handed to the session
   * every round and rendered as `{{ledger_note}}`. Absent when there is no
   * readable ledger for this PR: nothing renders for it. */
  ledger_carry?: LedgerCarry;
  issued_at: string;
  /** `[review] task_files` (src/passtasks.ts): the discovery rows' task files
   * the daemon wrote for this round — plan row index, agent, absolute path.
   * Absent ⇒ the session writes every task string itself. */
  pass_task_files?: Array<{ row: number; agent: string; path: string }>;
  /** `[review] render_outputs` (src/reviewrender.ts): the session writes the
   * findings record with the posting fields and renders the review body and
   * inline comments from it with `scripts/render-review.sh`. */
  render_outputs?: boolean;
  /** `[review] validator_shards` above 1: how many pass-validate children
   * split this round's candidates (by file). Absent ⇒ one validator. */
  validator_shards?: number;
  /** `[review] dedup_merge` (docs/duplicate-merge.md): the round groups its
   * candidates with the `cluster_findings` tool before the validator. Absent
   * ⇒ no merge step renders. */
  dedup_merge?: boolean;
  /** `[review] validate_compact`: the validator answers with a decision
   * table keyed by candidate id. Absent ⇒ no compact-answer instruction
   * renders. */
  validate_compact?: boolean;
  /** `[review] coverage_check` (src/coverage.ts): the changed non-test
   * source files the round holds itself to — after the lenses, the ones no
   * lens raised a finding on get a targeted pass-sweep row. Absent ⇒ no
   * coverage check renders. */
  coverage_files?: Array<{ path: string; lines: number }>;
  /** docs/follow-up-rounds.md: `"delta"` ⇒ a FOLLOW-UP round,
   * rendered from `prompts/round-follow-up.md` — prior findings verified,
   * the PR-owned change since the last reviewed head reviewed, one
   * pre-approval sweep when owed. Absent or `"full"` ⇒ the round renders
   * from its `round_type`'s template. */
  scope?: "delta" | "full";
  /** The PR-owned change since the last reviewed head (a `scope: "delta"`
   * round): rendered as `{{delta_note}}`. */
  delta?: RoundDelta;
  /** The daemon-rendered list of prior open findings to verify
   * (src/priorfindings.ts `renderPriorFindingsNote`), as
   * `{{prior_findings_note}}`. */
  prior_findings_note?: string;
  /** The listed prior findings, each already assigned to the
   * plan row that owns it and written into that row's task file
   * (src/priorfindings.ts `assignPriorFindings`). Absent ⇒ the session
   * assigns them through `launch_plan`'s `extra`. */
  prior_assignments?: PriorAssignment[];
  /** The pre-approval sweep's plan — present only when the sweep is owed
   * this round. Never part of `pass_plan`/`lenses`: it runs only when the
   * round would approve. Rendered as `{{sweep_note}}`. */
  sweep_plan?: PassPlanEntry[];
  /** The full plan's files left over the per-round sweep cap (its
   * `sweep_unswept`) — present only beside `sweep_plan`, and rendered in
   * `{{sweep_note}}` as round 1 renders its own. */
  sweep_plan_unswept?: string[];
  /** `[review] context_pack = "pack-first"`: the round's context pack,
   * written beside its task files (src/contextpack.ts). The task files then
   * point at it; absent ⇒ no task file mentions a pack. */
  context_pack_file?: string;
  /** Task files written for the sweep's rows (their own directory and row
   * index — `row` indexes `sweep_plan`). Absent ⇒ the session writes the
   * sweep's task strings itself. */
  sweep_task_files?: Array<{ row: number; agent: string; path: string }>;
  /** `[review] follow_up_extent = "session"`: the follow-up plan's
   * OPTIONAL rows — the full delta plan's per-file sweep rows and quality /
   * style lenses — that the main session runs, partly runs or skips, and
   * their task files (`row` indexes `optional_plan`). */
  optional_plan?: PassPlanEntry[];
  optional_task_files?: Array<{ row: number; agent: string; path: string }>;
  /** Set when the session decides the follow-up round's extent —
   * the optional rows and whether an owed pre-approval sweep runs. Absent ⇒
   * the fixed rules. */
  follow_up_extent?: "session";
}

/** One file of a follow-up round's delta (worktrees.ts `PrOwnedDeltaFile`,
 * minus the hunk text, which rides the patch file). */
export interface RoundDeltaFile {
  /** The path at the new head (the old path for a deleted file). */
  path: string;
  /** The path at the replayed reviewed head, when a rename/copy moved it. */
  old_path?: string;
  /** added | modified | removed | renamed | copied | changed. */
  status: string;
  /** Changed lines at the new head, `[start, count]` (count 0 = a deletion
   * point after line `start`). */
  ranges: Array<[number, number]>;
  /** The whole file is in scope (deleted, binary, unreadable hunks, a
   * conflict resolution): `ranges` is a hint at most. */
  whole_file?: boolean;
  /** The replay of the reviewed head conflicted here: the author resolved
   * it by hand, so the file is audited against both parents. */
  conflict?: boolean;
}

/** The PR-owned change since the last reviewed head: the reviewed
 * head replayed onto this round's merge base (`tree`), diffed against the new
 * head, so base-branch merges cancel out. */
export interface RoundDelta {
  /** The last reviewed head. */
  from_sha: string;
  /** The synthetic tree: `from_sha` replayed onto this round's merge base. */
  tree: string;
  /** additions + deletions over every file. */
  lines: number;
  files: RoundDeltaFile[];
  /** Absolute path of the whole delta's patch, written by the daemon. */
  patch_file: string;
}

/** What a round order carries of the PR's ledger (src/ledgercarry.ts). */
export interface LedgerCarry {
  /** Where the daemon read it: the ledger-pin mirror. */
  source: string;
  /** The block's header line as written, e.g. `LEDGER PR #42 @ abc1234`. */
  header: string;
  /** The block, verbatim up to the cap. */
  text: string;
  /** True when `text` was cut at the cap. */
  truncated: boolean;
  /** The full block's length in characters, before any cut. */
  total_chars: number;
}

/**
 * Executed-pass telemetry: one entry per pass the session actually launched
 * via the subagent tool AND got a return from — real returns only, never the
 * plan table. This record is what lets the daemon see the difference between
 * the plan (`rounds.lenses`) and what actually ran.
 */
export interface VerdictPassEntry {
  /** Lens name as planned/launched, e.g. "pass-baseline", "pass-validate". */
  name: string;
  /** Tier/model variant the pass actually ran at (raises included),
   * e.g. "sol-med". Null when the session did not report one. */
  tier?: string | null;
  /** Required for a pass launched through this round's add protocol; absent
   * on deterministic planned passes and legacy verdicts. */
  reason?: string | null;
  /** Candidate findings the pass returned. */
  findings?: number | null;
  /** Validator outcome counts (meaningful on pass-validate): candidates that
   * survived its veto, were killed, or were downgraded. */
  survived?: number | null;
  killed?: number | null;
  downgraded?: number | null;
  /** Merge-stage dispositions, reported on the pass-validate entry:
   * same-defect candidates collapsed at the session's merge step (`MERGED
   * <src> into <dst>` lines) and different-defect candidates folded as a
   * paragraph under a surviving comment (`FOLDED <src> under <dst>` lines).
   * Additive — older verdicts simply omit them (null/undefined = unknown). */
  merged?: number | null;
  folded?: number | null;
  /** Which stage of a follow-up round launched the pass — the
   * step-2 change review (`delta`) or the pre-approval sweep (`sweep`).
   * Absent on every other round. */
  phase?: "delta" | "sweep" | null;
}

/** verdict/pr-<n>-round-<k>.json — written by the PR session at round end:
 * a merits verdict, or the guard-5 `head_moved` ending, which carries none. */
export type VerdictFile = MeritsVerdictFile | HeadMovedVerdictFile;

/**
 * Guard-5 landing: a session refused at posting time because the PR
 * advanced mid-round writes `outcome: "head_moved"` INSTEAD of a merits
 * verdict — a cheap, explicit round ending the daemon maps to an immediate
 * cancel + capped self-requeue against the fresh head (the same
 * self-requeue counter; the session is healthy and is NOT killed). The file
 * carries no `verdict`; `head_sha` is the stale head the round reviewed. It
 * spares the round idling to its deadline and a healthy session being killed
 * by the recovery path.
 */
export type HeadMovedVerdictFile = Omit<MeritsVerdictFile, "verdict" | "outcome"> & {
  outcome: "head_moved";
  verdict?: undefined;
};

/** A round's decided verdict file. */
export interface MeritsVerdictFile {
  pr: number;
  round_no: number;
  verdict: Verdict;
  /** Only the guard-5 landing carries an outcome (`HeadMovedVerdictFile`). */
  outcome?: undefined;
  /** Soundness marker on NEEDS_HUMAN: "the PR looks otherwise sound, I just
   * cannot decide". Recorded, never acted on. */
  ai_approved?: boolean;
  /**
   * Set by the session when the code judgment was "no blockers" but the
   * approval could not be given because CI is not green at this head.
   * The review was posted as a COMMENT; the daemon records the
   * withholding and re-queues the PR when CI goes green there.
   */
  approval_withheld?: boolean;
  /** What became of a follow-up round's pre-approval sweep (`SweepClaim`:
   * `ran`, `not_owed`, `not_reached` or `skipped`). Session-written; absent
   * on other rounds. */
  sweep?: SweepClaim;
  /** Why the session skipped an owed pre-approval sweep. */
  sweep_reason?: string;
  /** What the session did with the follow-up plan's optional rows —
   * all run, some run, none run — and why. */
  extent?: "ran" | "partial" | "skipped";
  extent_reason?: string;
  head_sha: string;
  /** Retired: a self-reported figure the models copied from the template.
   * Accepted in any shape and stripped by `validateVerdict`, so no consumer
   * ever sees it; spend is measured from the session transcripts. */
  spend_usd?: unknown;
  ledger_snapshot?: string;
  /** 3-4 sentence plain-prose "what is going on" written by the session for
   * the operator's TUI detail pane. Optional; capped by the consumer. */
  summary?: string;
  /**
   * Executed-pass telemetry. Optional: sessions running older round
   * prompts omit it, and the consumer treats absent/malformed as UNKNOWN —
   * logged, never a verdict rejection (same tolerant-input discipline as the
   * pr/round_no digit-string coercion).
   */
  passes?: VerdictPassEntry[];
  /**
   * Session-judgement escalations — entries the session asks the
   * daemon to deliver BESIDE this verdict. Only read when
   * `[escalation] enabled = true` AND `session_judgement = true`; every entry
   * is validated daemon-side (target must be a configured one, scope must
   * name something concrete) and silently dropped otherwise.
   *
   * Deliberately typed `unknown[]`: this is model-written input, normalized by
   * `escalation.ts normalizeSessionEscalations` and never trusted to be
   * well-shaped. A malformed entry costs a log line — it can never fail, delay
   * or alter the verdict this file carries.
   */
  escalations?: unknown[];
  finished_at: string;
}

/** The daemon↔session boundary (`SessionHooks` below). The daemon codes
 * against it, sessions.ts implements it, and a disk-logging stub lets the
 * daemon run end-to-end without pi. */
export type SessionCommandRetryResult =
  "retried" | "settled" | "round_finished" | "accepted_race" | "retry_failed";
/** What one same-session REDELIVERY did
 * (`SessionHooks.redeliverSessionCommand`): `redelivered` — the row is back in
 * `pending` and its file rewritten, the session untouched; `started` /
 * `settled` — the command started or ended meanwhile, nothing to redeliver;
 * `raced` — a bridge reserved it between the read and the write (look again
 * later); `not_live` — no live, bridge-ready session to redeliver into (the
 * kill-and-replay recovery owns that); `redelivery_failed` — the payload is
 * gone or altered, or the write failed. */
export type SessionCommandRedeliveryResult =
  "redelivered" | "started" | "settled" | "raced" | "not_live" | "redelivery_failed";
/** The row the supervisor found DUE, as `redeliverSessionCommand` must find it
 * still: the CAS is on what the supervisor saw, never on
 * a fresh read — a bridge that reserved the command after the due check moved
 * `attempt` and `next_check_at`, and that fresh submission is not stale. */
export interface SessionCommandObservation {
  attempt: number;
  redeliveries: number;
  next_check_at: string;
}
/** The inject bridge's compaction report, as `SessionHooks.sessionCompaction`
 * returns it: the `compaction` block of the bridge's ready receipt, as
 * `src/session-bridge.ts` declares it. */
export type SessionCompactionReport = SessionBridgeCompaction;
/** What the round-stage supervisor's failure callback did with a stage limit.
 * `posted_wait`: the round's review is already on GitHub (or
 * was refused by guard 2), so the limit is NOT a failure — the session's tail
 * is given its bounded grace and nothing is cancelled, killed or requeued. */
export type RoundRecoveryDisposition =
  "requeued" | "exhausted" | "retryable" | "failed_loud" | "settled" | "posted_wait";

/** What one stale raw-tier sweep did
 * (`PiSessionManager.sweepStaleOvSessions`): the `pr-<n>` OpenViking sessions
 * of closed PRs it deleted, the ones it could not, and what it left for a
 * later pass. `error` = the server's session list could not be read, so
 * nothing was attempted. */
export interface OvSessionSweepReport {
  listed: number;
  stale: number;
  deleted: string[];
  failed: string[];
  deferred: number;
  error?: string;
}

export interface SessionHooks {
  /** Ensure the per-PR session exists (birth on first trigger) and inject the
   * rendered round prompt. */
  dispatchRound(order: RoundOrder, renderedPrompt: string): Promise<void>;
  /** Wake the session outside a round (ping-pong, anomaly follow-ups). */
  inject(pr: number, message: string): Promise<void>;
  /** Inject into the overseer session (anomalies, EOD sweep). */
  injectOverseer(message: string): Promise<void>;
  /** PR merged/closed: archive session JSONL + ledger, drop worktree, kill tmux. */
  archiveAndClose(pr: number): Promise<void>;
  /** The reconcile pass's sweep over the raw tier: delete the
   * OpenViking sessions of closed PRs that are still on the server, bounded
   * per pass. Optional — stubs and a daemon with no raw tier omit it (null =
   * no raw tier managed). Never a reconcile error: memory never blocks. */
  sweepStaleOvSessions?(): Promise<OvSessionSweepReport | null>;
  /** After a round's verdict lands: compact the sticky conversation, since
   * cache re-reads of a long conversation dominate cost and sessions do not
   * compact on their own. A REQUEST to the session's inject bridge, which
   * runs it once nothing is in flight and holds every wake until it ends — never a keystroke into the pane. Optional — stubs may omit it. */
  compactSession?(pr: number): Promise<void>;
  /** Is the PR's session alive (tmux session present)? The stuck-round
   * detector reads this — the existing liveness signal, not a new one.
   * Optional: absent (stubs, tests) ⇒ liveness is unknown and the deadline
   * checker treats an overdue round as not stuck: the overdue-anomaly path
   * stands, with no self-requeue. */
  sessionAlive?(pr: number): Promise<boolean>;
  /** Kill the PR's tmux session so the next dispatch rebirths it fresh. Read
   * by the live-but-stuck self-requeue: an overdue round whose session is
   * alive but wedged is killed + requeued instead of left to the anomaly
   * path. Optional: absent ⇒ a live-but-stuck round is not requeued (a fresh
   * round is never injected into a wedged live session). */
  killSession?(pr: number): Promise<void>;
  /** Milliseconds-epoch mtime of the newest pi session JSONL for this PR, or
   * null when unknown. Read by the lost-prompt net: a round whose inject was
   * consumed while the session shows no activity since the round started
   * never received its prompt. Optional: absent ⇒ no net. */
  sessionActivityAt?(pr: number): Promise<number | null>;
  /** Is any wake file still pending (unconsumed) in the PR session's inject
   * dir? Read by the same net — a pending file means the bridge is still
   * retrying delivery, which is patience, not loss. Optional as above. */
  injectPending?(pr: number): Promise<boolean>;
  /**
   * Did this round's prompt actually reach the session?
   *
   * The ONE positive delivery fact in the system. `dispatchRound` stamps a
   * receipt token into the wake file; pi writes the user message it accepted
   * — token and all — into the session JSONL. Present ⇒ delivered. Absent ⇒
   * never delivered, which an mtime inference cannot express: a prompt is
   * dropped BECAUSE the agent is busy, and a busy agent always bumps the
   * mtime after the round started.
   *
   * `null` means "cannot tell" and must never be read as loss.
   * Optional: absent ⇒ no receipt check.
   */
  roundPromptAccepted?(pr: number, roundNo: number, startedAtMs: number): Promise<boolean | null>;
  /**
   * The general form of the same receipt read: did a wake carrying
   * `marker` reach the session? Used by the undelivered-recheck sweep, which
   * has no round row to hang `roundPromptAccepted` off — and needs it more,
   * because a recheck claim has no deadline underneath it.
   * `null` = cannot tell. Optional: absent ⇒ no sweep.
   */
  wakeReceiptPresent?(pr: number, marker: string, sinceMs: number): Promise<boolean | null>;
  /**
   * Re-deliver a round prompt whose receipt never appeared — the same
   * round, session and conversation, with the exact dispatched bytes written
   * to the inject dir again. The CHEAP recovery, deliberately distinct from
   * `selfRequeue`: no round is cancelled, no session is killed, no GitHub
   * state is touched, and the self-requeue budget is not spent.
   *
   * False when the dispatched prompt is no longer on disk — the caller then
   * falls through to the expensive recovery rather than inventing an order.
   * Optional: absent ⇒ the expensive path only.
   */
  redeliverRound?(pr: number, roundNo: number): Promise<boolean>;
  /** Safely retry one durable command after a finite lease
   * expires. The production manager kills and verifies the old sticky session
   * first, then reuses the same id/path/bytes and rebirths the session. It may
   * replay an accepted non-round wake; rounds retain the stricter pre-start
   * rule because their merits lifecycle owns accepted-run recovery. */
  retrySessionCommand?(commandId: string, reason: string): Promise<SessionCommandRetryResult>;
  /** The CHEAP recovery for a command whose start
   * lease ran out on a live, bridge-ready session — the same row handed back
   * to `pending` and the same bytes rewritten at the same path, the session
   * and its conversation left alone. The bridge resubmits only when pi
   * provably holds nothing of it. `observed` is the row the supervisor found
   * due; a row that moved since is `raced`, never requeued. Optional: absent ⇒
   * the kill-and-replay recovery only. */
  redeliverSessionCommand?(
    commandId: string,
    observed: SessionCommandObservation,
  ): Promise<SessionCommandRedeliveryResult>;
  /** What the PR session's inject bridge reports about pi's
   * compaction, or null when unknown (no live bridge generation — tmux gone
   * included, so a pi that died mid-compaction never reads "running" — an
   * older bridge, an unreadable receipt). A compaction holds the session's mailbox,
   * so a command waiting behind one is late, not lost. Optional: absent ⇒ no
   * compaction is ever known about. */
  sessionCompaction?(pr: number): Promise<SessionCompactionReport | null>;
}
