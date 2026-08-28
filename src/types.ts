// Shared cross-slice contracts. B2's dispatch emits RoundOrder; B3's session
// manager consumes it; verdict files close the loop (spec §3–4).
import type { MigrationCollision } from "./migrations.js";

export type RoundType = "first" | "re-review" | "staleness";

/**
 * Round outcomes. The escalation mechanics were scrapped on 2026-08-18
 * (the owner): the daemon no longer scores PRs for "escalation-worthiness" and
 * never requests a human reviewer on GitHub. What survives is the park:
 * NEEDS_HUMAN means the session could not decide, so the PR stops on
 * `awaiting_human` and waits for a person. No GitHub mutation is involved —
 * the state is daemon-side only, surfaced through the TUI and Slack.
 */
export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "NEEDS_HUMAN";

export const VERDICTS: readonly Verdict[] = ["APPROVE", "REQUEST_CHANGES", "NEEDS_HUMAN"];

/**
 * Accept a verdict string, tolerating the retired `ESCALATE` spelling.
 *
 * This alias is load-bearing, not just rollout slack: `prompts/
 * conversation-system.md` is frozen seeded content (CLAUDE.md rule 6) and its
 * steps 5/7 still say ESCALATE. Until the owner ratifies a reseed, a session
 * following its system prompt writes ESCALATE and must still park correctly.
 * Returns null for anything else.
 */
export function normalizeVerdict(raw: unknown): Verdict | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  if (v === "ESCALATE") return "NEEDS_HUMAN";
  return (VERDICTS as readonly string[]).includes(v) ? (v as Verdict) : null;
}

/**
 * The per-round prompt receipt token (#5362).
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
 * The per-nudge receipt token for a post-approval recheck (#5362 W2).
 *
 * A recheck needs a receipt MORE than a round does, not less: a round has a
 * deadline underneath it, but `rechecks` is an append-only claim table with no
 * deadline, no sweep and no expiry. A nudge dropped in delivery therefore left
 * a claim that suppressed the reconcile push-backstop forever, so a delta on
 * an APPROVED PR was silently never audited and the approval stood over code
 * nobody read.
 *
 * Keyed on the recheck fingerprint, which is exactly what the claim is keyed
 * on — so the sweep can ask "did the nudge I claimed actually land?".
 */
export function recheckPromptMarker(pr: number, fingerprint: string): string {
  return `<!-- qcr-recheck: pr-${pr} ${fingerprint} -->`;
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

/** Pass model tiers, ascending by capability/cost. */
export type PassTier = "terra-med" | "sol-med" | "sol-high";

/** The tier ladder, ascending. The one place the order is written down. */
export const PASS_TIER_ORDER: readonly PassTier[] = ["terra-med", "sol-med", "sol-high"];

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
}

export interface RoundOrder {
  pr: number;
  title: string;
  round_id: number;
  round_no: number;
  /** identity carried through the guarded shell posting route. */
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
  migration_gate: boolean;
  /**
   * Migration-number collisions with the base branch that the daemon detected
   * itself and already delivered to the PR as a COMMENT. Mechanics:
   * they are not findings, they never block, and they consume no verdict.
   * Absent on orders built before the pre-check existed.
   */
  migration_collisions?: MigrationCollision[];
  /**
   * True when this PR touches migrations and the collision pre-check could
   * NOT run this round (no base reader, no base sha, or the base read threw).
   * The prompt then tells the session the pre-check did not run and that IT
   * must check base-branch migration-number collisions itself — which is what
   * conditionally lifts the pass-data-safety withdrawal (degraded is
   * never quieter). Absent on orders built before the field existed.
   */
  migration_precheck_degraded?: boolean;
  /**
   * the PR touches first-party agent-directive files (.claude/**,
   * prompts/**, AGENTS.md/CLAUDE.md and kin — `isFirstPartyDirectivePath`).
   * `files` lists them; `mention` is the deterministically-picked teammate the
   * ONE escalation comment must @-mention (most recent human author of the
   * touched directive files at the merge base, falling back to config
   * `[review] escalation_mention_default`; the pick is logged). Absent when
   * the PR touches no such file — and on orders built before the field
   * existed.
   */
  first_party_directives?: { files: string[]; mention: string };
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
  /** SETTLED digest carried from the last verdict's ledger snapshot. */
  settled_digest: string;
  issued_at: string;
}

