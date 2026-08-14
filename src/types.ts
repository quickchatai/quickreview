// Shared cross-slice contracts. B2's dispatch emits RoundOrder; B3's session
// manager consumes it; verdict files close the loop (spec §3–4).

export type RoundType = "first" | "re-review" | "staleness";

/** Pass model tiers, ascending by capability/cost. */
export type PassTier = "terra-med" | "sol-med" | "sol-high";

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
  round_type: RoundType;
  /** Compat: the pass_plan lenses, in order (pass_plan is authoritative). */
  lenses: string[];
  /** The planned passes for this round, tiered. */
  pass_plan: PassPlanEntry[];
  /** Lenses NOT selected for this round that the session may add. */
  addable_lenses: string[];
  escalation_worthy: boolean;
  escalation_reasons: string[];
  migration_gate: boolean;
  head_sha: string;
  worktree: string;
  /** SETTLED digest carried from the last verdict's ledger snapshot. */
  settled_digest: string;
  issued_at: string;
}

/** verdict/pr-<n>-round-<k>.json — written by the PR session at round end. */
export interface VerdictFile {
  pr: number;
  round_no: number;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "ESCALATE";
  /** AI_APPROVED soundness marker on ESCALATE (spec §5). */
  ai_approved?: boolean;
  head_sha: string;
  spend_usd?: number;
  ledger_snapshot?: string;
  /** 3-4 sentence plain-prose "what is going on" written by the session for
   * the owner's TUI detail pane. Optional; capped by the consumer. */
  summary?: string;
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
