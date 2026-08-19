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
  /** Candidate findings the pass returned. */
  findings?: number | null;
  /** Validator outcome counts (meaningful on pass-validate): candidates that
   * survived its veto, were killed, or were downgraded. */
  survived?: number | null;
  killed?: number | null;
  downgraded?: number | null;
}

/** verdict/pr-<n>-round-<k>.json — written by the PR session at round end. */
export interface VerdictFile {
  pr: number;
  round_no: number;
  verdict: Verdict;
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
}