/**
 * Executed-pass telemetry: one entry per pass the session actually
 * launched via the subagent tool AND got a return from — real returns only,
 * never the plan table. The first-night audit (F2) found posted "Lenses
 * applied" lines claiming lenses on rounds where zero passes ran; this record
 * is what lets the daemon see the difference between the plan
 * (`rounds.lenses`) and reality.
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
}

/** verdict/pr-<n>-round-<k>.json — written by the PR session at round end. */
export interface VerdictFile {
  pr: number;
  round_no: number;
  verdict: Verdict;
  /**
   * Guard-5 landing (follow-up): a session refused at posting
   * time because the PR advanced mid-round writes `outcome: "head_moved"`
   * INSTEAD of a merits verdict — a cheap, explicit round ending the daemon
   * maps to an immediate cancel + capped self-requeue against the fresh head
   * (same counter; the session is healthy and is NOT killed).
   * `verdict` is absent/ignored on such a file; `head_sha` is the stale head
   * the round reviewed. Without this the round idled to deadline expiry and
   * the recovery path killed a perfectly healthy session.
   */
  outcome?: "head_moved";
  /** Soundness marker on NEEDS_HUMAN: "the PR looks otherwise sound, I just
   * cannot decide". Recorded, never acted on. */
  ai_approved?: boolean;
  /**
   * Set by the session when the code judgment was "no blockers" but the
   * approval could not be given because CI is not green at this head
   *. The review was posted as a COMMENT; the daemon records the
   * withholding and re-queues the PR when CI goes green there.
   */
  approval_withheld?: boolean;
  head_sha: string;
  spend_usd?: number;
  ledger_snapshot?: string;
  /** 3-4 sentence plain-prose "what is going on" written by the session for
   * the owner's TUI detail pane. Optional; capped by the consumer. */
  summary?: string;
  /**
   * Executed-pass telemetry. Optional: sessions running older round
   * prompts omit it, and the consumer treats absent/malformed as UNKNOWN —
   * logged, never a verdict rejection (same tolerant-input discipline as the
   * pr/round_no digit-string coercion).
   */
  passes?: VerdictPassEntry[];
  finished_at: string;
}

/** The daemon↔session boundary. B2 codes against this; B3 implements it; B2
 * ships a disk-logging stub so the daemon runs end-to-end without pi. */
export type SessionCommandRetryResult = "retried" | "round_finished" | "accepted_race" | "retry_failed";
export type RoundRecoveryDisposition = "requeued" | "exhausted" | "retryable" | "failed_loud";

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
  /** After a round's verdict lands: compact the sticky conversation. Cache
   * re-reads were 41% of measured cost (2026-08-14 mining) and sessions never
   * compacted on their own. Optional — stubs may omit it. */
  compactSession?(pr: number): Promise<void>;
  /** Is the PR's session alive (tmux session present)? The stuck-round
   * detector reads this — the EXISTING liveness signal, not a new one.
   * Optional: absent (stubs, tests) ⇒ liveness is unknown and the deadline
   * checker degrades to the legacy anomaly park. */
  sessionAlive?(pr: number): Promise<boolean>;
  /** Kill the PR's tmux session so the next dispatch rebirths it fresh. Read
   * by the live-but-stuck self-requeue (2026-08-19): an overdue round whose
   * session is alive but wedged is killed + requeued instead of parked.
   * Optional: absent ⇒ live-but-stuck rounds park exactly as before. */
  killSession?(pr: number): Promise<void>;
  /** Milliseconds-epoch mtime of the newest pi session JSONL for this PR, or
   * null when unknown. Read by the lost-prompt net: a round whose
   * inject was consumed while the session shows no activity since the round
   * started never received its prompt. Optional: absent ⇒ no net, exactly the
   * legacy behaviour. */
  sessionActivityAt?(pr: number): Promise<number | null>;
  /** Is any wake file still pending (unconsumed) in the PR session's inject
   * dir? Read by the same net — a pending file means the bridge is still
   * retrying delivery, which is patience, not loss. Optional as above. */
  injectPending?(pr: number): Promise<boolean>;
  /**
   * Did this round's prompt actually reach the session? (#5362.)
   *
   * The ONE positive delivery fact in the system. `dispatchRound` stamps a
   * receipt token into the wake file; pi writes the user message it accepted
   * — token and all — into the session JSONL. Present ⇒ delivered. Absent ⇒
   * never delivered, which is a fact the older mtime inference could not
   * express: a prompt is dropped BECAUSE the agent is busy, and a busy agent
   * always bumps the mtime after the round started.
   *
   * `null` means "cannot tell" and must never be read as loss.
   * Optional: absent ⇒ no receipt check, exactly the pre-#5362 behaviour.
   */
  roundPromptAccepted?(pr: number, roundNo: number, startedAtMs: number): Promise<boolean | null>;
  /**
   * The general form of the same receipt read (#5362 W2): did a wake carrying
   * `marker` reach the session? Used by the undelivered-recheck sweep, which
   * has no round row to hang `roundPromptAccepted` off — and needs it more,
   * because a recheck claim has no deadline underneath it.
   * `null` = cannot tell. Optional: absent ⇒ no sweep.
   */
  wakeReceiptPresent?(pr: number, marker: string, sinceMs: number): Promise<boolean | null>;
  /**
   * Re-deliver a round prompt whose receipt never appeared (#5362) — the same
   * round, session and conversation, with the exact dispatched bytes written
   * to the inject dir again. The CHEAP recovery, deliberately distinct from
   * `selfRequeue`: no round is cancelled, no session is killed, no GitHub
   * state is touched, and the self-requeue budget is not spent.
   *
   * False when the dispatched prompt is no longer on disk — the caller then
   * falls through to the expensive recovery rather than inventing an order.
   * Optional: absent ⇒ the expensive path only, exactly as before.
   */
  redeliverRound?(pr: number, roundNo: number): Promise<boolean>;
  /**: safely retry one durable command after its start lease expires.
   * The production manager kills and verifies the old sticky session first,
   * then reuses the same id/path/bytes and rebirths the session. False means
   * no replay occurred; callers must fail loud rather than submit a second. */
  retrySessionCommand?(commandId: string, reason: string): Promise<SessionCommandRetryResult>;
}
