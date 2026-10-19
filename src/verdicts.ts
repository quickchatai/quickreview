import {
  enqueueRoundWork,
  pendingRoundWork,
  finishRoundWork,
  type RoundWork,
} from "./round-work.js";
// Verdict watcher. The PR session writes
// verdict/pr-<n>-round-<k>.json at round end; the daemon owns everything that
// touches GitHub from there: labels off/on, the escalation review request
// (redundancy-skipped inside the adapter), the round record, the state
// transition.
//
// Two anomaly paths, both explicitly no-approve: a malformed/unparseable
// verdict file, and a round that blows its deadline. Both mark the round and
// inject the overseer. There is no path here that touches an existing review:
// the invariant against retracting an approval is structural, not prompted
// (CLAUDE.md rule 2).
import {
  normalizePassPhase,
  normalizeSweepClaim,
  sweepSkippedOnApprove,
  sweepStatusOf,
  type SweepStatus,
} from "./sweepstatus.js";
import { pendingPosting } from "./posting-outbox.js";

export { sweepStatusOf, type SweepStatus };
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import { checkOutcome, classifyCi, latestRunPerName, type CheckSummary } from "./cigate.js";
import {
  deliverEscalations,
  resumeEscalations,
  type EscalationDeps,
  evaluateEscalationRules,
  normalizeSessionEscalations,
  type EscalationFacts,
} from "./escalation.js";
import {
  DEFAULT_MAX_PROMPT_REDELIVERIES,
  DEFAULT_MAX_SELF_REQUEUES,
  DEFAULT_POSTING_RECEIPT_GRACE_S,
  DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN,
  DEFAULT_ROUND_STALL_GRACE_MIN,
  githubCloneDir,
  sandboxRoot,
  type Config,
} from "./config.js";
import {
  fingerprintRoundIntegrity,
  gitConfigChangeMessage,
  INTEGRITY_BUDGET_MS,
  roundIntegrityOpts,
  integrityChanges,
  policySurfaceChangeMessage,
  splitIntegrityChanges,
  type IntegrityFingerprint,
  type RoundIntegrityOpts,
} from "./execboundary.js";
import { estimateUsd, type ModelPricing } from "./usage.js";
import { TranscriptIndex } from "./transcriptindex.js";
import { withinBudget } from "./budget.js";
import { piGlobalSessionsDir } from "./archive/piglobal.js";
import type { GateResult } from "./gate.js";
import { applyEvent, restoreStandingLifecycle } from "./statemachine.js";
import type { VerdictAnnouncer } from "./slack/announce.js";
import { isLoudCancelCause, type CancelCause, type RoundRow, type StateStore } from "./state.js";
import { enforceLedgerFreshness } from "./ledgercheck.js";
import {
  enforceFindingsRecord,
  findingsRecordPath,
  ingestRepairedFindingsRecords,
  resumeFindingsRecordedHooks,
  readFindingsRecord,
} from "./findingsrecord.js";
import {
  normalizeVerdict,
  type RecordedAddablePass,
  type RoundRecoveryDisposition,
  type SessionHooks,
  type MeritsVerdictFile,
  type VerdictFile,
  type VerdictPassEntry,
} from "./types.js";
import {
  guardedNoopMatchesMark,
  postingMarker,
  readPostingReceipt,
  receiptMatchesVerdict,
  retrySoftenedApproval,
  type GuardedNoopReceipt,
  type PostingReceipt,
} from "./posting-receipt.js";
import {
  snapshotMark,
  standingReview,
  standingVerdict,
  type StandingDecidedVerdict,
} from "./standing-review.js";
import { flushHeldWakes, pauseDefersAllHeldWakes } from "./wakes.js";
import { prWorktreeRel } from "./worktrees.js";
import {
  describeGap,
  failedPasses,
  parsePlan,
  readRoundProgress,
  requiredPassGap,
} from "./requiredpasses.js";
import {
  readSettledJson,
  resolvePartialWritePolicy,
  type PartialWritePolicy,
} from "./settledread.js";

/** Self-requeue mode → the cancellation cause it records. Two modes mean the
 * same thing to a human — the round stopped dead with no verdict, whether its
 * session had died or was alive and wedged — and that is the one loud cause;
 * the rest are the machinery working (a moved head, a delivery fault, a round
 * redone because it executed no passes). */
type SelfRequeueMode =
  | "dead"
  | "alive_stuck"
  | "needs_human_incomplete"
  | "lost_prompt"
  | "head_moved"
  | "required_pass_missing"
  | "infrastructure_active"
  | "infrastructure_settled";

/**
 * How long a round end waits for its transcripts. The reads are
 * async and chunked, so the event loop is free throughout; this bound is for a
 * read that never returns at all. Past it the usage is recorded unknown, the
 * audit incomplete, and the round end goes on — a verdict is never held
 * behind its own accounting.
 */
export const USAGE_BUDGET_MS = 120_000;

/** How many unreadable paths the `round_usage_unknown` event names. */
const UNREADABLE_LISTED = 10;

/**
 * How old an owed measurement's window may be and still be re-read after a
 * restart. Past it the window is not read at all and the usage is recorded
 * unknown: the pi-global archiver moves store
 * files a day old, and a re-read that silently missed one would record a
 * partial sum as the round's cost. A restart is minutes; this is generous.
 */
export const OWED_MEASUREMENT_RESUME_MAX_MS = 12 * 3_600_000;

/**
 * A staged verdict or recheck outcome (`verdict/<name>.tmp`)
 * that was never committed is removed once it is this old. A session stages
 * and commits within one turn of a round that lasts at most its deadline, so
 * a day-old staging file belongs to a session that died between the two.
 */
export const STAGED_FILE_MAX_AGE_MS = 24 * 3_600_000;

/** The staging names `scripts/commit-verdict.sh` publishes from: the two
 * watched names (VERDICT_FILE_RE here, RECHECK_FILE_RE in recheck.ts) plus
 * `.tmp`, and nothing else. */
const STAGED_FILE_RE = /^pr-(\d+)-(?:round-\d+|recheck-[0-9a-f]{7,40})\.json\.tmp$/i;

/**
 * Where a round end's measurement runs.
 * `inline`: awaited before the round end returns — the verdict sweep's
 * paths, and the anomaly path, whose overseer inject carries the violations
 * the measurement finds. `background`: handed off once the
 * round end's durable rows have landed — the round-stage supervisor's paths
 * (its scan is serialized and health-leased, so one PR's accounting must not
 * hold every other PR's stage checks) and the deadline tick's settlements.
 * Either way the obligation is durable (`rounds.usage_owed_to`) from the
 * moment the window is fixed, so a restart resumes it rather than losing it.
 */
type MeasureMode = "inline" | "background";

/** A round end's measurement, owed from the moment its window was fixed. */
interface OwedMeasurement {
  pr: number;
  roundId: number;
  roundNo: number;
  startedAt: string;
  measuredTo: string;
}

/** A receipt settlement's measurement mode: inline from the verdict sweep (a
 * verdict file, or a malformed one), background from the deadline tick and the
 * round-stage supervisor. */
function measureModeFor(via: ReceiptSettleVia): MeasureMode {
  return via === "verdict" || via === "malformed_verdict" ? "inline" : "background";
}

/** A round-stage limit's answer for a posting failure the stage tried to
 * open: a verdict that owns the round is the sweep's (retry the limit later),
 * a round that ended is settled, a failure opened is loud. */
function stageFailure(outcome: "verdict" | "ended" | "failed"): RoundRecoveryDisposition {
  return outcome === "verdict" ? "retryable" : outcome === "ended" ? "settled" : "failed_loud";
}

/** A self-requeue's measurement mode: the two that come from a verdict file
 * are the sweep's; the rest come from the deadline tick or the supervisor. */
function measureModeForRequeue(mode: SelfRequeueMode): MeasureMode {
  return mode === "head_moved" ||
    mode === "needs_human_incomplete" ||
    mode === "required_pass_missing"
    ? "inline"
    : "background";
}

const SELF_REQUEUE_CAUSE: Record<SelfRequeueMode, CancelCause> = {
  dead: "deadline_overrun",
  alive_stuck: "deadline_overrun",
  needs_human_incomplete: "incomplete_round",
  lost_prompt: "lost_prompt",
  head_moved: "head_moved",
  required_pass_missing: "incomplete_round",
  infrastructure_active: "infrastructure_failure",
  infrastructure_settled: "infrastructure_failure",
};

export interface VerdictAdapter {
  addLabel(n: number, label: string): Promise<GateResult>;
  removeLabel(n: number, label: string): Promise<GateResult>;
  /** PR metadata — the escalation feature's label facts. Optional
   * in the same shape as everything else here: an adapter that cannot answer
   * simply means label-keyed escalation rules do not fire. */
  getPr?(n: number): Promise<{ labels: string[] }>;
  /** Changed files — the escalation feature's path facts. Same discipline. */
  listPrFiles?(n: number): Promise<Array<{ filename: string }>>;
  /** The two gated escalation writes. Both optional: a daemon whose
   * adapter has neither delivers no escalations at all, which is exactly what
   * the default (feature off) already does. */
  createReview?(
    n: number,
    payload: { commit_id: string; event: "COMMENT"; body: string },
    options?: { purpose?: "escalation" | "migration_precheck" },
  ): Promise<GateResult>;
  requestEscalationReview?(n: number, logins: string[]): Promise<GateResult>;
  /** Checks at a head (read-only, cigate's classifier input). Optional: with
   * it, a session-route withheld approval records WHICH CI state caused the
   * withhold; without it the mark stores null. */
  listChecks?(ref: string): Promise<CheckSummary[]>;
  /** Read-only reconciliation for an ambiguous post-success/local-crash
   * window. Exact marker + bot identity + head are required. */
  listReviewsFull?(pr: number): Promise<
    Array<{
      id: number;
      user: string;
      user_type?: string;
      state: string;
      body: string;
      commit_id: string;
      submitted_at: string | null;
    }>
  >;
}

export interface VerdictDeps {
  cfg: Config;
  store: StateStore;
  adapter: VerdictAdapter;
  hooks: SessionHooks;
  /** Directory the sessions write into (sandbox `verdict/`). */
  verdictDir: string;
  /** Settle time between requesting the round-end compaction and the
   * ledger check, so ledger-pin's mirror has landed first. (The inject bridge
   * holds every wake until the compaction ends.) 0 ⇒ inline (tests).
   * Default 90s. */
  ledgerCheckDelayMs?: number;
  /** Slack announcer. Optional: absent ⇒ no Slack. Never allowed to throw in
   * here. */
  announce?: VerdictAnnouncer;
  /** Sandbox root — anchors the default pi-session dir. */
  root?: string;
  /** Atomic shell posting receipts. Defaults to state/posting-receipts. */
  postingReceiptDir?: string;
  postingReceiptGraceS?: number;
  /** Usage-measurement seams; every field defaults from cfg/root. */
  usage?: {
    /** pi session dir for a PR's sticky session (sessions.ts sessionDir()). */
    sessionDirFor?: (pr: number) => string;
    /** pi HOME global store (pass subagents); null disables the best-effort scan. */
    globalStoreDir?: string | null;
    /** Per-model pricing; defaults to config `[models.pricing]`. */
    pricing?: Record<string, ModelPricing>;
    /** The transcript reader. Default: one per watcher, so its
     * per-file offsets and parsed lines live as long as the daemon. */
    transcripts?: TranscriptIndex;
    /** How long a round end waits for its transcripts before it records the
     * usage as unknown and moves on. Default USAGE_BUDGET_MS. */
    budgetMs?: number;
  };
  /** The round-end integrity re-hash. Default
   * `fingerprintRoundIntegrity` over the real disk — the same call dispatch's
   * baseline makes. Injected by a test that needs a read that never returns. */
  integrityFingerprint?: (opts: RoundIntegrityOpts) => Promise<IntegrityFingerprint>;
  /** How long the re-hash may take before the round is left unchecked.
   * Default INTEGRITY_BUDGET_MS. */
  integrityBudgetMs?: number;
  /** Where a PR's mirrored ledger snapshot lives. Defaults to
   * `<root>/state/ledgers/pr-<n>.md` — sessions.ts ledgerPath's shape. */
  ledgerPathFor?: (pr: number) => string;
  /**
   * Where the session writes its per-round reasoning record —
   * daemon.ts passes `<root>/state/findings`.
   *
   * Opt-in rather than defaulted off `root`, in the same shape as every other
   * additive round-end check here: absent ⇒ the record is neither parsed nor
   * enforced (a stub-wired daemon and tests that do not need it). Production
   * has one assembly site (daemon.ts) and it passes the dir.
   */
  findingsDir?: string;
  /** Told when a round's findings record lands (the lesson shadow ledger's
   * matcher). Absent ⇒ nothing is told. Must not throw. */
  onFindingsRecorded?: (target: {
    pr: number;
    roundNo: number;
    roundId: number | null;
  }) => unknown;
  now?: () => Date;
  log?: (msg: string, extra?: unknown) => void;
  /** Partial-write tolerance (`src/settledread.ts`): how long an
   * unparseable verdict file is treated as still being written before it is
   * called malformed. Defaults to DEFAULT_PARTIAL_WRITE_POLICY; a test that
   * wants one read to decide passes `{ windowMs: 0 }`. */
  partialWrite?: Partial<PartialWritePolicy>;
}

/** The round-stage limits the supervisor may report, named once. */
export type InfrastructureStage =
  | "command_start"
  | "first_pass_start"
  | "passes_incomplete"
  | "parent_finalize"
  | "settled_without_verdict"
  | "running_hard_bound";

/** Every path that may close a round from its posting receipt rather than
 * from a verdict file (a guard-2 no-op, or a review already posted). */
type ReceiptSettleVia = "verdict" | "deadline" | "malformed_verdict" | InfrastructureStage;

/** The merits decision a posting receipt proves. */
export interface ReceiptDecision {
  verdict: "APPROVE" | "REQUEST_CHANGES";
  /** The session asked for a COMMENT: the round templates' withheld-approval
   * shape (red or pending CI, no blockers). */
  approval_withheld?: true;
}

/**
 * The merits decision a confirmed posting receipt proves, or null
 * when it proves only that something was posted.
 *
 * The receipt records what the session asked the posting script for
 * (`intended_event`) beside what the guards let through (`actual_event`), and
 * the scripts' shapes are fixed: `approve-pr.sh` only ever records
 * APPROVE→APPROVE, and `post-review.sh` takes REQUEST_CHANGES or COMMENT, with
 * guard 1 softening REQUEST_CHANGES to COMMENT when a non-author human has
 * already approved. So:
 *
 *   - REQUEST_CHANGES asked for is a REQUEST_CHANGES decision whatever was
 *     posted — exactly what `receiptMatchesVerdict` accepts from a verdict file;
 *   - APPROVE posted is an APPROVE;
 *   - a COMMENT the session asked for is, by the round templates' own contract,
 *     the withheld-approval shape and nothing else: "red CI and no blockers ⇒
 *     post the full review as a COMMENT … write `"verdict": "APPROVE"` with
 *     `"approval_withheld": true`" (step 5's CI gate). Mechanical
 *     comments (the migration pre-check, an escalation) go through the daemon's
 *     gate and never write a session receipt, and a softened REQUEST_CHANGES
 *     says so in `intended_event`. Settling it as APPROVE + withheld records
 *     the withheld-approval mark, so CI turning green re-queues the PR and the
 *     SESSION decides again (cigate.ts) — the reading can never approve
 *     anything by itself.
 *
 * Not decided — null — is everything else: a receipt the marker reconcile
 * synthesised from GitHub (`reconciled`: its `intended_event` is only the
 * posted event, so a COMMENT there may be a softened REQUEST_CHANGES), and any
 * pairing no posting script writes. Those keep the loud paths.
 *
 * This is the receipt's reading. The reviewed-head mark's `posted_event`
 * COMMENT carries no `intended_event` and stays never-guessed
 * (standing-review.ts rule 4).
 */
export function decidedVerdictFromReceipt(receipt: PostingReceipt): ReceiptDecision | null {
  // The daemon's deferred-posting retry delivered the session's
  // APPROVE and guard 4 softened it on the gate — the withheld-approval shape.
  if (retrySoftenedApproval(receipt)) return { verdict: "APPROVE", approval_withheld: true };
  if (
    receipt.intended_event === "REQUEST_CHANGES" &&
    (receipt.actual_event === "REQUEST_CHANGES" || receipt.actual_event === "COMMENT")
  )
    return { verdict: "REQUEST_CHANGES" };
  if (receipt.intended_event === "APPROVE" && receipt.actual_event === "APPROVE")
    return { verdict: "APPROVE" };
  if (
    receipt.intended_event === "COMMENT" &&
    receipt.actual_event === "COMMENT" &&
    receipt.reconciled !== true
  )
    return { verdict: "APPROVE", approval_withheld: true };
  return null;
}

/** The planned lens set the round-end findings check stamps against:
 * the round's plan, plus the sweep's lenses when the sweep RAN —
 * their findings are planned work, never `unplanned`. */
export function tailPlannedLenses(
  round: Pick<RoundRow, "lenses" | "sweep_plan">,
  sweepStatus: SweepStatus | null,
): string {
  const base = round.lenses ?? "";
  if (sweepStatus !== "ran" || !round.sweep_plan) return base;
  try {
    const plan = JSON.parse(round.sweep_plan) as unknown;
    if (!Array.isArray(plan)) return base;
    const lenses = new Set(base.split(",").filter(Boolean));
    for (const row of plan) {
      const lens = (row as { lens?: unknown } | null)?.lens;
      if (typeof lens === "string" && lens) lenses.add(lens);
    }
    return [...lenses].join(",");
  } catch {
    return base;
  }
}

/** One stage's executed passes held against its plan — the round's main
 * plan, or a follow-up round's pre-approval sweep. Pure. */
interface PlanComparison {
  planned: string[];
  missing: string[];
  unknownAdditions: string[];
  missingReason: string[];
  wrongTier: string[];
  allowedAdditions: Array<{ name: string; tier: string | null; reason: string }>;
}

type PlanRow = { lens: string; tier: string; raisable_to?: string[] };

function allowsTier(policy: PlanRow, tier: string | null | undefined): boolean {
  return (
    !!tier &&
    [policy.tier, ...(policy.raisable_to ?? []).map((agent) => agent.split("--").at(-1)!)].includes(
      tier,
    )
  );
}

/** Match executions to distinct rows before judging any excess retries. */
function plannedTierMismatches(passes: VerdictPassEntry[], rows: PlanRow[]): string[] {
  const byLens = new Map<string, PlanRow[]>();
  for (const row of rows) byLens.set(row.lens, [...(byLens.get(row.lens) ?? []), row]);
  const wrong: string[] = [];
  for (const [lens, policies] of byLens) {
    const runs = passes.filter((pass) => pass.name === lens);
    const assigned = new Map<number, number>();
    const place = (run: number, seen: Set<number>): boolean => {
      for (let row = 0; row < policies.length; row++) {
        if (seen.has(row) || !allowsTier(policies[row]!, runs[run]!.tier)) continue;
        seen.add(row);
        const previous = assigned.get(row);
        if (previous === undefined || place(previous, seen)) {
          assigned.set(row, run);
          return true;
        }
      }
      return false;
    };
    const excess = runs.filter((_pass, run) => !place(run, new Set()));
    for (const pass of excess)
      if (
        assigned.size < policies.length ||
        !policies.some((policy) => allowsTier(policy, pass.tier))
      )
        wrong.push(lens);
  }
  return wrong;
}

function comparePlan(
  passes: VerdictPassEntry[],
  plan: PlanRow[] | null,
  addable: RecordedAddablePass[] | null,
  legacyPlanned: string[],
  checkMissing: boolean,
): PlanComparison {
  const executed = passes.map((p) => p.name);
  const out: PlanComparison = {
    planned: legacyPlanned,
    missing: [],
    unknownAdditions: [],
    missingReason: [],
    wrongTier: [],
    allowedAdditions: [],
  };
  if (plan && addable) {
    out.planned = plan.map((p) => p.lens);
    const byAddable = new Map<string, RecordedAddablePass[]>();
    for (const policy of addable)
      byAddable.set(policy.lens, [...(byAddable.get(policy.lens) ?? []), policy]);
    out.wrongTier = plannedTierMismatches(passes, plan);
    const plannedNames = new Set(plan.map((p) => p.lens));
    for (const pass of passes) {
      if (plannedNames.has(pass.name)) continue;
      const policies = byAddable.get(pass.name);
      if (!policies) {
        out.unknownAdditions.push(pass.name);
        continue;
      }
      const optional = policies.filter((policy) => policy.optional);
      if (optional.length > 0) {
        if (optional.some((policy) => allowsTier(policy, pass.tier)))
          out.allowedAdditions.push({
            name: pass.name,
            tier: pass.tier!,
            reason: pass.reason ?? "optional row",
          });
        else out.wrongTier.push(pass.name);
        continue;
      }
      const policy = policies[0]!;
      if (!pass.tier || pass.tier !== policy.tier) out.wrongTier.push(pass.name);
      if (!pass.reason) out.missingReason.push(pass.name);
      if (pass.tier === policy.tier && pass.reason) {
        out.allowedAdditions.push({ name: pass.name, tier: pass.tier, reason: pass.reason });
      }
    }
  } else {
    // Rows with no structured plan (in flight across a migration) compare
    // by lens name only.
    out.unknownAdditions = [...new Set(executed.filter((lens) => !out.planned.includes(lens)))];
  }
  if (checkMissing) {
    const remaining = new Map<string, number>();
    for (const lens of executed) remaining.set(lens, (remaining.get(lens) ?? 0) + 1);
    out.missing = out.planned.filter((lens) => {
      const count = remaining.get(lens) ?? 0;
      if (count === 0) return true;
      remaining.set(lens, count - 1);
      return false;
    });
  }
  return out;
}

export const VERDICT_FILE_RE = /^pr-(\d+)-round-(\d+)\.json$/;

/** A round's verdict file name — the one spelling VERDICT_FILE_RE reads,
 * the watcher's slot key and every presence check use. */
export function verdictFileName(pr: number, roundNo: number): string {
  return `pr-${pr}-round-${roundNo}.json`;
}

export interface ParsedVerdict {
  ok: boolean;
  verdict?: VerdictFile;
  error?: string;
  /** Why the `passes` telemetry ended up unknown/reduced — a note for the
   * log, never a rejection reason. Absent when passes were clean. */
  passes_note?: string;
}

/**
 * Tolerant normalization of the executed-pass telemetry. LLM-written
 * files: digit-string counts coerce, `lens` is accepted for `name`,
 * `candidates`/`candidate_findings` for `findings`. Anything unusable —
 * a non-array, an entry with no name — degrades to unknown (undefined) or is
 * dropped with a note; nothing here can fail the verdict.
 */
export function normalizePasses(raw: unknown): { passes?: VerdictPassEntry[]; note?: string } {
  if (raw === undefined || raw === null) return { note: "absent" };
  if (!Array.isArray(raw)) return { note: `not an array (${typeof raw})` };
  const count = (val: unknown): number | null => {
    if (typeof val === "number" && Number.isFinite(val)) return Math.trunc(val);
    if (typeof val === "string" && /^\d+$/.test(val)) return Number(val);
    return null;
  };
  const passes: VerdictPassEntry[] = [];
  let dropped = 0;
  let badPhase = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      dropped++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name =
      typeof e.name === "string" && e.name.trim()
        ? e.name.trim()
        : typeof e.lens === "string" && e.lens.trim()
          ? e.lens.trim()
          : null;
    if (!name) {
      dropped++;
      continue;
    }
    passes.push({
      name,
      tier: typeof e.tier === "string" && e.tier.trim() ? e.tier.trim() : null,
      ...(typeof e.reason === "string" && e.reason.trim() ? { reason: e.reason.trim() } : {}),
      findings: count(e.findings) ?? count(e.candidates) ?? count(e.candidate_findings),
      survived: count(e.survived),
      killed: count(e.killed),
      downgraded: count(e.downgraded),
      merged: count(e.merged),
      folded: count(e.folded),
    });
    // Which stage of a follow-up round launched the pass. Additive
    // and tolerant — absent stays absent (a delta-stage pass, or a round that
    // is not a follow-up), an unusable spelling is dropped with a note; the
    // entry itself always survives.
    if (e.phase !== undefined && e.phase !== null) {
      const phase = normalizePassPhase(e.phase);
      if (phase) passes[passes.length - 1]!.phase = phase;
      else badPhase++;
    }
  }
  const notes = [
    dropped > 0 ? `${dropped} malformed entr${dropped === 1 ? "y" : "ies"} dropped` : "",
    badPhase > 0 ? `${badPhase} unusable phase${badPhase === 1 ? "" : "s"} ignored` : "",
  ].filter(Boolean);
  return { passes, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
}

/** The verdict's `extent`: what the session did with the follow-up
 * plan's optional rows — `ran` | `partial` | `skipped`, case forgiven;
 * anything else is unusable (null). */
export function normalizeExtentClaim(raw: unknown): "ran" | "partial" | "skipped" | null {
  if (typeof raw !== "string") return null;
  const word = raw.trim().toLowerCase();
  return word === "ran" || word === "partial" || word === "skipped" ? word : null;
}

/** Shape validation for VerdictFile. Anything off → the anomaly path. */
export function validateVerdict(raw: unknown): ParsedVerdict {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "not an object" };
  const v = raw as Record<string, unknown>;
  const bad = (m: string): ParsedVerdict => ({ ok: false, error: m });
  // LLM-written files: coerce unambiguous digit-strings ("5263" → 5263) before
  // shape-checking.
  for (const k of ["pr", "round_no"] as const) {
    const val = v[k];
    if (typeof val === "string" && /^\d+$/.test(val)) v[k] = Number(val);
  }
  if (typeof v.pr !== "number" || !Number.isInteger(v.pr)) return bad("pr must be an integer");
  if (typeof v.round_no !== "number" || !Number.isInteger(v.round_no))
    return bad("round_no must be an integer");
  // Guard-5 landing: `outcome: "head_moved"` (or, belt-and-braces, verdict
  // spelled HEAD_MOVED) is a verdict-less round
  // ending — the PR advanced mid-round and the guard refused the stale post.
  // Only pr/round_no/head_sha/finished_at are required; the daemon cancels
  // the round and self-requeues instead of applying a verdict.
  const outcome = typeof v.outcome === "string" ? v.outcome.trim().toLowerCase() : "";
  const verdictSpelled = typeof v.verdict === "string" ? v.verdict.trim().toUpperCase() : "";
  // The envelope every outcome carries: the head the round reviewed and when
  // it finished. spend_usd is a legacy self-reported field — accepted in any
  // shape and IGNORED (models copy the template's example figure; real usage
  // is measured from the session JSONLs) — deleted so no consumer can store
  // it.
  const badEnvelope = (): ParsedVerdict | null => {
    if (typeof v.head_sha !== "string" || v.head_sha.length === 0)
      return bad("head_sha must be a non-empty string");
    if (typeof v.finished_at !== "string" || v.finished_at.length === 0)
      return bad("finished_at must be a non-empty string");
    delete v.spend_usd;
    return null;
  };
  if (outcome === "head_moved" || verdictSpelled === "HEAD_MOVED") {
    v.outcome = "head_moved";
    delete v.verdict;
    return badEnvelope() ?? { ok: true, verdict: raw as unknown as VerdictFile };
  }
  if (outcome) return bad(`bad outcome: ${String(v.outcome)}`);
  // normalizeVerdict also folds the retired "ESCALATE" spelling into
  // NEEDS_HUMAN — the frozen conversation-system.md seed still emits it.
  const verdict = normalizeVerdict(v.verdict);
  if (verdict === null) return bad(`bad verdict: ${String(v.verdict)}`);
  v.verdict = verdict;
  const envelope = badEnvelope();
  if (envelope) return envelope;
  if (v.ai_approved !== undefined && typeof v.ai_approved !== "boolean")
    return bad("ai_approved must be a boolean");
  // LLM-written booleans arrive as strings often enough to coerce the
  // two unambiguous spellings rather than fail the whole file over them.
  if (v.approval_withheld === "true") v.approval_withheld = true;
  if (v.approval_withheld === "false") v.approval_withheld = false;
  if (v.approval_withheld !== undefined && typeof v.approval_withheld !== "boolean")
    return bad("approval_withheld must be a boolean");
  if (v.ledger_snapshot !== undefined && typeof v.ledger_snapshot !== "string")
    return bad("ledger_snapshot must be a string");
  if (v.summary !== undefined && typeof v.summary !== "string")
    return bad("summary must be a string");
  if (typeof v.summary === "string") v.summary = v.summary.trim().slice(0, 800);
  // Executed-pass telemetry: tolerant by design — a session may omit it and
  // malformed shapes degrade to unknown, never to a rejected verdict.
  const norm = normalizePasses(v.passes);
  if (norm.passes) v.passes = norm.passes;
  else delete v.passes;
  // Session-judgement escalations: the same tolerant discipline, for
  // the same reason and one stronger one — escalation is notification beside a
  // verdict, so a malformed `escalations` array must never be able to reject
  // the verdict it rides on. Unreadable ⇒ dropped with a note.
  const esc = normalizeSessionEscalations(v.escalations);
  if (esc.entries.length > 0) v.escalations = esc.entries;
  else delete v.escalations;
  // A follow-up round's pre-approval sweep claim — the same tolerant
  // discipline: an unusable claim is dropped with a note (the daemon then
  // records the sweep unknown), never a rejected verdict.
  let sweepNote: string | undefined;
  if (v.sweep !== undefined) {
    const claim = normalizeSweepClaim(v.sweep);
    if (claim) v.sweep = claim;
    else {
      sweepNote = `sweep claim unusable (${JSON.stringify(v.sweep).slice(0, 40)}) ignored`;
      delete v.sweep;
    }
  }
  // The optional rows' extent — the same tolerant discipline.
  let extentNote: string | undefined;
  if (v.extent !== undefined) {
    const extent = normalizeExtentClaim(v.extent);
    if (extent) v.extent = extent;
    else {
      extentNote = `extent claim unusable (${JSON.stringify(v.extent).slice(0, 40)}) ignored`;
      delete v.extent;
    }
  }
  for (const k of ["sweep_reason", "extent_reason"] as const)
    if (v[k] !== undefined && typeof v[k] !== "string") delete v[k];
  const notes = [norm.note, esc.note, sweepNote, extentNote].filter(Boolean).join("; ");
  return {
    ok: true,
    verdict: raw as unknown as VerdictFile,
    ...(notes ? { passes_note: notes } : {}),
  };
}

export class VerdictWatcher {
  private watcher: FSWatcher | null = null;
  private readonly inFlight = new Set<string>();
  private readonly processedDir: string;
  /** Exec-policy violations found while measuring usage, kept only so an
   * overseer inject that happens anyway can carry a line about them —
   * violations alone never create inject spam. */
  private readonly execViolations = new Map<number, string[]>();
  /** Waits logged once per round per process, not once per supervisor scan
   * or deadline tick: the posted-tail wait at a stage limit (`stage:<id>`)
   * and at the deadline (`deadline:<id>`), and an ambiguous POST a stage limit
   * is waiting out (`ambiguous:<id>`). */
  private readonly loggedOnce = new Set<string>();
  /** Rounds whose owed measurement this process is running or about to run —
   * the boot resume never measures one of them a second time. */
  private readonly measuring = new Set<number>();
  private readonly working = new Set<string>();
  /** Background round work, tracked until it ends. */
  private readonly background = new Set<Promise<void>>();
  /** The once-per-watcher resume of measurements an earlier process owed. */
  private owedResumed = false;
  /** `checkDeadlines` never overlaps itself. */
  private deadlinesInFlight = false;
  /** Round transcripts, read off the event loop and kept by offset. */
  private readonly transcripts: TranscriptIndex;
  private stopped = false;
  private escalationRecoveryInFlight = false;

  constructor(private readonly deps: VerdictDeps) {
    this.processedDir = join(deps.verdictDir, "processed");
    this.transcripts = deps.usage?.transcripts ?? new TranscriptIndex();
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private log(msg: string, extra?: unknown): void {
    (this.deps.log ?? (() => {}))(msg, extra);
  }

  /** Startup sweep + fs.watch. fs.watch is the fast path only; the sweep (also
   * run by the daemon's periodic tick) is the reliable one. */
  start(): void {
    this.stopped = false;
    mkdirSync(this.deps.verdictDir, { recursive: true });
    void this.sweep();
    this.watcher = watch(this.deps.verdictDir, (_event, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (!VERDICT_FILE_RE.test(name)) return;
      void this.handleFile(name).catch((err) => this.log(`verdicts: ${name} failed`, err));
    });
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
  }

  /** Resolves once this watcher's background work ends. The daemon does not
   * wait here during shutdown: durable obligations resume at the next start.
   * Tests use it before observing background round results. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Process every verdict file sitting in the directory.
   *
   * One PR's files in name order; different PRs side by side. A file still
   * being written is waited out for seconds, so a sweep that walked every file
   * in one line would hold every other PR's verdict behind it — the fs.watch
   * path handles PRs concurrently too. */
  async sweep(): Promise<string[]> {
    this.resumeRoundWork();
    this.detach(
      () =>
        resumeFindingsRecordedHooks({
          store: this.deps.store,
          ...(this.deps.onFindingsRecorded ? { onRecorded: this.deps.onFindingsRecorded } : {}),
          log: this.log.bind(this),
        }),
      "recorded findings hooks",
    );
    this.resumeEscalationDeliveries();
    if (!existsSync(this.deps.verdictDir)) return [];
    const byPr = new Map<string, string[]>();
    const listed = readdirSync(this.deps.verdictDir).sort();
    for (const name of listed) {
      const match = VERDICT_FILE_RE.exec(name);
      if (!match) continue;
      byPr.set(match[1]!, [...(byPr.get(match[1]!) ?? []), name]);
    }
    this.pruneStaleStaging(listed);
    const done: string[] = [];
    await Promise.all(
      [...byPr.values()].map(async (names) => {
        for (const name of names) {
          try {
            if (await this.handleFile(name)) done.push(name);
          } catch (err) {
            this.log(`verdicts: ${name} failed`, err);
          }
        }
      }),
    );
    try {
      await this.resumeInterruptedSettlements();
    } catch (err) {
      this.log("verdicts: resuming interrupted receipt settlements failed", err);
    }
    try {
      this.resumeOwedMeasurements();
    } catch (err) {
      this.log("verdicts: resuming owed round measurements failed", err);
    }
    // A findings record the round tail nudged for lands after that tail ran.
    if (this.deps.findingsDir) {
      try {
        ingestRepairedFindingsRecords(
          {
            store: this.deps.store,
            findingsDir: this.deps.findingsDir,
            log: this.log.bind(this),
            ...(this.deps.onFindingsRecorded ? { onRecorded: this.deps.onFindingsRecorded } : {}),
          },
          this.now(),
        );
      } catch (err) {
        this.log("verdicts: storing repaired findings records failed", err);
      }
    }
    return done.sort();
  }

  /**
   * Remove staging files (`verdict/<name>.tmp`) that were never committed.
   * Nothing reads them — the watchers' names end
   * in `.json` — so one left by a session that died between its write and
   * `scripts/commit-verdict.sh` would sit in verdict/ forever. Only the two
   * staging shapes, only once a day old, and never a directory.
   */
  private pruneStaleStaging(names: readonly string[]): void {
    const cutoff = this.now().getTime() - STAGED_FILE_MAX_AGE_MS;
    for (const name of names) {
      const match = STAGED_FILE_RE.exec(name);
      if (!match) continue;
      const path = join(this.deps.verdictDir, name);
      try {
        const st = lstatSync(path);
        if (st.isDirectory() || st.mtimeMs > cutoff) continue;
        unlinkSync(path);
        this.deps.store.logEvent("verdict_staging_pruned", Number(match[1]), {
          file: name,
          mtime: new Date(st.mtimeMs).toISOString(),
        });
        this.log(`verdicts: removed ${name}, staged and never committed`);
      } catch {
        // Gone already, or unreadable: the next sweep looks again.
      }
    }
  }

  /** The round `roundNo` names, whatever its status — never another round:
   * a lookup that names a round this PR does not have answers undefined. With
   * no `roundNo`, the PR's newest running round. */
  private runningRound(pr: number, roundNo?: number): RoundRow | undefined {
    if (roundNo !== undefined) {
      return this.deps.store.db
        .prepare("SELECT * FROM rounds WHERE pr = ? AND round_no = ? ORDER BY id DESC LIMIT 1")
        .get(pr, roundNo) as RoundRow | undefined;
    }
    return this.deps.store.db
      .prepare("SELECT * FROM rounds WHERE pr = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
      .get(pr) as RoundRow | undefined;
  }

  /** A file reaching a cancelled round is not applied over the cancel:
   * recorded, archived by the caller, nothing else touched. */
  private ignoreAfterCancel(
    round: RoundRow,
    name: string,
    detail: {
      malformed?: string;
      reason?: string;
      head_sha?: string;
      outcome?: string | null;
      verdict?: string | null;
    } = {},
  ): void {
    this.deps.store.logEvent("verdict_after_cancel_ignored", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      cancel_cause: round.cancel_cause,
      file: name,
      ...detail,
    });
    this.log(
      `verdicts: #${round.pr} round ${round.round_no} was already ${round.status}${round.cancel_cause ? ` (${round.cancel_cause})` : ""} — ${name} is not applied over it`,
    );
  }

  /**
   * The orphan sweep cancels a round because its session did not survive a
   * restart — not because anything decided against the round. A verdict file
   * the session committed before the restart, which the boot sweep had not
   * settled yet (still waiting on its posting receipt), is that round's
   * decision and still applies — the posted review is settled, never re-run —
   * as long as no later round has started on the PR.
   */
  private orphanVerdictOwed(round: RoundRow): boolean {
    return (
      round.status === "cancelled" &&
      round.cancel_cause === "orphan_sweep" &&
      !this.deps.store.hasLaterRound(round.pr, round.round_no)
    );
  }

  /** A done round's interrupted apply that a later round of its PR has
   * overtaken: nothing more of the old verdict lands — no transition, no
   * reviewed-head or withheld mark, no successor settled — and it is recorded
   * settled, so it is not resumed again. Its usage is owed over its own
   * window, which ended at its claim (`finished_at`), never now — the later
   * round's transcript is not this one's. The caller awaits the reads. */
  private settleSupersededResume(round: RoundRow, name: string): OwedMeasurement {
    this.deps.store.logEvent("verdict_resume_superseded", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      file: name,
    });
    const owed = this.deps.store.db.transaction(() => {
      const measurement = this.oweMeasurement(round, round.finished_at);
      this.deps.store.logEvent("verdict_settled", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        superseded: true,
      });
      return measurement;
    })();
    this.log(
      `verdicts: #${round.pr} round ${round.round_no}'s interrupted apply is overtaken by a later round — ${name} lands nothing more`,
    );
    return owed;
  }

  /** A verdict file names a round this PR does not have: archived inert,
   * recorded, and nothing else touched — no round settled, no lifecycle moved,
   * no failure opened against whatever round IS running. */
  private ignoreUnknownRound(pr: number, roundNo: number, name: string, malformed?: string): void {
    this.deps.store.logEvent("verdict_round_unknown", pr, {
      round_no: roundNo,
      file: name,
      ...(malformed !== undefined ? { malformed } : {}),
    });
    this.log(`verdicts: #${pr} has no round ${roundNo} — ${name} is not applied to any round`);
  }

  /** Whether the apply of this round's verdict ran to its last durable step. */
  private verdictSettled(pr: number, roundId: number): boolean {
    return (
      this.deps.store.db
        .prepare(
          "SELECT 1 FROM events WHERE kind = 'verdict_settled' AND pr = ? AND json_extract(payload, '$.round_id') = ? LIMIT 1",
        )
        .get(pr, roundId) !== undefined
    );
  }

  private archive(name: string): void {
    mkdirSync(this.processedDir, { recursive: true });
    try {
      renameSync(
        join(this.deps.verdictDir, name),
        join(this.processedDir, `${this.now().toISOString().replace(/[:.]/g, "-")}-${name}`),
      );
    } catch (err) {
      this.log(`verdicts: could not archive ${name}`, err);
    }
  }

  /** Read + validate + apply one verdict file. Returns true when the file was
   * consumed (applied or quarantined). */
  async handleFile(name: string): Promise<boolean> {
    const match = VERDICT_FILE_RE.exec(name);
    if (!match) return false;
    if (this.inFlight.has(name)) return false;
    this.inFlight.add(name);
    try {
      const pr = Number(match[1]);
      const roundNo = Number(match[2]);
      const path = join(this.deps.verdictDir, name);
      if (!existsSync(path)) return false;

      // Partial writes: an unparseable file is waited out while its bytes
      // are still moving — by its mtime or between our own looks — and
      // declared only once it has sat still, or after a hard window. A session
      // may write in place (open O_TRUNC, then the bytes), and on a
      // CPU-starved container the gap between the two can be long. A file
      // that parses is complete; its shape is judged at once.
      const read = await readSettledJson(path, resolvePartialWritePolicy(this.deps.partialWrite));
      if (read.kind === "missing") return false;
      if (read.reads > 1) {
        this.deps.store.logEvent("verdict_read_waited", pr, {
          file: name,
          round_no: roundNo,
          reads: read.reads,
          waited_ms: Math.round(read.waited_ms),
          outcome: read.kind,
        });
      }
      const parsed: ParsedVerdict =
        read.kind === "parsed"
          ? validateVerdict(read.value)
          : {
              ok: false,
              error:
                `unparseable: ${read.error}` +
                (read.why === "no_tolerance"
                  ? ""
                  : ` (still unparseable after ${read.reads} read(s) over ${(read.waited_ms / 1000).toFixed(1)}s — ${read.why === "settled" ? "the file had stopped changing" : "the partial-write window ran out"})`),
            };

      if (!parsed.ok || !parsed.verdict) {
        await this.handleMalformed(
          pr,
          roundNo,
          name,
          `malformed verdict file ${name}: ${parsed.error ?? "unknown"}`,
        );
        this.archive(name);
        return true;
      }
      // The payload must be the file's own round — the same binding
      // RecheckDecisionWatcher enforces on its filenames. A payload naming
      // another PR or round would otherwise act on that other lifecycle while
      // this round never gets its verdict; it is this round's malformed verdict
      // instead.
      if (parsed.verdict.pr !== pr || parsed.verdict.round_no !== roundNo) {
        await this.handleMalformed(
          pr,
          roundNo,
          name,
          `malformed verdict file ${name}: payload names PR #${parsed.verdict.pr} round ${parsed.verdict.round_no}, not the filename's`,
        );
        this.archive(name);
        return true;
      }
      if (parsed.passes_note) this.log(`verdicts: ${name} passes telemetry: ${parsed.passes_note}`);
      const applied = await this.apply(parsed.verdict, name);
      if (applied === "waiting") return false;
      this.archive(name);
      return true;
    } finally {
      this.inFlight.delete(name);
    }
  }

  /**
   * A verdict file that cannot be applied. Before failing loud it asks
   * whether the round's review already reached GitHub — a posted review is
   * the evidence, and failing it would hold a PR over "no review was
   * produced".
   *
   *   - The round's verdict already settled (a replay of a done round, or a
   *     round guard 2 already closed): inert, like any replay.
   *   - A receipt settlement a restart interrupted (the round is done but its
   *     apply never reached `verdict_settled`): resumed, never failed.
   *   - Running, with a confirmed receipt that proves the decision
   *     (`decidedVerdictFromReceipt`): settled from the receipt — the posted
   *     review is the evidence. No FAILED_LOUD, no self-requeue, so no second
   *     posting.
   *   - Running, refused by guard 2 (a `skipped` record): the guarded no-op.
   *   - Anything else — no receipt, an ambiguous or undecidable one, a legacy
   *     round: the malformed anomaly. A missing receipt still fails loud.
   */
  private async handleMalformed(
    pr: number,
    roundNo: number,
    name: string,
    message: string,
  ): Promise<void> {
    const round = this.runningRound(pr, roundNo);
    if (!round) {
      this.ignoreUnknownRound(pr, roundNo, name, message);
      return;
    }
    if (round.status !== "running") {
      if (this.roundTerminallySettled(round)) {
        this.deps.store.logEvent("verdict_replay_ignored", pr, {
          round_id: round.id,
          round_no: roundNo,
          file: name,
          malformed: message,
        });
        this.log(
          `verdicts: #${pr} round ${roundNo} already settled (${round.status}) — malformed ${name} replays inertly`,
        );
        return;
      }
      // The file is still in verdict/ because the round's receipt settlement
      // was cut short (archive runs only after it): finish that settlement.
      if (await this.resumeReceiptSettlement(round)) return;
      // A cancelled round is closed for good, as in `apply`: a malformed file
      // reaching it afterwards opens no failure over whatever replaced it (an
      // operator's `u` stays undone by nothing the old session writes).
      if (round.status === "cancelled") {
        this.ignoreAfterCancel(round, name, { malformed: message });
        return;
      }
    }
    let anomaly = message;
    if (round && round.status === "running" && round.posting_key) {
      const proof = await this.postingProof(round);
      if (proof.kind === "confirmed" && proof.receipt) {
        const decision = decidedVerdictFromReceipt(proof.receipt);
        if (decision) {
          await this.settleFromReceipt(
            round,
            proof.receipt,
            decision,
            "malformed_verdict",
            message,
          );
          return;
        }
        // Posted, but nothing on the receipt says what was decided: the loud
        // path, saying so.
        anomaly = `${message} (its review was posted — ${proof.receipt.actual_event}${proof.receipt.gh_review_id !== undefined ? `, GitHub review ${proof.receipt.gh_review_id}` : ""} — but the posting receipt does not say what was decided)`;
      } else if (proof.kind === "skipped" && proof.noop) {
        await this.settleGuardedNoop(round, proof.noop, "malformed_verdict");
        return;
      } else if (
        proof.kind === "waiting" &&
        pendingPosting(this.postingReceiptDir(), pr, roundNo, round.posting_key)
      ) {
        // The malformed tail cannot cancel independently owned delivery.
        // Its confirmed receipt will settle the decision on a later tick.
        return;
      }
    }
    await this.handleAnomaly(pr, roundNo, anomaly, "malformed");
  }

  /** Has this (non-running) round been closed for good — a verdict (or a
   * receipt settlement) applied to its last durable step, or a guard-2
   * no-op? */
  private roundTerminallySettled(round: RoundRow): boolean {
    if (round.status === "done") return this.verdictSettled(round.pr, round.id);
    return round.status === "cancelled" && round.cancel_cause === "no_new_evidence";
  }

  /**
   * Hold the round's verdict-file slot — the one `handleFile` holds while it
   * reads, waits out a partial write and applies — for a settlement that does
   * not come from the file. A receipt settlement and a verdict
   * landing in the same moment can then never both apply. Busy ⇒ undefined:
   * the caller's next tick decides again.
   */
  private async withVerdictSlot<T>(
    pr: number,
    roundNo: number,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const name = verdictFileName(pr, roundNo);
    if (this.inFlight.has(name)) return undefined;
    this.inFlight.add(name);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(name);
    }
  }

  private verdictFilePresent(pr: number, roundNo: number): boolean {
    return existsSync(join(this.deps.verdictDir, verdictFileName(pr, roundNo)));
  }

  /**
   * Close a running round from its confirmed posting receipt:
   * the review is on GitHub and the verdict file is malformed, never came, or
   * did not come within the posted-tail grace. Never posts anything — the
   * whole point is that the review already went out once.
   *
   * Only for a receipt that proves the decision (`decidedVerdictFromReceipt`);
   * an undecidable one stays on the caller's loud path. The round is applied
   * exactly as its verdict file would have been — the one `apply` path, with
   * the posting already proven — so the labels, the transition, the
   * reviewed-head mark, the withheld-approval mark, the successor settlement,
   * the usage, the ledger and findings-record checks and the held wakes all
   * happen as usual. Its summary says where the verdict came from; its
   * executed-pass telemetry is honestly unknown.
   *
   * The claim has two halves. A fresh read of the round, followed with no await
   * between by `apply`'s own read: a round the operator cancelled, a newer
   * round superseded, or another path settled while the caller awaited GitHub
   * is never applied over. And `apply`'s `finishRound` is a compare-and-set on
   * the status that read saw: one that changed while `apply` itself awaited
   * the label calls is not applied over either — the apply stops there
   * (`verdict_apply_claim_lost`). The `verdict_settled_from_receipt` event is
   * written before the apply and carries the verdict it applies, so a restart
   * in the middle of it is resumed (`resumeReceiptSettlement`), never failed.
   */
  private async settleFromReceipt(
    round: RoundRow,
    receipt: PostingReceipt,
    decision: ReceiptDecision,
    via: ReceiptSettleVia,
    why: string,
  ): Promise<"applied" | "replayed"> {
    const { store } = this.deps;
    const ghId = receipt.gh_review_id ?? null;
    const posted = `${receipt.actual_event}${ghId !== null ? `, GitHub review ${ghId}` : ""}`;
    const plain =
      via === "malformed_verdict"
        ? "its verdict file could not be read"
        : via === "deadline"
          ? "no verdict file arrived before the round deadline"
          : via === "settled_without_verdict"
            ? "the session finished without writing its verdict file"
            : "the session did not write its verdict file within the grace after posting";
    const event = {
      round_id: round.id,
      round_no: round.round_no,
      via,
      why,
      posting_key: round.posting_key,
      head_sha: receipt.head_sha,
      intended_event: receipt.intended_event,
      actual_event: receipt.actual_event,
      gh_review_id: ghId,
      confirmed_at: receipt.confirmed_at ?? null,
      decided_verdict: decision.verdict,
      approval_withheld: decision.approval_withheld === true,
    };
    // ---- the claim: fresh read → apply, with no await between ---------------
    const fresh = this.runningRound(round.pr, round.round_no);
    if (!fresh || fresh.id !== round.id || fresh.status !== "running") {
      store.logEvent("verdict_settled_from_receipt_replayed", round.pr, {
        ...event,
        round_status: fresh?.id === round.id ? fresh.status : "missing",
      });
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} is no longer running (${fresh?.id === round.id ? fresh.status : "missing"}) — its receipt settlement (${via}) is not applied`,
      );
      return "replayed";
    }
    const reading = decision.approval_withheld
      ? "a COMMENT the session asked for is the round templates' withheld-approval shape, so it is APPROVE with the approval withheld until CI is green at this head"
      : `the receipt proves ${decision.verdict}`;
    const v: VerdictFile = {
      pr: round.pr,
      round_no: round.round_no,
      verdict: decision.verdict,
      head_sha: receipt.head_sha,
      ...(decision.approval_withheld ? { approval_withheld: true } : {}),
      summary:
        `This round's review was posted (${posted}), but ${plain}, so its verdict was settled from the posted review: ${reading}. ` +
        "The session's own summary and pass telemetry were not available.",
      finished_at: this.now().toISOString(),
    };
    store.logEvent("verdict_settled_from_receipt", round.pr, { ...event, verdict_file: v });
    this.log(
      `verdicts: #${round.pr} round ${round.round_no} settled from its posting receipt (${posted}) as ${decision.verdict}${decision.approval_withheld ? " (approval withheld)" : ""} — ${plain}`,
    );
    await this.apply(v, verdictFileName(round.pr, round.round_no), { via, gh_review_id: ghId });
    return "applied";
  }

  /** The receipt settlement this round started (its `verdict_settled_from_receipt`
   * event, with the verdict it was applying), if any. */
  private receiptSettlementStarted(
    round: RoundRow,
  ): { verdict: VerdictFile; via: ReceiptSettleVia; gh_review_id: number | null } | undefined {
    const row = this.deps.store.db
      .prepare(
        "SELECT payload FROM events WHERE kind = 'verdict_settled_from_receipt' AND pr = ? AND json_extract(payload, '$.round_id') = ? ORDER BY id DESC LIMIT 1",
      )
      .get(round.pr, round.id) as { payload: string } | undefined;
    if (!row) return undefined;
    let payload: { verdict_file?: unknown; via?: unknown; gh_review_id?: unknown };
    try {
      payload = JSON.parse(row.payload) as typeof payload;
    } catch {
      return undefined;
    }
    const parsed = validateVerdict(payload.verdict_file);
    if (!parsed.ok || !parsed.verdict) return undefined;
    if (parsed.verdict.pr !== round.pr || parsed.verdict.round_no !== round.round_no)
      return undefined;
    if (parsed.verdict.verdict !== "APPROVE" && parsed.verdict.verdict !== "REQUEST_CHANGES")
      return undefined;
    return {
      verdict: parsed.verdict,
      via: typeof payload.via === "string" ? (payload.via as ReceiptSettleVia) : "deadline",
      gh_review_id: typeof payload.gh_review_id === "number" ? payload.gh_review_id : null,
    };
  }

  /**
   * Finish a receipt settlement a restart cut short. `apply` finishes the
   * round row before its last durable steps (the transition, the marks, the
   * successor) and records `verdict_settled` only after them; a verdict file
   * survives a restart in that window and resumes the apply, but
   * a receipt settlement has no file — and on the malformed path the file it
   * does have is the broken one, which would turn a posted review into
   * FAILED_LOUD. So the settlement's own event carries the verdict it applies,
   * and a done round whose apply never settled is re-applied from it, the same
   * way a surviving file is. Returns false when there is nothing to resume.
   * The caller holds the round's verdict slot.
   */
  private async resumeReceiptSettlement(round: RoundRow): Promise<boolean> {
    if (round.status !== "done" || this.verdictSettled(round.pr, round.id)) return false;
    const started = this.receiptSettlementStarted(round);
    if (!started) return false;
    this.deps.store.logEvent("verdict_settled_from_receipt_resumed", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      via: started.via,
      verdict: started.verdict.verdict,
    });
    this.log(
      `verdicts: #${round.pr} round ${round.round_no} — resuming its interrupted receipt settlement (${started.via})`,
    );
    await this.apply(started.verdict, verdictFileName(round.pr, round.round_no), {
      via: started.via,
      gh_review_id: started.gh_review_id,
    });
    return true;
  }

  /**
   * The sweep's half of the resume: receipt settlements with no verdict file
   * (the deadline and stage-limit paths) that a restart cut short. Bounded to
   * the last two days of settlements — a restart is minutes, and a done round
   * older than that is not touched on the strength of an old event.
   */
  private async resumeInterruptedSettlements(): Promise<void> {
    const { store } = this.deps;
    const cutoff = new Date(this.now().getTime() - 2 * 86_400_000).toISOString();
    const rows = store.db
      .prepare(
        "SELECT DISTINCT pr, json_extract(payload, '$.round_id') AS round_id FROM events WHERE kind = 'verdict_settled_from_receipt' AND ts >= ?",
      )
      .all(cutoff) as Array<{ pr: number; round_id: number | null }>;
    for (const row of rows) {
      if (row.round_id === null) continue;
      const round = store.roundsFor(row.pr).find((r) => r.id === row.round_id);
      if (!round || round.status !== "done" || this.verdictSettled(round.pr, round.id)) continue;
      // A file still in verdict/ resumes through handleFile.
      if (this.verdictFilePresent(round.pr, round.round_no)) continue;
      try {
        await this.withVerdictSlot(round.pr, round.round_no, () =>
          this.resumeReceiptSettlement(round),
        );
      } catch (err) {
        this.log(`verdicts: resuming #${round.pr} round ${round.round_no} failed`, err);
      }
    }
  }

  private postingReceiptDir(): string {
    return (
      this.deps.postingReceiptDir ??
      join(this.deps.root ?? sandboxRoot(), "state", "posting-receipts")
    );
  }

  private async postingProof(
    round: RoundRow,
    verdict?: VerdictFile,
  ): Promise<{
    kind: "legacy" | "confirmed" | "waiting" | "failed" | "skipped";
    detail?: string;
    receipt?: PostingReceipt;
    /** The guarded no-op record, when `kind` is `skipped`. */
    noop?: GuardedNoopReceipt;
    /** Why `failed`, for the one caller that may otherwise requeue — a
     * stage limit:
     *   - `unconfirmed`: nothing says a review went out — no receipt, or a
     *     `prepared` one whose marker reconcile read GitHub and found nothing
     *     (or a dry run, which never posts). Requeueing cannot post twice.
     *   - `ambiguous`: a `prepared` receipt for exactly this round whose POST
     *     may have landed, and the marker reconcile did not complete (the
     *     read threw, or the adapter cannot read reviews). Unknown, never
     *     read as "not posted".
     *   - `contradicted`: evidence of a posting that disagrees with the round
     *     (conflicting linkage, several matching reviews, a receipt or review
     *     that does not match the verdict, a no-op record from the other
     *     mode).
     *   - `exhausted`: a `deferred` receipt whose daemon-owned
     *     retry is over without a confirmed review — its window spent, a
     *     guard refused it, or its handoff is unreadable. The POST was
     *     attempted, so never a requeue: every path fails it loud. */
    failure?: "unconfirmed" | "ambiguous" | "contradicted" | "exhausted";
  }> {
    if (!round.posting_key) return { kind: "legacy" };
    const expectedHead = verdict?.head_sha ?? round.posting_key.split(":").slice(3).join(":");
    const receipt = readPostingReceipt(this.postingReceiptDir(), round.pr, round.round_no);
    const receiptIdentityOk =
      receipt !== undefined &&
      receipt.posting_key === round.posting_key &&
      receipt.pr === round.pr &&
      receipt.round_no === round.round_no &&
      receipt.head_sha.toLowerCase() === expectedHead.toLowerCase();
    // The shell recorded a guard-2 refusal for this exact identity.
    // It is answered only after the live marker reconcile below has had its
    // say: the record claims no POST was attempted, and a bot review carrying
    // this round's marker at this head would prove it wrong — GitHub's truth
    // wins over the file, exactly as it wins over a missing file.
    let noop: GuardedNoopReceipt | undefined;
    let noopModeMismatch = false;
    if (receiptIdentityOk && receipt && receipt.status === "skipped") {
      // Same rule a `dryrun` receipt lives under: a record written in the
      // other mode came from a script whose config disagrees with this
      // daemon's, and that disagreement is not something to settle quietly.
      if ((receipt.mode === "dryrun") === this.deps.cfg.dry_run) noop = receipt;
      else noopModeMismatch = true;
    }
    // A deferred POST is posting IN FLIGHT for its whole retry
    // window. The daemon's retry owns it — the marker read included, so this
    // proof makes no GitHub read of its own that could race the retry's POST
    // — and no stage limit, deadline or verdict apply may requeue, fail or
    // kill the round meanwhile (a rerun would post a second review).
    if (
      receiptIdentityOk &&
      receipt &&
      receipt.status === "deferred" &&
      !this.deps.cfg.dry_run &&
      pendingPosting(this.postingReceiptDir(), round.pr, round.round_no, round.posting_key)
    )
      return { kind: "waiting" };
    if (receiptIdentityOk && receipt && receipt.status !== "skipped") {
      if (receipt.status === "confirmed" && (!verdict || receiptMatchesVerdict(receipt, verdict))) {
        const persisted = this.deps.store.confirmRoundPosting(round.id, {
          posting_key: receipt.posting_key,
          actual_event: receipt.actual_event,
          gh_review_id: receipt.gh_review_id!,
          gh_commit_id: receipt.gh_commit_id!,
          confirmed_at: receipt.confirmed_at!,
        });
        return persisted
          ? { kind: "confirmed", receipt }
          : {
              kind: "failed",
              detail: `conflicting posting linkage for ${round.posting_key}`,
              failure: "contradicted",
            };
      }
      if (
        receipt.status === "dryrun" &&
        this.deps.cfg.dry_run &&
        (!verdict || receiptMatchesVerdict(receipt, verdict))
      ) {
        const persisted = this.deps.store.confirmRoundPosting(round.id, {
          posting_key: receipt.posting_key,
          actual_event: receipt.actual_event,
          gh_review_id: null,
          gh_commit_id: receipt.head_sha,
          confirmed_at: receipt.confirmed_at ?? receipt.prepared_at,
        });
        return persisted
          ? { kind: "confirmed", receipt }
          : {
              kind: "failed",
              detail: `conflicting dry-run posting linkage for ${round.posting_key}`,
              failure: "contradicted",
            };
      }
      if ((receipt.status === "confirmed" || receipt.status === "dryrun") && verdict) {
        return {
          kind: "failed",
          detail: `posting receipt ${round.posting_key} does not match verdict/head`,
          failure: "contradicted",
        };
      }
    }

    // The POST may have reached GitHub before the shell could persist its
    // response. Reconcile by the inert marker; never retry a mutation on an
    // ambiguous transport outcome.
    // Whether GitHub was actually read for the marker: a prepared receipt
    // past its grace is "not posted" only when it was — a read that threw, or
    // no way to read, leaves it unknown.
    let reconciled = false;
    if (!this.deps.cfg.dry_run && this.deps.adapter.listReviewsFull) {
      try {
        const marker = postingMarker(round.posting_key);
        const bot = this.deps.cfg.github.bot_login;
        const reviews = await this.deps.adapter.listReviewsFull(round.pr);
        reconciled = true;
        const matches = reviews.filter(
          (review) =>
            (review.user === bot || review.user === `${this.deps.cfg.github.app_slug}[bot]`) &&
            review.commit_id?.toLowerCase() === expectedHead.toLowerCase() &&
            review.body.includes(marker),
        );
        if (matches.length > 1)
          return {
            kind: "failed",
            detail: `multiple bot reviews match ${round.posting_key}`,
            failure: "contradicted",
          };
        if (matches.length === 1) {
          const match = matches[0]!;
          // Only the three submitted states say what was posted. Any other —
          // a review a person retracted, whose state no longer says whether
          // it approved or blocked, or one still pending — is evidence the
          // round's posting cannot be read off, never a COMMENT (the posting
          // outbox reads them the same way).
          const state = match.state.toUpperCase();
          const actualEvent: PostingReceipt["actual_event"] | undefined =
            state === "APPROVED"
              ? "APPROVE"
              : state === "CHANGES_REQUESTED"
                ? "REQUEST_CHANGES"
                : state === "COMMENTED"
                  ? "COMMENT"
                  : undefined;
          if (!actualEvent)
            return {
              kind: "failed",
              detail: `GitHub review ${match.id} carries ${round.posting_key} in state ${match.state}, which does not say what was posted`,
              failure: "contradicted",
            };
          const verifiedIntent =
            receiptIdentityOk && receipt && receipt.status !== "skipped" ? receipt : undefined;
          const synthetic: PostingReceipt = {
            version: 1,
            posting_key: round.posting_key,
            marker,
            pr: round.pr,
            round_no: round.round_no,
            head_sha: expectedHead,
            intended_event: verifiedIntent?.intended_event ?? actualEvent,
            actual_event: actualEvent,
            ...(verifiedIntent?.status === "deferred"
              ? { delivered_by: "daemon_retry" as const }
              : {}),
            status: "confirmed",
            payload_sha256: "0".repeat(64),
            prepared_at: match.submitted_at ?? this.now().toISOString(),
            confirmed_at: match.submitted_at ?? this.now().toISOString(),
            gh_review_id: match.id,
            gh_commit_id: match.commit_id,
            gh_state: match.state,
            ...(verifiedIntent ? {} : { reconciled: true }),
          };
          if (verdict && !receiptMatchesVerdict(synthetic, verdict)) {
            return {
              kind: "failed",
              detail: `GitHub review ${match.id} event does not match verdict`,
              failure: "contradicted",
            };
          }
          const persisted = this.deps.store.confirmRoundPosting(round.id, {
            posting_key: round.posting_key,
            actual_event: actualEvent,
            gh_review_id: match.id,
            gh_commit_id: match.commit_id,
            confirmed_at: synthetic.confirmed_at!,
          });
          if (!persisted)
            return {
              kind: "failed",
              detail: `conflicting reconciled posting linkage for ${round.posting_key}`,
              failure: "contradicted",
            };
          this.deps.store.logEvent("posting_receipt_reconciled", round.pr, {
            round_no: round.round_no,
            posting_key: round.posting_key,
            gh_review_id: match.id,
          });
          if (noop) {
            // The file said "never posted"; GitHub says otherwise. The posted
            // review is the truth and is linked above; the record is noted as
            // contradicted so the audit trail explains the disagreement.
            this.deps.store.logEvent("posting_guarded_noop_contradicted", round.pr, {
              round_no: round.round_no,
              posting_key: round.posting_key,
              gh_review_id: match.id,
              skipped_at: noop.skipped_at,
            });
          }
          return { kind: "confirmed", receipt: synthetic };
        }
      } catch (error) {
        this.log(
          `posting receipt reconciliation failed for #${round.pr} round ${round.round_no}`,
          error,
        );
      }
    }

    if (noop) return { kind: "skipped", noop };
    if (noopModeMismatch) {
      return {
        kind: "failed",
        detail: `guarded no-op record for ${round.posting_key} was written in ${this.deps.cfg.dry_run ? "live" : "dry-run"} mode; this daemon is not`,
        failure: "contradicted",
      };
    }

    // Delivery debt outlives the session and its deadline. The independent
    // outbox worker reconciles/retries it; never rerun lenses or archive a
    // waiting verdict merely because GitHub's outage outlasted the grace.
    if (
      !this.deps.cfg.dry_run &&
      pendingPosting(this.postingReceiptDir(), round.pr, round.round_no, round.posting_key)
    )
      return { kind: "waiting" };
    // A deferred POST whose retry is over (the outbox job is failed or gone)
    // and whose marker the read above did not find: attempted, never
    // confirmed. Loud on every path — never a requeue.
    if (receiptIdentityOk && receipt && receipt.status === "deferred") {
      const ledger = this.deps.store.postingRetry(round.posting_key);
      return {
        kind: "failed",
        detail: `deferred posting for ${round.posting_key} was not delivered${ledger ? ` (${ledger.status} after ${ledger.attempts} attempt(s)${ledger.last_error ? `: ${ledger.last_error}` : ""})` : " (no retry on record)"}`,
        failure: "exhausted",
      };
    }

    const origin =
      receiptIdentityOk && receipt && receipt.status !== "skipped"
        ? receipt.prepared_at
        : round.started_at;
    const graceS =
      this.deps.postingReceiptGraceS ??
      this.deps.cfg.daemon.posting_receipt_grace_s ??
      DEFAULT_POSTING_RECEIPT_GRACE_S;
    if (this.now().getTime() - Date.parse(origin) < graceS * 1000) return { kind: "waiting" };
    const postMayHaveLanded =
      !this.deps.cfg.dry_run &&
      !reconciled &&
      receiptIdentityOk &&
      receipt !== undefined &&
      receipt.status === "prepared";
    return {
      kind: "failed",
      detail: `no confirmed posting receipt for ${round.posting_key} after ${graceS}s`,
      failure: postMayHaveLanded ? "ambiguous" : "unconfirmed",
    };
  }

  /**
   * Posting guard 2 refused this round's review — the head was
   * already reviewed and no author reply had landed since — and the shell
   * recorded that refusal as an identity-bound no-op before exiting. This is
   * successful terminal bookkeeping, not a verdict and not a failure:
   *
   *   - the round closes as `cancelled` with cause `no_new_evidence` — never
   *     `done` with the verdict the session wrote, because that verdict was
   *     never posted, and never `infrastructure_failure`, because nothing
   *     failed;
   *   - the PR returns to the state its standing review put it in, read off
   *     the live mark through the one standing-review interpretation; the
   *     mark itself, GitHub and the withheld-approval mark are left exactly
   *     as they were;
   *   - round-end housekeeping runs as after a verdict: a fresh-head
   *     successor is promoted, otherwise the wakes held during the round
   *     flow;
   *   - no `review_failures` row, no retry budget, no Slack FAILED_LOUD, no
   *     replacement round, no escalation.
   *
   * Consumed once: the claim is a fresh read of the round row followed
   * synchronously by the cancel — no await between them, so the deadline
   * sweep and the verdict sweep (separate timers, each of which may have
   * awaited a GitHub read in `postingProof`) cannot both win. The loser sees
   * a round that is no longer running and archives its file without touching
   * anything.
   *
   * Returns `failed` — after handing the round to the ordinary loud path —
   * when the record's standing mark no longer describes the live one. That is
   * state changing under the record, which is ambiguous, and ambiguous stays
   * loud.
   */
  private async settleGuardedNoop(
    round: RoundRow,
    noop: GuardedNoopReceipt,
    via: ReceiptSettleVia,
    verdict?: VerdictFile,
  ): Promise<"settled" | "replayed" | "failed"> {
    const { store, cfg, adapter } = this.deps;
    // ---- the claim: fresh read → cancel, synchronously -----------------------
    const fresh = this.runningRound(round.pr, round.round_no);
    if (!fresh || fresh.id !== round.id || fresh.status !== "running") {
      store.logEvent("posting_guarded_noop_replayed", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        posting_key: round.posting_key,
        via,
        round_status: fresh?.status ?? "missing",
      });
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} guarded no-op already settled (${fresh?.status ?? "missing"}) — ${via} ignored`,
      );
      return "replayed";
    }
    const measure = measureModeFor(via);
    const mark = store.reviewedHead(round.pr);
    if (!guardedNoopMatchesMark(noop, mark)) {
      await this.failPostingProof(
        round,
        `guarded no-op record for ${round.posting_key} no longer matches the live reviewed-head mark`,
        "posting_receipt",
        measure,
      );
      return "failed";
    }
    const standingInfo = standingReview(mark);
    const standing: StandingDecidedVerdict | null =
      standingInfo.kind === "decided" ? standingInfo.verdict : null;
    const head7 = noop.head_sha.slice(0, 7);
    const { owed, restored } = store.db.transaction(() => {
      store.markRoundCancelled(
        round.id,
        `posting refused by guard 2 — ${head7} already reviewed with no author reply since; ` +
          `standing ${standing ?? "review (verdict unknown)"} stands, nothing was posted`,
        "no_new_evidence",
      );
      // ---- claimed; the restoration below lands in this same turn --------------
      // The round ran a full review and burned its tokens: measured like every
      // other terminal path, never hidden behind a benign cause. Its window
      // closes here, and the measurement is owed from here, durably; the reads
      // (async — seconds, at most the usage budget) run last, after the
      // restored lifecycle and the held-wake flush, so they
      // never widen the window before either: no round dispatched while they
      // run can receive this round's held wakes. A restart while they run
      // resumes them.
      //
      // The restored lifecycle and the settlement event land synchronously
      // with the cancel, in one SQLite transaction: a replay of a cancelled round
      // is inert, so a restart or failed write must never expose partial settlement
      // (the PR never stranded in `reviewing`). The successor is promoted only
      // once this round's in-progress label is off, so that removal can never
      // strip the label the successor's dispatch adds; a restart between the
      // two leaves the durable successor obligation to reconcile's
      // successor-obligations step.
      const owed = this.oweMeasurement(round);

      if (standingInfo.kind === "unknown") {
        // A COMMENT-only mark: guard 2 was right to refuse, and nothing here
        // may guess what that comment decided. Tracked, never an approve, with
        // an anomaly naming the shape.
        store.logAnomaly(
          "standing_review_unknown",
          round.pr,
          round.round_no,
          `round ${round.round_no}'s review was refused by posting guard 2 at ${head7} (already reviewed, no author reply since), ` +
            `but the reviewed-head mark carries no verdict (posted_event=${standingInfo.posted_event ?? "null"}). ` +
            `Nothing was posted and no verdict was guessed; the PR is tracked until the author pushes or replies.`,
        );
      }
      const restored = restoreStandingLifecycle(store, round.pr, standing, {
        botLogin: cfg.github.bot_login,
        now: () => this.now(),
        reason: standing
          ? `posting-guarded-noop:${standing}`
          : "posting-guarded-noop:standing-unknown",
      });
      store.logEvent("posting_guarded_noop", round.pr, {
        stage: "posting",
        via,
        round_id: round.id,
        round_no: round.round_no,
        posting_key: round.posting_key,
        head_sha: noop.head_sha,
        guard: noop.skip_reason,
        skipped_at: noop.skipped_at,
        mode: noop.mode,
        intended_event: noop.intended_event,
        unposted_verdict: verdict?.verdict ?? null,
        standing_verdict: standing,
        standing_source: standingInfo.kind === "decided" ? standingInfo.source : null,
        restored_state: restored,
        trigger_ts: round.trigger_ts,
        mark: snapshotMark(mark!),
      });
      return { owed, restored };
    })();
    this.log(
      `verdicts: #${round.pr} round ${round.round_no} closed as a guarded no-op — guard 2 refused at ${head7}, ` +
        `standing ${standing ?? "unknown"} stands, PR ${restored} (via ${via})`,
    );
    // ---- everything below may await ------------------------------------------
    await this.safe(
      () => adapter.removeLabel(round.pr, cfg.github.in_progress_label),
      `remove ${cfg.github.in_progress_label} on #${round.pr}`,
    );
    // Round-end housekeeping, the same as a verdict's: a fresh-head successor
    // takes the session slot; otherwise the wakes held during the round flow.
    const successorPromoted = store.promoteSuccessor(round.pr);
    if (successorPromoted)
      this.log(
        `verdicts: #${round.pr} preserved fresh-head successor after skipped round ${round.round_no}`,
      );
    await this.safe(
      () => this.deps.hooks.compactSession?.(round.pr) ?? Promise.resolve(),
      `compact pr-${round.pr}`,
    );
    if (!successorPromoted) await this.flushWakes(round.pr);
    await this.closeMeasurement(owed, measure);
    return "settled";
  }

  /**
   * A round whose posting cannot be proven: cancelled, and its review owed as
   * a FAILED_LOUD incident. The claim is a fresh read that the round is still
   * running, followed synchronously by the cancel and the incident — every
   * caller has awaited GitHub (the posting proof) since it read the round, and
   * a round some other path ended meanwhile (an operator's `u`, a verdict, a
   * receipt settlement) owes nothing here: false, and nothing is touched.
   *
   * `resumed`: the caller is a done round's interrupted apply whose resumed
   * posting proof failed. That round is done but never settled, its PR left
   * where the interrupted apply stopped, and nothing else will repair it — so
   * it stays loud: the incident opens, with nothing to cancel.
   */
  private async failPostingProof(
    round: RoundRow,
    detail: string,
    stage = "posting_receipt",
    measure: MeasureMode = "inline",
    resumed = false,
  ): Promise<boolean> {
    const { store, cfg, adapter } = this.deps;
    const fresh = this.runningRound(round.pr, round.round_no);
    const resumedDone =
      resumed &&
      fresh?.id === round.id &&
      fresh.status === "done" &&
      !this.verdictSettled(round.pr, round.id);
    if (!resumedDone && !this.stillRunning(round)) {
      store.logEvent("posting_failure_round_ended", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        round_status: fresh?.id === round.id ? fresh.status : "missing",
        stage,
        detail,
      });
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} ended while its posting was proven — ${stage} opens no failure over it`,
      );
      return false;
    }
    if (!resumedDone)
      store.markRoundCancelled(
        round.id,
        `posting receipt failure — ${detail}`,
        "infrastructure_failure",
      );
    // This round ran a full review and burned its tokens — the receipt is
    // what failed, not the work. It stays in `SUM(est_usd) FROM rounds` like
    // every other row, so it must be measured here too. Its window closes now
    // and no successor is running, so nothing double-counts. The cancel and
    // the FAILED_LOUD incident land in one turn — a restart inside any await
    // below must not leave a cancelled round with no loud failure behind it —
    // and the label call and the reads (async) run after them, the reads
    // owed durably from here, so a restart while they run resumes them.
    const owed = this.oweMeasurement(round);
    const command = store.sessionCommandForRound(round.pr, round.round_no);
    const successor = store.successorFor(round.pr);
    const failure = store.openReviewFailure({
      pr: round.pr,
      command_id: command?.id ?? null,
      round_id: round.id,
      round_no: round.round_no,
      head_sha: successor?.head_sha ?? store.getPr(round.pr)?.head_sha ?? "",
      stage,
      detail,
      attempts: command?.attempt ?? 1,
      retry_cap: 0,
    });
    store.logAnomaly(
      "review_failed_loud",
      round.pr,
      round.round_no,
      `posting receipt: ${detail}; work remains owed as ${failure.incident_id}`,
    );
    await this.safe(
      () => adapter.removeLabel(round.pr, cfg.github.in_progress_label),
      `remove ${cfg.github.in_progress_label} on #${round.pr}`,
    );
    await this.announceSafe((a) =>
      a.anomaly({
        pr: round.pr,
        round_no: round.round_no,
        kind: "failed_loud",
        deadline_min: cfg.daemon.round_deadline_min,
        incident_id: failure.incident_id,
      }),
    );
    await this.closeMeasurement(owed, measure);
    return true;
  }

  /**
   * `failPostingProof` for the sweeps that are not the verdict's own path —
   * the round deadline and the round-stage limits — after their posting
   * proof awaited GitHub. Inside the verdict-file slot, so a verdict that
   * arrived meanwhile wins: one on disk, or one the watcher is applying (the
   * slot busy), is left to the watcher and nothing is failed under it.
   * `verdict`: a verdict owns the round; `ended`: the round ended; `failed`:
   * FAILED_LOUD.
   */
  private async failPostingProofUnlessVerdict(
    round: RoundRow,
    detail: string,
    stage: string,
  ): Promise<"verdict" | "ended" | "failed"> {
    const outcome = await this.withVerdictSlot(round.pr, round.round_no, async () => {
      if (this.verdictFilePresent(round.pr, round.round_no)) return "verdict" as const;
      return (await this.failPostingProof(round, detail, stage, "background"))
        ? ("failed" as const)
        : ("ended" as const);
    });
    return outcome ?? "verdict";
  }

  /** The handoff: posting receipt, labels, round record, transition.
   *
   * `proven`: the caller already holds this round's confirmed posting
   * receipt and built `v` from it (`settleFromReceipt`, or the resume
   * of one a restart cut short). The receipt is not proven a second time — a
   * second marker reconcile could fail on a transient GitHub read and turn a
   * posted review into a loud failure — and the durable events say where the
   * verdict came from. */
  private async apply(
    v: VerdictFile,
    name: string,
    proven?: { via: ReceiptSettleVia; gh_review_id: number | null },
  ): Promise<"applied" | "waiting" | "failed"> {
    const { cfg, store, adapter } = this.deps;
    const round = this.runningRound(v.pr, v.round_no);
    // The status this apply claims the round in: `finishRound` below lands
    // only while the row still has it, so an operator cancel or another
    // terminal path that lands while this awaits GitHub is never overwritten.
    const claimedStatus = round?.status;
    // A receipt settlement from the deadline tick or the round-stage supervisor
    // hands its measurement to the background; a verdict file's is awaited.
    const measure: MeasureMode = proven ? measureModeFor(proven.via) : "inline";

    // A file naming a round this PR never had is nobody's verdict: it may
    // neither settle another round nor move the PR's lifecycle.
    if (!round) {
      this.ignoreUnknownRound(v.pr, v.round_no, name);
      return "applied";
    }

    // A round already cancelled is closed for good, whoever cancelled it — an
    // operator's `u`, a self-requeue that queued its replacement, a
    // supersession, the orphan sweep. A verdict file that reaches it
    // afterwards (an archive that failed, a session finishing behind the
    // cancel) is inert: finishing the round would apply the old verdict over
    // whatever replaced it. The same rule `finishRound`'s claim enforces for a
    // cancel landing DURING the apply. A guard-2 no-op (`no_new_evidence`)
    // keeps its own replay path below, and so does the one cancel that is not
    // a decision about the round (`orphanVerdictOwed`).
    if (
      round.status === "cancelled" &&
      round.cancel_cause !== "no_new_evidence" &&
      !this.orphanVerdictOwed(round)
    ) {
      this.ignoreAfterCancel(round, name, {
        head_sha: v.head_sha,
        outcome: v.outcome ?? null,
        verdict: v.verdict ?? null,
      });
      return "applied";
    }

    // A done round whose apply a restart cut short resumes below — unless a
    // later round of the PR has started since: that round owns the lifecycle,
    // the marks and the successor now, and the old verdict is not applied
    // over it.
    if (
      round.status === "done" &&
      !this.verdictSettled(v.pr, round.id) &&
      store.hasLaterRound(v.pr, v.round_no)
    ) {
      await this.closeMeasurement(this.settleSupersededResume(round, name), measure);
      return "applied";
    }

    // Guard-5 landing: the session was refused at posting time because the
    // PR advanced mid-round, and said so explicitly instead of idling to
    // deadline expiry. Mapped exactly like the needs_human_incomplete redo:
    // immediate cancel + capped self-requeue (the same per-head counter,
    // keyed on the fresh head the PR row now carries) — and the session is
    // not killed: it is healthy, it did the
    // right thing. No verdict applies, no label lands, no reviewed-head mark
    // is stamped (nothing was reviewed-and-decided at the live head). Past
    // the cap the anomaly path terminalizes — never an approve.
    if (v.outcome === "head_moved") {
      // The round already ended — this file is a replay of a report that was
      // handled (or of a round some other path closed). Nothing is owed, and
      // nothing is reported again.
      if (round.status !== "running") {
        store.logEvent("verdict_replay_ignored", v.pr, {
          round_id: round.id,
          round_no: v.round_no,
          round_status: round.status,
          outcome: "head_moved",
          file: name,
        });
        return "applied";
      }
      store.logEvent("head_moved_reported", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        reviewed_head: v.head_sha,
        file: name,
      });
      if (await this.selfRequeue(round, "head_moved")) {
        await this.safe(
          () => adapter.removeLabel(v.pr, cfg.github.in_progress_label),
          `remove ${cfg.github.in_progress_label} on #${v.pr}`,
        );
        this.log(
          `verdicts: #${v.pr} round ${v.round_no} ended head_moved — cancelled and requeued at the fresh head`,
        );
        return "applied";
      }
      await this.handleAnomaly(
        v.pr,
        v.round_no,
        `round ${v.round_no} reported head_moved (reviewed ${v.head_sha.slice(0, 7)}, the PR advanced mid-round) but could not be self-requeued — cap exhausted or no running round`,
        "overdue",
      );
      return "applied";
    }

    // A required pass (pass-baseline or a risk lens, marked by the plan
    // builder) that failed and never completed: the posting route refused to
    // post, so the round is redone through the capped self-requeue instead
    // of applying a verdict reached without it.
    if (round && round.status === "running") {
      const requeued = await this.requeueOnRequiredPassGap(v, round, proven !== undefined);
      if (requeued) return "applied";
    }

    // NEEDS_HUMAN is never an escape hatch for an unfinished review. One with
    // no executed-pass evidence (e.g. "the configured passes were
    // unavailable") did not do the review; redo it through the capped
    // self-requeue. Past the cap (or with no running round to cancel) the
    // verdict applies below like any other — the cap guarantees this can
    // never loop. No reviewed-head mark is recorded on
    // this path, so the redo round can dispatch and post at the same head.
    // A round whose review already went out — a posting receipt other than a
    // guard-2 refusal, confirmed or still owned by the daemon's delivery — is
    // not redone (a redo would post again): it applies below through its
    // posting proof, as the required-pass gap does.
    if (
      v.verdict === "NEEDS_HUMAN" &&
      round.status === "running" &&
      (!v.passes || v.passes.length === 0)
    ) {
      const posting = this.reviewWentOut(v.pr, v.round_no, proven !== undefined);
      store.logEvent("needs_human_incomplete", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        head_sha: v.head_sha,
        passes_reported: v.passes ? 0 : null,
        ...(posting ? { posting_receipt: posting } : {}),
      });
      if (!posting && (await this.selfRequeue(round, "needs_human_incomplete"))) {
        await this.safe(
          () => adapter.removeLabel(v.pr, cfg.github.in_progress_label),
          `remove ${cfg.github.in_progress_label} on #${v.pr}`,
        );
        this.log(
          `verdicts: #${v.pr} round ${v.round_no} NEEDS_HUMAN without executed passes — requeued, not parked`,
        );
        return "applied";
      }
    }

    // A round already done has had its verdict applied: this file is a
    // replay — an archive that failed and left it in verdict/,
    // or a session re-emitting an old round's file. Applying it again would
    // re-run every side effect below and stamp the old head over a newer
    // reviewed-head mark. Inert, exactly like the guarded-noop replay.
    //
    // "Done" alone is not proof: finishRound runs before the rest of the
    // apply (the transition, the reviewed-head and withheld marks, the
    // successor), across several awaits. A daemon killed in that window leaves
    // a done round with the file still in verdict/, and resuming it is the only
    // way the rest ever lands. So the replay is inert only once the apply
    // recorded that it settled (`verdict_settled`, written after the last
    // durable step); a done round without it resumes.
    if (
      round &&
      round.round_no === v.round_no &&
      round.status === "done" &&
      this.verdictSettled(v.pr, round.id)
    ) {
      store.logEvent("verdict_replay_ignored", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        head_sha: v.head_sha,
        file: name,
      });
      this.log(`verdicts: #${v.pr} round ${v.round_no} is already done — ${name} replays inertly`);
      return "applied";
    }

    if (round && !proven) {
      const proof = await this.postingProof(round, v);
      if (proof.kind === "waiting") {
        store.logEvent("verdict_waiting_posting_receipt", v.pr, {
          round_no: v.round_no,
          posting_key: round.posting_key,
        });
        return "waiting";
      }
      if (proof.kind === "skipped") {
        // Guard 2 refused the post. The verdict in this file was never
        // published and is never applied — no label, no transition from it, no
        // reviewed-head mark, no escalation. The file is archived by the caller.
        return (await this.settleGuardedNoop(round, proof.noop!, "verdict", v)) === "failed"
          ? "failed"
          : "applied";
      }
      if (proof.kind === "failed") {
        // An orphan-swept round's verdict that its posting cannot prove is
        // not applied — and opens no incident over the requeue that stands.
        if (round.status === "cancelled") {
          this.ignoreAfterCancel(round, name, {
            reason: `posting proof failed: ${proof.detail ?? "?"}`,
          });
          return "applied";
        }
        // A round ended while the proof awaited GitHub (an operator's `u`)
        // owes nothing here: the claim inside refuses it.
        return (await this.failPostingProof(
          round,
          proof.detail ?? "posting receipt invalid",
          "posting_receipt",
          "inline",
          claimedStatus === "done",
        ))
          ? "failed"
          : "applied";
      }
      // The daemon's retry delivered this round's APPROVE after the
      // session finished, and guard 4 softened it to a COMMENT on the gate.
      // The posted review withheld the approval, so the verdict does too —
      // what the session would have written had the softening happened
      // under it; the withheld mark then re-queues on green CI (cigate.ts).
      if (
        proof.kind === "confirmed" &&
        proof.receipt &&
        retrySoftenedApproval(proof.receipt) &&
        v.verdict === "APPROVE" &&
        v.approval_withheld !== true
      ) {
        v = { ...v, approval_withheld: true };
        store.logEvent("posting_retry_approval_withheld", v.pr, {
          round_no: v.round_no,
          posting_key: round.posting_key,
          gh_review_id: proof.receipt.gh_review_id ?? null,
        });
      }
      if (proof.kind === "legacy")
        store.logEvent("posting_receipt_legacy_unknown", v.pr, { round_no: v.round_no });
    }

    // Collect optional CI evidence before claiming the apply. Once the
    // lifecycle is terminal, all current-decision marks publish in one turn;
    // a later round must never be overwritten after an old network await.
    let withheldCi: string | null = null;
    if (v.head_sha && v.approval_withheld && v.verdict === "APPROVE" && adapter.listChecks) {
      try {
        withheldCi = classifyCi(await adapter.listChecks(v.head_sha));
      } catch (err) {
        this.log(`verdicts: checks read for withheld mark failed on #${v.pr}`, err);
      }
    }

    const reportLostClaim = (): void => {
      if (!round) return;
      const now = this.runningRound(v.pr, v.round_no);
      const nowStatus = now?.id === round.id ? now.status : "missing";
      store.logEvent("verdict_apply_claim_lost", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        claimed_status: claimedStatus ?? null,
        round_status: nowStatus,
        verdict: v.verdict,
        head_sha: v.head_sha,
        file: name,
        ...(proven
          ? { source: "posting_receipt", via: proven.via, gh_review_id: proven.gh_review_id }
          : {}),
      });
      this.log(
        `verdicts: #${v.pr} round ${v.round_no} went ${claimedStatus ?? "?"} → ${nowStatus} while its verdict was being applied — ${v.verdict} is not applied over it`,
      );
    };
    const ownsLabelAdmission = (): boolean =>
      !round ||
      (this.runningRound(v.pr, v.round_no)?.status === claimedStatus &&
        (claimedStatus === "running" || !store.hasLaterRound(v.pr, v.round_no)));
    const stopLostLabelApply = async (): Promise<void> => {
      if (round && claimedStatus !== "running" && store.hasLaterRound(v.pr, v.round_no)) {
        if (claimedStatus === "done")
          await this.closeMeasurement(this.settleSupersededResume(round, name), measure);
        else
          this.ignoreAfterCancel(round, name, {
            reason: "a later round started while the verdict was applied",
          });
      } else reportLostClaim();
    };
    if (!ownsLabelAdmission()) {
      await stopLostLabelApply();
      return "applied";
    }
    await this.safe(
      () => adapter.removeLabel(v.pr, cfg.github.in_progress_label),
      `remove ${cfg.github.in_progress_label} on #${v.pr}`,
    );
    if (!ownsLabelAdmission()) {
      await stopLostLabelApply();
      return "applied";
    }
    await this.safe(
      () => adapter.addLabel(v.pr, cfg.github.reviewed_label),
      `add ${cfg.github.reviewed_label} on #${v.pr}`,
    );

    // spend_usd from the file is fiction (template echo) — never stored; the
    // measured figures land via recordRoundUsage below.
    // Captured before applyEvent: the transition context writes the verdict's
    // (possibly stale) head back onto pr_state, which would mask a mid-round
    // advance (see the chain below).
    const headBeforeApply = store.getPr(v.pr)?.head_sha ?? null;
    // The claim: finished only while the round still has the status this apply
    // read before its awaits (the posting proof, the two label calls). Lost ⇒
    // whatever landed meanwhile — an operator's `u`, a supersession — stands,
    // and nothing below runs. Before the successor record, so a lost claim
    // leaves no obligation behind either.
    //
    // An orphan-swept round's claim is `cancelled`, and a resumed apply's is
    // `done` — neither of which a cancel landing meanwhile can change — but a
    // round of the PR can have started while this awaited (the requeue the
    // sweep queued, a promoted successor). Re-asked here, in the claim's own
    // turn: a later round owns the PR, and the old verdict is not applied over it.
    if (round && claimedStatus !== "running" && store.hasLaterRound(v.pr, v.round_no)) {
      if (claimedStatus === "done")
        await this.closeMeasurement(this.settleSupersededResume(round, name), measure);
      else
        this.ignoreAfterCancel(round, name, {
          reason: "a later round started while the verdict was applied",
        });
      return "applied";
    }
    if (round && !store.finishRound(round.id, v.verdict, null, v.summary ?? null, claimedStatus)) {
      reportLostClaim();
      return "applied";
    }
    if (round && v.head_sha && headBeforeApply && headBeforeApply !== v.head_sha) {
      store.recordSuccessor({
        pr: v.pr,
        predecessor_round_id: round.id,
        head_sha: headBeforeApply,
        provenance: "system",
        reason: "verdict-observed-head-advance",
      });
    }
    // Executed-pass telemetry: persist what actually ran beside the plan, and
    // flag plan≠executed. Best-effort side channel — nothing in it may disturb
    // the verdict.
    // A follow-up round's pre-approval sweep — what became of it, read from
    // the claim and the executed telemetry — before the pass
    // telemetry, which compares the sweep's passes only when it ran.
    const sweepStatus = round ? this.recordSweepTelemetry(v, round, proven !== undefined) : null;
    // The verdict's lifecycle event lands in the same turn as the claim above:
    // nothing may await between them, or a round the pump starts meanwhile
    // would be moved under its feet. The telemetry comes after.
    applyEvent(
      store,
      v.pr,
      { type: "verdict", verdict: v.verdict },
      { head_sha: v.head_sha },
      { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `verdict:${v.verdict}` },
    );
    store.logEvent("verdict_applied", v.pr, {
      file: name,
      round_id: round?.id ?? null,
      round_no: v.round_no,
      head_sha: v.head_sha,
      verdict: v.verdict,
      ai_approved: v.ai_approved ?? null,
      ...(proven
        ? {
            source: "posting_receipt",
            via: proven.via,
            gh_review_id: proven.gh_review_id,
          }
        : {}),
    });
    // The reviewed-head mark: this head has now been reviewed and decided.
    // Read by the no-new-evidence guard at dispatch and at posting time, and
    // by the post-approval delta recheck.
    if (v.head_sha) {
      const posted = store.reviewedHead(v.pr);
      if (
        posted?.head_sha.toLowerCase() === v.head_sha.toLowerCase() &&
        posted.round_no === v.round_no &&
        posted.posted_event !== null
      )
        store.recordReviewedVerdict(v.pr, v.head_sha, v.verdict);
      else
        store.recordReviewedHead(v.pr, {
          head_sha: v.head_sha,
          verdict: v.verdict,
          round_no: v.round_no,
        });
    }
    store.recoverReviewFailure(v.pr, "verdict-applied", {
      round_no: v.round_no,
      head_sha: v.head_sha,
    });
    // The withheld-approval mark, session route. The session posted
    // its review as a COMMENT because CI was not green at this head; the mark
    // is what notices when CI goes green and re-queues the PR (cigate.ts).
    // Anything else clears it: the verdict here supersedes whatever earlier
    // round withheld an approval.
    if (v.head_sha && v.approval_withheld && v.verdict === "APPROVE") {
      store.recordApprovalWithheld(v.pr, {
        head_sha: v.head_sha,
        reason: "red-ci",
        ci_state: withheldCi,
      });
      store.logEvent("approval_withheld_red_ci", v.pr, {
        head_sha: v.head_sha,
        source: proven ? "posting_receipt" : "verdict",
        ci_state: withheldCi,
      });
    } else {
      store.clearApprovalWithheld(v.pr);
    }
    if (round) await this.recordPassTelemetry(v, round, sweepStatus);
    // Slack, in-thread and never broadcast. duration_s is computed
    // inside finishRound, so it is read back off the row rather than recomputed.
    const finished = round ? store.roundsFor(v.pr).find((r) => r.id === round.id) : undefined;
    await this.announceSafe((a) =>
      a.verdict({
        pr: v.pr,
        round_no: v.round_no,
        verdict: v.verdict,
        ...(v.verdict === "APPROVE" && v.approval_withheld ? { approval_withheld: true } : {}),
        summary: finished?.summary ?? v.summary ?? null,
        duration_s: finished?.duration_s ?? null,
      }),
    );
    // A head that advanced while this round ran was recorded as a
    // durable successor obligation before terminalization. An old-head verdict
    // can never erase it; a verdict covering the owed head settles it. Queue
    // publication and obligation retention are owned by StateStore.
    if (v.head_sha && headBeforeApply && headBeforeApply !== v.head_sha) {
      store.logEvent("mid_round_head_advance", v.pr, {
        round_no: v.round_no,
        reviewed_head: v.head_sha,
        current_head: headBeforeApply,
        verdict: v.verdict,
      });
    }
    if (v.head_sha) store.settleSuccessor(v.pr, v.head_sha);
    const successorPromoted = round ? store.promoteSuccessor(v.pr) : false;
    if (successorPromoted) {
      this.log(`verdicts: #${v.pr} preserved fresh-head successor after round ${v.round_no}`);
    }
    // Every durable step of the apply has landed: from here a replay of this
    // file is inert (the done-round guard above reads this).
    //
    // The round's usage window closed at its claim (`finished_at`), and its
    // measurement is owed from here — in the same synchronous turn as
    // `verdict_settled`. Both writes share one SQLite transaction. Its reads (async — seconds, at most the usage
    // budget) run at the very end of the apply, after the compaction request
    // and the held-wake flush: a round dispatched while they run must never
    // receive this round's held wakes (rule 9), and nothing in between reads
    // the tokens. A restart while they run leaves the row owed, and the next
    // start measures it.
    let owed: OwedMeasurement | undefined;
    if (round) {
      // Debt and replay suppression share a commit. A persistence failure
      // leaves the done apply eligible for replay, never silently unmeasured.
      owed = store.db.transaction(() => {
        const measurement = this.oweMeasurement(round, finished?.finished_at);
        this.enqueueTail(
          v.pr,
          v.round_no,
          round.id,
          v.head_sha,
          tailPlannedLenses(round, sweepStatus),
        );
        if (cfg.escalation.enabled)
          enqueueRoundWork(store, {
            key: `escalations:${round.id}`,
            kind: "escalations",
            pr: v.pr,
            round_no: v.round_no,
            payload: v,
            due_at: this.now().toISOString(),
          });
        store.logEvent("verdict_settled", v.pr, { round_id: round.id, round_no: v.round_no });
        return measurement;
      })();
    }
    // Escalation — off unless the operator switched it on, and it runs here,
    // after the verdict has been applied, the label moved and the
    // PR transitioned. That ordering is the invariant, not a convenience: an
    // escalation is additive notification beside a decided review, so it can
    // neither withhold, defer nor replace one. `deliverEscalations` returns a
    // delivery record and nothing else — there is no channel back into the
    // verdict — and the whole call is wrapped, so even a throw lands as a log
    // line on an already-applied verdict.
    if (round && cfg.escalation.enabled) await this.runRoundWorkKey(`escalations:${round.id}`);
    else await this.safe(() => this.deliverEscalations(v), `escalations pr-${v.pr}`);
    // Round is over: compact the sticky conversation. Cache re-reads of the
    // ever-growing prefix are a large share of measured cost; the continuity
    // that matters (SETTLED digest, ledger) survives compaction by design:
    // ledger-pin pins the ledger into pi's summary and the next round order
    // re-hands the mirrored copy. This only requests it — the session's
    // inject bridge runs it once nothing is in flight and delivers
    // no wake (the ones flushed below included) until it has ended, so a
    // compaction can neither abort a wake nor refuse one.
    await this.safe(
      () => this.deps.hooks.compactSession?.(v.pr) ?? Promise.resolve(),
      `compact pr-${v.pr}`,
    );
    // Ledger freshness: after compaction, so ledger-pin's mirror has had its
    // chance — and delayed, because the compaction is only requested: it is
    // still running when apply continues. Best-effort fire-and-forget —
    // nothing here may disturb the verdict.
    //
    // The reasoning-record check rides the same settle window, for the same
    // reason: it may nudge. It runs after the ledger check and is likewise
    // fire-and-forget — by the time either runs the verdict is applied, the
    // round row is finished and the PR has transitioned, so a record that
    // never arrives costs one anomaly row and one nudge and cannot hold the
    // round open.
    await this.scheduleRoundTail(
      v.pr,
      v.round_no,
      round?.id ?? null,
      v.head_sha,
      round ? tailPlannedLenses(round, sweepStatus) : "",
    );
    // The round is over. Fresh-head review work wins the session command slot;
    // held conversational wakes stay behind it and flush at the successor's
    // terminal path. Without a successor, ordinary FIFO wake delivery resumes.
    if (!successorPromoted) await this.flushWakes(v.pr);
    if (owed) await this.closeMeasurement(owed, measure);
    this.log(`verdicts: #${v.pr} round ${v.round_no} → ${v.verdict}`);
    return "applied";
  }

  /** The round-end ledger and findings-record checks, after the settle
   * delay — shared by a verdict and a receipt settlement. */
  private enqueueTail(
    pr: number,
    roundNo: number,
    roundId: number | null,
    headSha: string,
    lenses: string,
  ): string {
    const key = `tail:${roundId ?? `${pr}:${roundNo}`}`;
    enqueueRoundWork(this.deps.store, {
      key,
      kind: "tail",
      pr,
      round_no: roundNo,
      payload: { roundId, headSha, lenses },
      due_at: new Date(
        this.now().getTime() + Math.max(0, this.deps.ledgerCheckDelayMs ?? 90_000),
      ).toISOString(),
    });
    return key;
  }

  private async scheduleRoundTail(
    pr: number,
    roundNo: number,
    roundId: number | null,
    headSha: string,
    lenses: string,
  ): Promise<void> {
    const key = this.enqueueTail(pr, roundNo, roundId, headSha, lenses);
    const delay = this.deps.ledgerCheckDelayMs ?? 90_000;
    if (delay <= 0) await this.runRoundWorkKey(key);
    else {
      const timer = setTimeout(() => {
        this.detach(() => this.runRoundWorkKey(key), `round tail ${key}`);
      }, delay);
      timer.unref?.();
    }
  }

  private async runRoundWorkKey(key: string): Promise<void> {
    for (const kind of ["tail", "escalations"] as const) {
      const work = pendingRoundWork(this.deps.store, kind, this.now().toISOString()).find(
        (row) => row.key === key,
      );
      if (work) await this.runRoundWork(work);
    }
  }

  private async runRoundWork(work: RoundWork): Promise<void> {
    if (this.working.has(work.key)) return;
    this.working.add(work.key);
    try {
      if (work.kind === "tail") {
        const payload = JSON.parse(work.payload) as {
          roundId: number | null;
          headSha: string;
          lenses: string;
        };
        await this.checkLedger(work.pr, work.round_no, payload.headSha);
        await this.checkFindingsRecord(
          work.pr,
          work.round_no,
          payload.roundId,
          payload.headSha,
          payload.lenses.split(",").filter(Boolean),
        );
      } else {
        const parsed = validateVerdict(JSON.parse(work.payload));
        if (!parsed.ok || !parsed.verdict || parsed.verdict.outcome === "head_moved")
          throw new Error(`unreadable escalation intent ${work.key}`);
        await this.deliverEscalations(parsed.verdict);
      }
      finishRoundWork(this.deps.store, work.key, this.now().toISOString());
    } catch (err) {
      this.log(`verdicts: owed ${work.kind} for #${work.pr} round ${work.round_no} failed`, err);
    } finally {
      this.working.delete(work.key);
    }
  }

  private resumeRoundWork(): void {
    for (const kind of ["tail", "escalations"] as const)
      for (const work of pendingRoundWork(this.deps.store, kind, this.now().toISOString()))
        this.detach(() => this.runRoundWork(work), `owed ${kind} ${work.key}`);
  }

  // ---- escalation (off by default) ---------------------------------------

  /**
   * Assemble the round's facts, evaluate the operator's deterministic rules,
   * add whatever the session asked for, and hand the lot to the one delivery
   * path.
   *
   * Everything here is a no-op when `[escalation] enabled = false`: the first
   * line returns before a single fact is read, so a default install makes no
   * extra API call, writes no row and logs no event.
   */
  private escalationDeliveryDeps(): EscalationDeps | null {
    const { adapter, store, cfg } = this.deps;
    if (!cfg.escalation.enabled || !adapter.createReview) return null;
    const bot = cfg.github.bot_login.toLowerCase();
    return {
      cfg: cfg.escalation,
      store,
      dryRun: cfg.dry_run,
      isDraining: () => this.stopped,
      adapter: {
        createReview: adapter.createReview.bind(adapter),
        ...(adapter.requestEscalationReview
          ? { requestEscalationReview: adapter.requestEscalationReview.bind(adapter) }
          : {}),
        ...(adapter.listReviewsFull
          ? {
              findEscalationComment: async (
                pr: number,
                head: string,
                marker: string,
                body: string,
              ) => {
                const reviews = await adapter.listReviewsFull!(pr);
                const found = reviews.find(
                  (review) =>
                    review.user.toLowerCase() === bot &&
                    review.commit_id.toLowerCase() === head.toLowerCase() &&
                    review.state === "COMMENTED" &&
                    typeof review.submitted_at === "string" &&
                    review.submitted_at.length > 0 &&
                    Number.isSafeInteger(review.id) &&
                    review.id > 0 &&
                    review.body === body &&
                    review.body.split(/\r?\n/).includes(marker),
                );
                return found ? { id: found.id } : null;
              },
            }
          : {}),
      },
      log: this.log.bind(this),
    };
  }

  /** Optional recovery never holds a fresh verdict behind a GitHub read. */
  private resumeEscalationDeliveries(): void {
    if (this.stopped || this.escalationRecoveryInFlight) return;
    const deps = this.escalationDeliveryDeps();
    if (!deps || deps.dryRun) return;
    this.escalationRecoveryInFlight = true;
    this.detach(async () => {
      try {
        await resumeEscalations(deps);
      } finally {
        this.escalationRecoveryInFlight = false;
      }
    }, "escalation delivery recovery");
  }

  private async deliverEscalations(v: MeritsVerdictFile): Promise<void> {
    const cfg = this.deps.cfg.escalation;
    if (!cfg.enabled) return;
    const { store, adapter } = this.deps;
    if (!adapter.createReview) return; // no gated posting route ⇒ nothing to deliver through

    // --- the facts. Every read is best-effort: a fact we cannot see means
    // the rules keyed on it do not fire, never that the round is disturbed.
    const facts: EscalationFacts = {
      changed_paths: await this.escalationPaths(v.pr),
      labels: await this.escalationLabels(v.pr),
      findings: this.escalationFindings(
        v.pr,
        v.round_no,
        cfg.rules.some((r) => r.min_severity !== ""),
      ),
      failing_checks: await this.escalationFailingChecks(v.pr, v.head_sha),
    };

    // The two groups stay separate because they have different trust: the
    // first is the operator's configured rules, the second is whatever the
    // model wrote in its verdict file. Flattening them into one list and
    // re-deriving trust from a field inside the payload would let a session
    // relabel itself `origin: "rule"`.
    //
    // A rule that fired but produced nothing deliverable is logged, never
    // silent: the operator configured it, it matched, and they would otherwise
    // have no way to see why nobody was told.
    const ruleRequests = evaluateEscalationRules(cfg, facts, (rule, refusal) => {
      store.logEvent("escalation_rule_refused", v.pr, {
        rule: rule.name,
        to: rule.to,
        refusal,
        round_no: v.round_no,
      });
      this.log(
        `escalation: rule "${rule.name}" fired on #${v.pr} but produced nothing — ${refusal}`,
      );
    });
    const sessionCandidates = cfg.session_judgement ? (v.escalations ?? []) : [];
    if (ruleRequests.length === 0 && sessionCandidates.length === 0) return;
    await deliverEscalations(this.escalationDeliveryDeps()!, {
      pr: v.pr,
      verdict: v.verdict,
      head_sha: v.head_sha,
      round_no: v.round_no,
      // The path-in-diff check's input. An unreadable
      // listing is `[]`, which refuses every path-bearing scope rather than
      // waving it through — the safe direction, same as every other fact.
      changed_paths: facts.changed_paths,
      // Whether the round's own review actually reached GitHub, from the
      // posting receipt: the note must not claim a posting no confirmed
      // receipt shows (a dry run, a legacy round, a review the marker
      // reconcile proved without a local receipt). A guard-2 refusal never
      // gets here — it settles as a guarded no-op, with no escalation.
      review_posted: this.roundReviewConfirmed(v.pr, v.round_no, v.head_sha),
      ruleRequests,
      sessionCandidates,
    });
  }

  /**
   * Did the round's own review confirm as posted (posting receipt)? Read-only,
   * total: an unreadable or absent receipt is `false`, and the note then says
   * "decided" without claiming "posted".
   */
  private roundReviewConfirmed(pr: number, roundNo: number, headSha: string): boolean {
    try {
      const receipt = readPostingReceipt(this.postingReceiptDir(), pr, roundNo);
      if (!receipt || receipt.pr !== pr || receipt.round_no !== roundNo) return false;
      if (receipt.head_sha.toLowerCase() !== headSha.toLowerCase()) return false;
      return receipt.status === "confirmed";
    } catch {
      return false;
    }
  }

  private async escalationPaths(pr: number): Promise<string[]> {
    if (!this.deps.adapter.listPrFiles) return [];
    try {
      return (await this.deps.adapter.listPrFiles(pr)).map((f) => f.filename).filter(Boolean);
    } catch (err) {
      this.log(`escalation: file listing failed on #${pr}`, err);
      return [];
    }
  }

  private async escalationLabels(pr: number): Promise<string[]> {
    if (!this.deps.adapter.getPr) return [];
    try {
      return (await this.deps.adapter.getPr(pr)).labels ?? [];
    } catch (err) {
      this.log(`escalation: PR read failed on #${pr}`, err);
      return [];
    }
  }

  /**
   * The findings the round posted, from the reasoning record. Absent or
   * unreadable ⇒ severity-keyed rules simply do not fire.
   *
   * That silence is logged when it matters: a `needed`
   * caller — one whose config actually has a `min_severity` rule — gets an
   * `escalation_findings_unavailable` event, so a severity rule that never
   * fires is visible in the event log instead of being invisible. Without a
   * severity rule the record is not consulted for anything and the absence is
   * not worth a line.
   */
  private escalationFindings(
    pr: number,
    roundNo: number,
    needed: boolean,
  ): Array<{ severity: string; path?: string | null; title?: string | null }> {
    const dir = this.deps.findingsDir;
    if (!dir) {
      if (needed) {
        this.deps.store.logEvent("escalation_findings_unavailable", pr, {
          round_no: roundNo,
          reason: "no findings dir configured",
        });
      }
      return [];
    }
    const parsed = readFindingsRecord(findingsRecordPath(dir, pr, roundNo), pr, roundNo);
    if (!parsed.record) {
      if (needed) {
        this.log(
          `escalation: no reasoning record for #${pr} round ${roundNo} — severity rules cannot fire`,
        );
        this.deps.store.logEvent("escalation_findings_unavailable", pr, {
          round_no: roundNo,
          reason: parsed.status,
        });
      }
      return [];
    }
    return parsed.record.findings
      .filter((f) => f.disposition === "posted" && f.severity)
      .map((f) => ({ severity: String(f.severity), path: f.path, title: f.reason }));
  }

  /** Check names whose latest run at the head is not a success — the same
   * latest-run-per-name rule the CI gate uses, so an auto-cancelled
   * superseded run cannot escalate to a person forever. */
  private async escalationFailingChecks(pr: number, head: string): Promise<string[]> {
    if (!this.deps.adapter.listChecks || !head) return [];
    try {
      return latestRunPerName(await this.deps.adapter.listChecks(head))
        .filter((c) => checkOutcome(c) === "failed")
        .map((c) => c.name);
    } catch (err) {
      this.log(`escalation: checks read failed on #${pr}`, err);
      return [];
    }
  }

  // ---- ledger freshness ------------------------------------------------

  private ledgerPathFor(pr: number): string {
    const custom = this.deps.ledgerPathFor;
    if (custom) return custom(pr);
    const root = this.deps.root ?? sandboxRoot();
    return join(root, "state", "ledgers", `pr-${pr}.md`);
  }

  /** Enforce the end-of-round ledger rewrite: header must read
   * `LEDGER PR #<n> @ <head>`. Stale ⇒ anomaly + one capped re-nudge. */
  private async checkLedger(pr: number, roundNo: number, headSha: string): Promise<void> {
    if (!headSha) return;
    await enforceLedgerFreshness(
      {
        store: this.deps.store,
        ledgerPathFor: (n) => this.ledgerPathFor(n),
        inject: (n, message) => this.deps.hooks.inject(n, message),
        log: this.log.bind(this),
      },
      { pr, roundNo, headSha },
    );
  }

  // ---- the durable reasoning record ------------------------------------

  /** Parse `state/findings/pr-<n>-round-<k>.json` into rows. Missing or
   * unparseable ⇒ anomaly + exactly one re-nudge, never a held-open round. */
  private async checkFindingsRecord(
    pr: number,
    roundNo: number,
    roundId: number | null,
    headSha: string,
    planned: readonly string[],
  ): Promise<void> {
    const findingsDir = this.deps.findingsDir;
    if (!findingsDir) return;
    await enforceFindingsRecord(
      {
        store: this.deps.store,
        findingsDir,
        inject: (n, message) => this.deps.hooks.inject(n, message),
        log: this.log.bind(this),
        ...(this.deps.onFindingsRecorded ? { onRecorded: this.deps.onFindingsRecorded } : {}),
      },
      { pr, roundNo, roundId, headSha, planned },
    );
  }

  // ---- follow-up sweep telemetry ---------------------------------------

  /**
   * Record what became of a follow-up round's pre-approval sweep
   * (`rounds.sweep_status`) and return it; null on a round that is not a
   * follow-up (nothing written). `ran` needs both the session's claim and
   * sweep-phase passes in its executed telemetry — a claim with no telemetry
   * behind it is `unknown`, as is a verdict settled from the posting receipt
   * (no telemetry at all): an unknown sweep never counts as a full look, so
   * the next round owes it again. An idempotent overwrite after the
   * `finishRound` claim, like the pass telemetry, so a resumed apply redoes
   * it. An APPROVE with the sweep owed and not run is the quiet
   * `followup_sweep_skipped` anomaly — the review is already on GitHub, so
   * this is telemetry, never a veto. Wrapped: nothing here may disturb the
   * verdict.
   */
  private recordSweepTelemetry(
    v: VerdictFile,
    round: RoundRow,
    receiptSettled: boolean,
  ): SweepStatus | null {
    const { store } = this.deps;
    try {
      if (round.scope !== "delta" || round.sweep_owed === null) return null;
      const owed = round.sweep_owed === 1;
      const claim = v.sweep ?? null;
      const sweepPasses = v.passes ? v.passes.filter((p) => p.phase === "sweep").length : null;
      const { status, note } = sweepStatusOf({
        owed,
        claim,
        sweepPasses,
        receiptSettled,
        verdict: v.verdict,
      });
      store.setRoundMeta(round.id, { sweep_status: status });
      store.logEvent("followup_sweep_recorded", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        owed,
        claimed: claim,
        sweep_passes: sweepPasses,
        status,
        ...(note ? { note } : {}),
        ...(v.sweep_reason ? { reason: v.sweep_reason.slice(0, 500) } : {}),
      });
      if (note) this.log(`verdicts: #${v.pr} round ${v.round_no} sweep ${status}: ${note}`);
      // What the session did with the optional rows, and why.
      if (v.extent !== undefined)
        store.logEvent("followup_extent_decided", v.pr, {
          round_id: round.id,
          round_no: v.round_no,
          extent: v.extent,
          ...(v.extent_reason ? { reason: v.extent_reason.slice(0, 500) } : {}),
        });
      // A sweep the session decided to skip is a decision, not an anomaly:
      // only an owed sweep left un-run without one is.
      if (sweepSkippedOnApprove(v.verdict, owed, status)) {
        store.logAnomaly(
          "followup_sweep_skipped",
          v.pr,
          v.round_no,
          `APPROVE with the pre-approval sweep owed and ${status}` +
            `${claim ? ` (claimed ${claim})` : " (no claim)"}` +
            `${sweepPasses === null ? "; executed passes unknown" : `; ${sweepPasses} sweep-phase passes`}`,
        );
      }
      return status;
    } catch (err) {
      this.log(`verdicts: sweep telemetry failed for #${v.pr}`, err);
      return null;
    }
  }

  // ---- executed-pass telemetry -----------------------------------------

  /**
   * Persist the verdict's executed-pass report and compare it with the plan
   * (`rounds.lenses`). Missing telemetry ⇒ logged as unknown; plan≠executed ⇒
   * logged anomaly + overseer inject. Never blocks the verdict — everything
   * here is wrapped, and the verdict was already applied by the caller.
   */
  private async recordPassTelemetry(
    v: VerdictFile,
    round: RoundRow,
    sweepStatus: SweepStatus | null = null,
  ): Promise<void> {
    const { store } = this.deps;
    try {
      if (!v.passes) {
        // The session reported nothing usable: the record stays NULL =
        // unknown, distinct from [] = "ran zero passes".
        store.logEvent("verdict_passes_unknown", v.pr, {
          round_id: round.id,
          round_no: v.round_no,
        });
        this.log(
          `verdicts: #${v.pr} round ${v.round_no} executed passes unknown (no telemetry in verdict)`,
        );
        return;
      }
      store.recordExecutedPasses(round.id, v.passes);
      const executed = v.passes.map((p) => p.name);
      const legacyPlanned = round.lenses ? round.lenses.split(",").filter(Boolean) : [];
      const plan = round.pass_plan ? (JSON.parse(round.pass_plan) as PlanRow[]) : null;
      const addable = round.addable_passes
        ? (JSON.parse(round.addable_passes) as RecordedAddablePass[])
        : null;
      // A follow-up round runs two stages. The delta stage's passes (phase
      // "delta", or none) answer to `pass_plan`; the sweep's (phase "sweep")
      // to `sweep_plan` — and a sweep lens is missing only when the sweep ran,
      // so a round that decided before the sweep raises nothing. Every other
      // round compares every pass against its plan.
      const followUp = round.scope === "delta";
      const deltaPasses = followUp ? v.passes.filter((p) => p.phase !== "sweep") : v.passes;
      const sweepPasses = followUp ? v.passes.filter((p) => p.phase === "sweep") : [];
      const main = comparePlan(deltaPasses, plan, addable, legacyPlanned, true);
      let sweep: PlanComparison | null = null;
      if (sweepPasses.length > 0 || sweepStatus === "ran") {
        const sweepPlan = round.sweep_plan ? (JSON.parse(round.sweep_plan) as PlanRow[]) : [];
        // What the sweep may add: the round's addable set and the delta's own
        // plan rows, minus what the sweep already plans.
        const inSweep = new Set(sweepPlan.map((p) => p.lens));
        const sweepAddable = [
          ...(addable ?? []),
          ...(plan ?? []).map((p) => ({ lens: p.lens, tier: p.tier })),
        ].filter((p) => !inSweep.has(p.lens));
        sweep = comparePlan(sweepPasses, sweepPlan, sweepAddable, [], sweepStatus === "ran");
      }
      const tag = (names: string[]): string[] => names.map((n) => `sweep:${n}`);
      const planned = main.planned;
      const missing = [...main.missing, ...tag(sweep?.missing ?? [])];
      const unknownAdditions = [...main.unknownAdditions, ...tag(sweep?.unknownAdditions ?? [])];
      const missingReason = [...main.missingReason, ...tag(sweep?.missingReason ?? [])];
      const wrongTier = [...main.wrongTier, ...tag(sweep?.wrongTier ?? [])];
      const allowedAdditions = [
        ...main.allowedAdditions,
        ...(sweep?.allowedAdditions ?? []).map((a) => ({ ...a, name: `sweep:${a.name}` })),
      ];

      if (allowedAdditions.length > 0) {
        store.logEvent("pass_plan_conformant_addition", v.pr, {
          round_id: round.id,
          round_no: v.round_no,
          additions: allowedAdditions,
        });
      }
      const violations =
        missing.length + unknownAdditions.length + missingReason.length + wrongTier.length;
      if (violations === 0) return;
      store.logEvent("pass_plan_mismatch", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        planned,
        executed,
        missing,
        added: unknownAdditions,
        unknown_additions: unknownAdditions,
        missing_reason: missingReason,
        wrong_tier: wrongTier,
        allowed_additions: allowedAdditions,
        ...(sweep ? { sweep_planned: sweep.planned, sweep_status: sweepStatus } : {}),
      });
      this.log(`verdicts: #${v.pr} round ${v.round_no} pass plan mismatch`, {
        planned,
        executed,
        missing,
        unknownAdditions,
        missingReason,
        wrongTier,
      });
      store.logAnomaly(
        "pass_plan_mismatch",
        v.pr,
        v.round_no,
        `pass policy violated` +
          `${missing.length ? `; missing ${missing.join(",")}` : ""}` +
          `${unknownAdditions.length ? `; unknown ${unknownAdditions.join(",")}` : ""}` +
          `${missingReason.length ? `; no reason ${missingReason.join(",")}` : ""}` +
          `${wrongTier.length ? `; wrong tier ${wrongTier.join(",")}` : ""}`,
        [
          `PASS-PLAN MISMATCH — PR #${v.pr} round ${v.round_no}`,
          `Planned: ${planned.join(", ") || "(none)"}`,
          ...(sweep
            ? [
                `Pre-approval sweep (${sweepStatus ?? "unknown"}): ${sweep.planned.join(", ") || "(none planned)"}`,
              ]
            : []),
          `Executed: ${executed.join(", ") || "(none — solo/degraded round)"}`,
          ...(missing.length ? [`Missing planned passes: ${missing.join(", ")}`] : []),
          ...(unknownAdditions.length
            ? [`Not in the dispatched addable set: ${unknownAdditions.join(", ")}`]
            : []),
          ...(missingReason.length
            ? [`Allowed additions missing structured reason: ${missingReason.join(", ")}`]
            : []),
          ...(wrongTier.length ? [`Passes at a non-authorized tier: ${wrongTier.join(", ")}`] : []),
          "The verdict stands — this is telemetry, not a veto.",
        ].join("\n"),
      );
    } catch (err) {
      this.log(`verdicts: pass telemetry failed for #${v.pr}`, err);
    }
  }

  // ---- measured usage --------------------------------------------------

  private sessionDirFor(pr: number): string {
    const custom = this.deps.usage?.sessionDirFor;
    if (custom) return custom(pr);
    const root = this.deps.root ?? sandboxRoot();
    return join(root, this.deps.cfg.pi.session_dir, `pr-${pr}`);
  }

  private globalStoreDir(): string | undefined {
    const configured = this.deps.usage?.globalStoreDir;
    if (configured === null) return undefined;
    // The subagent tool's isolated children skip --session-dir → pi HOME
    // global store (in-container /home/review/.pi/agent/sessions). Best-effort.
    return configured ?? piGlobalSessionsDir();
  }

  /**
   * Did git's configuration change while this round ran? And did this
   * system's own policy surface (config.toml, scripts/, dist/, extensions/,
   * the seeds)?
   *
   * The write veto in the bash guard reads command strings, and five write
   * primitives on the guard's own read-only allowlist go straight past it —
   * `T=.git/config; cat p >> $T` can never be seen by a token scan, because
   * the target is a variable. This check does not look at commands at all: the
   * fingerprint was taken when `dispatch` prepared the worktree, and any
   * difference now is a write the daemon did not make. The two families raise
   * different anomalies, because they mean different things: a git change
   * taints this round; a policy change rewrites the boundary every later round
   * in the container runs under.
   *
   * Runs inside `measureUsage`, which is deliberately the one place that fires
   * on both the verdict path and the anomaly/overdue path — a round that ends
   * badly is exactly when this most wants checking.
   *
   * Never throws and never fails a round: an unavailable fingerprint at either
   * end leaves the round unchecked, and a NULL baseline is never read as
   * "changed" (unknown is not evidence of loss). The re-hash is async with a
   * loop turn after every file — it walks dist/, scripts/ and the
   * rest of the policy surface — and bounded by `integrityBudgetMs`: a read
   * that never returns leaves the round unchecked (`round_integrity_unchecked`),
   * never a round end that does not finish.
   */
  private async checkRoundIntegrity(pr: number, roundId: number): Promise<void> {
    const { cfg, store } = this.deps;
    try {
      const before = this.integrityBaseline(roundId);
      if (!before) return; // no baseline — never judged
      const root = this.deps.root ?? sandboxRoot();
      const budgetMs = Math.max(0, this.deps.integrityBudgetMs ?? INTEGRITY_BUDGET_MS);
      const rehash = await withinBudget(
        (this.deps.integrityFingerprint ?? fingerprintRoundIntegrity)(
          roundIntegrityOpts(githubCloneDir(cfg.github), root, prWorktreeRel(pr)),
        ),
        budgetMs,
      );
      if (rehash.kind === "budget") {
        // Unchecked, never "unchanged": the baseline stays, nothing is judged.
        store.logEvent("round_integrity_unchecked", pr, {
          round_id: roundId,
          stage: "round_end",
          reason: "budget",
          budget_ms: budgetMs,
        });
        this.log(
          `verdicts: #${pr} round integrity UNCHECKED — the re-hash did not finish within ${budgetMs} ms`,
        );
        return;
      }
      const after = rehash.value;
      const { git, policy } = splitIntegrityChanges(integrityChanges(before, after), root);
      if (git.length > 0) {
        store.logEvent("git_config_modified", pr, { round_id: roundId, changes: git });
        const message = gitConfigChangeMessage(pr, git);
        store.logAnomaly("git_config_modified", pr, null, message, message);
        this.log(`verdicts: #${pr} GIT CONFIG CHANGED DURING THE ROUND`, git);
      }
      if (policy.length > 0) {
        store.logEvent("policy_surface_modified", pr, { round_id: roundId, changes: policy });
        const message = policySurfaceChangeMessage(pr, policy);
        store.logAnomaly("policy_surface_modified", pr, null, message, message);
        this.log(`verdicts: #${pr} POLICY SURFACE CHANGED DURING THE ROUND`, policy);
      }
    } catch (err) {
      this.log(`verdicts: #${pr} round integrity check unavailable`, err);
    }
  }

  /** Measure real token usage for the round window from the pi session JSONLs,
   * estimate USD from config pricing, and store both. Also the post-hoc
   * exec-policy audit. Best-effort: no failure here disturbs the verdict.
   *
   * The transcripts are read once, async and chunked, through the watcher's
   * `TranscriptIndex` (each file resumed from where the last round end left
   * it; a session file older than the round not read at all), and the
   * integrity re-hash is async too, so neither stalls the event loop. An
   * in-scope transcript that cannot be read, or a read past `budgetMs`,
   * leaves the usage unknown
   * (nothing recorded — the columns stay NULL, never a partial sum) with a
   * `round_usage_unknown` event, and the audit reports what it did read. */
  private async measureUsage(
    pr: number,
    roundId: number,
    startedAt: string,
    finishedAt: string,
    integrity: "check" | "interrupted" = "check",
  ): Promise<boolean> {
    const { cfg, store } = this.deps;
    let persisted = false;
    try {
      const bounded = await withinBudget(
        this.transcripts.measure({
          sessionDir: this.sessionDirFor(pr),
          globalStoreDir: this.globalStoreDir(),
          startedAt,
          finishedAt,
        }),
        this.usageBudgetMs(),
      );
      const measured = bounded.kind === "done" ? bounded.value : "budget";
      const usage = measured === "budget" ? null : measured.usage;
      if (usage !== null) {
        // pi's own per-record usage.cost.total is the primary source (verified
        // live on the VM); the config price table is only the fallback for
        // windows whose records carried no cost object.
        const pricing: Record<string, ModelPricing> =
          this.deps.usage?.pricing ?? cfg.models.pricing ?? {};
        const est = usage.cost_usd ?? estimateUsd(usage.models, pricing);
        store.recordRoundUsage(roundId, {
          tokens_in: usage.tokens_in,
          tokens_out: usage.tokens_out,
          tokens_cache_read: usage.tokens_cache_read,
          est_usd: est,
        });
        this.log(
          `verdicts: #${pr} round usage ${usage.tokens_in}in/${usage.tokens_out}out/${usage.tokens_cache_read}cache` +
            ` est=${est === null ? "unpriced" : `$${est.toFixed(2)}`}${usage.passes_included ? " (+passes)" : ""}${usage.children_included ? " (+children)" : ""}`,
        );
      } else if (measured === "budget") {
        store.logEvent("round_usage_unknown", pr, {
          round_id: roundId,
          reason: "budget",
          budget_ms: this.usageBudgetMs(),
          audit: "incomplete",
        });
        this.log(
          `verdicts: #${pr} round usage UNKNOWN — the transcripts were not read within ${this.usageBudgetMs()} ms; nothing recorded, the exec-policy audit did not run`,
        );
      } else {
        store.logEvent("round_usage_unknown", pr, {
          round_id: roundId,
          reason: "unreadable",
          unreadable: measured.unreadable.slice(0, UNREADABLE_LISTED),
          unreadable_count: measured.unreadable.length,
          audit: "incomplete",
        });
        this.log(
          `verdicts: #${pr} round usage UNKNOWN — ${measured.unreadable.length} transcript path(s) unreadable; nothing recorded, the exec-policy audit covers only what was read`,
          measured.unreadable.slice(0, UNREADABLE_LISTED),
        );
      }

      persisted = true;
      // Classified, so the durable event says which policy was crossed.
      if (integrity === "check") await this.checkRoundIntegrity(pr, roundId);
      else this.integrityInterrupted(pr, roundId);

      const violations = measured === "budget" ? [] : measured.violations;
      if (violations.length > 0) {
        const commands = violations.map((v) => v.command);
        store.logEvent("exec_policy_violation", pr, { commands, violations });
        this.execViolations.set(
          pr,
          violations.map((v) => `${v.kind}: ${v.command}`),
        );
        this.log(`verdicts: #${pr} exec-policy violations`, violations);
      }
    } catch (err) {
      this.log(`verdicts: usage measurement failed for #${pr}`, err);
    }
    return persisted;
  }

  /**
   * A round end fixes its usage window and owes the measurement. The reads
   * can take minutes, and a deploy's drain sees `running_rounds == 0` the
   * moment the round row is terminal, so the obligation must be durable: a
   * restart mid-read would otherwise leave NULL tokens with no
   * `round_usage_unknown`, reading as "never measured" rather than "unknown".
   * `rounds.usage_owed_to` carries the window's end from the same synchronous
   * turn as the round end's terminal write until the measurement has
   * finished, whatever it found, and the next start resumes what is still owed
   * (`resumeOwedMeasurements`). The durable write must succeed before a
   * terminal replay marker is published; a failure leaves apply replayable.
   */
  private oweMeasurement(
    round: Pick<RoundRow, "id" | "pr" | "round_no" | "started_at">,
    /** The window's end when it is not now: the round's terminal write
     * landed turns earlier (a verdict's apply stamps `finished_at` at its
     * claim and owes the measurement only once every durable step landed). */
    endedAt?: string | null,
  ): OwedMeasurement {
    const measuredTo = endedAt ?? this.now().toISOString();
    this.deps.store.oweRoundMeasurement(round.id, measuredTo);
    this.measuring.add(round.id);
    return {
      pr: round.pr,
      roundId: round.id,
      roundNo: round.round_no,
      startedAt: round.started_at,
      measuredTo,
    };
  }

  /** Run an owed measurement now (`inline`) or hand it to the background. */
  private async closeMeasurement(owed: OwedMeasurement, mode: MeasureMode): Promise<void> {
    if (mode === "background") {
      this.detach(
        () => this.runMeasurement(owed, "check"),
        `measurement of #${owed.pr} round ${owed.roundNo}`,
      );
      return;
    }
    await this.runMeasurement(owed, "check");
  }

  /** The measurement, then the obligation cleared — whatever it found
   * (`measureUsage` explicitly reports that usage or unknown was persisted). */
  private async runMeasurement(
    owed: OwedMeasurement,
    integrity: "check" | "interrupted",
  ): Promise<void> {
    try {
      const persisted = await this.measureUsage(
        owed.pr,
        owed.roundId,
        owed.startedAt,
        owed.measuredTo,
        integrity,
      );
      if (persisted) this.deps.store.settleRoundMeasurement(owed.roundId);
    } catch (err) {
      this.log(
        `verdicts: #${owed.pr} round ${owed.roundNo} — could not settle its owed measurement`,
        err,
      );
    } finally {
      this.measuring.delete(owed.roundId);
    }
  }

  private detach(fn: () => Promise<void>, what: string): void {
    const job: Promise<void> = fn()
      .catch((err: unknown) => this.log(`verdicts: ${what} failed`, err))
      .finally(() => this.background.delete(job));
    this.background.add(job);
  }

  /**
   * Measurements an earlier process owed and did not finish — a restart,
   * usually a deploy, cut them short. Once
   * per watcher, from its first sweep; this process's own are in `measuring`.
   *
   * Each is measured again over its stored window, in the background: the
   * transcripts are append-only and the window's end is fixed, so the answer
   * is the one the interrupted read would have given. The integrity re-check
   * is not re-run — a deploy rewrites dist/ and scripts/, the policy surface,
   * so a re-hash after one would blame the round for the deploy; the round is
   * recorded unchecked (`round_integrity_unchecked`, `interrupted`) instead.
   * A window older than `OWED_MEASUREMENT_RESUME_MAX_MS` is not re-read at
   * all — the pi-global archiver may have moved its store files since, and a
   * partial sum must never read as the round's cost — so its usage, if it was
   * not recorded before the restart, is recorded unknown.
   */
  private resumeOwedMeasurements(): void {
    if (this.owedResumed) return;
    const { store } = this.deps;
    const owed = store.owedRoundMeasurements();
    this.owedResumed = true;
    for (const round of owed) {
      try {
        this.resumeOwedMeasurement(round);
      } catch (err) {
        this.log(
          `verdicts: resuming #${round.pr} round ${round.round_no}'s measurement failed`,
          err,
        );
      }
    }
  }

  private resumeOwedMeasurement(round: RoundRow): void {
    const { store } = this.deps;
    if (round.usage_owed_to === null || this.measuring.has(round.id)) return;
    const job: OwedMeasurement = {
      pr: round.pr,
      roundId: round.id,
      roundNo: round.round_no,
      startedAt: round.started_at,
      measuredTo: round.usage_owed_to,
    };
    const age = this.now().getTime() - Date.parse(job.measuredTo);
    if (!Number.isFinite(age) || age > OWED_MEASUREMENT_RESUME_MAX_MS) {
      if (round.tokens_in === null) {
        store.logEvent("round_usage_unknown", round.pr, {
          round_id: round.id,
          reason: "interrupted",
          measured_to: job.measuredTo,
          audit: "incomplete",
        });
      }
      this.integrityInterrupted(round.pr, round.id);
      store.settleRoundMeasurement(round.id);
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} — its measurement was cut short by a restart and its window (to ${job.measuredTo}) is too old to re-read; ${round.tokens_in === null ? "usage UNKNOWN" : "usage as recorded"}, audit incomplete`,
      );
      return;
    }
    this.measuring.add(round.id);
    store.logEvent("round_usage_resumed", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      started_at: job.startedAt,
      measured_to: job.measuredTo,
    });
    this.log(
      `verdicts: #${round.pr} round ${round.round_no} — resuming the measurement a restart cut short (window to ${job.measuredTo})`,
    );
    this.detach(
      () => this.runMeasurement(job, "interrupted"),
      `resumed measurement of #${round.pr} round ${round.round_no}`,
    );
  }

  /** The round's integrity baseline, when dispatch took one that can be
   * judged against; undefined otherwise — such a round is never judged. */
  private integrityBaseline(roundId: number): IntegrityFingerprint | undefined {
    const before = this.deps.store.roundGitConfig(roundId) as IntegrityFingerprint | undefined;
    return before && typeof before.digest === "string" ? before : undefined;
  }

  /** The round-end integrity re-check did not run for this round because a
   * restart cut its measurement short — recorded, never read as "unchanged".
   * Only a round with a baseline could have been judged at all. */
  private integrityInterrupted(pr: number, roundId: number): void {
    if (!this.integrityBaseline(roundId)) return;
    this.deps.store.logEvent("round_integrity_unchecked", pr, {
      round_id: roundId,
      stage: "round_end",
      reason: "interrupted",
    });
  }

  /** How long a round end waits for its transcripts. A measure cut by it
   * goes on in the background (its reads fill the index for the next round
   * end); its late answer is dropped. */
  private usageBudgetMs(): number {
    return Math.max(0, this.deps.usage?.budgetMs ?? USAGE_BUDGET_MS);
  }

  /** Malformed verdict or blown deadline: overseer anomaly, round marked, the
   * PR's lifecycle returned to its standing-verdict state (never an approve,
   * never a park), and the review still OWED as a FAILED_LOUD incident
   * (`openReviewFailure`) that holds the PR out of the pump — and its held
   * wakes behind it — until the operator presses `u`.
   *
   * Only a round still running owes that: every caller awaited something
   * since it read the round (a liveness probe, a posting proof, a requeue
   * that lost its cancel), and a round a verdict, a receipt settlement or an
   * operator ended meanwhile is left as it stands — no transition, no
   * incident over whatever replaced it. The read, the mark, the transition
   * and the incident land in one turn, before the first await. */
  private async handleAnomaly(
    pr: number,
    roundNo: number | null,
    message: string,
    kind: "malformed" | "overdue",
  ): Promise<void> {
    const { cfg, store, adapter } = this.deps;
    const round = this.runningRound(pr, roundNo ?? undefined);
    if (round && round.status !== "running") {
      store.logEvent("anomaly_round_ended", pr, {
        round_id: round.id,
        round_no: round.round_no,
        round_status: round.status,
        kind,
        message,
      });
      this.log(
        `verdicts: #${pr} round ${round.round_no} is already ${round.status} — the ${kind} anomaly opens nothing over it`,
      );
      return;
    }
    let owed: OwedMeasurement | null = null;
    if (round) {
      store.markRoundOverdue(round.id);
      // Measure the round's tokens on this path too, not only on the verdict
      // path: `markRoundOverdue` deliberately keeps the row in spend, and the
      // stranded-round operator message says "Its spend still counts." — an
      // unmeasured overdue or malformed round would contribute zero to every
      // aggregate. The window ends now, which is the `finished_at`
      // markRoundOverdue just stamped. The reads are async (seconds, at most
      // the usage budget), so they run below, after the transition and the
      // FAILED_LOUD incident — a restart while they run must never leave an
      // overdue round under a PR still `reviewing` with nothing owed — and
      // before the anomaly, whose overseer inject carries the violations they
      // find. Owed durably from here; awaited on every path, the deadline
      // tick's included, because that inject reads what it finds.
      owed = this.oweMeasurement(round);
    }

    const standing = standingVerdict(store.reviewedHead(pr));
    applyEvent(
      store,
      pr,
      { type: "round_overdue", standing },
      {},
      { botLogin: cfg.github.bot_login, now: () => this.now(), reason: `anomaly:${kind}` },
    );
    const command = round ? store.sessionCommandForRound(pr, round.round_no) : undefined;
    const successor = store.successorFor(pr);
    const failure = store.openReviewFailure({
      pr,
      command_id: command?.id ?? null,
      round_id: round?.id ?? null,
      round_no: roundNo,
      head_sha: successor?.head_sha ?? store.getPr(pr)?.head_sha ?? "",
      stage: kind === "overdue" ? "round_deadline" : "malformed_verdict",
      detail: message,
      attempts: command?.attempt ?? 1,
      retry_cap: cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES,
    });
    store.logEvent(kind === "overdue" ? "round_overdue" : "verdict_malformed", pr, {
      round_id: round?.id ?? null,
      round_no: roundNo,
      message,
    });
    // The in-progress label must not stick, but the "Automatic Review" label is
    // deliberately not applied — no review was soundly produced.
    await this.safe(
      () => adapter.removeLabel(pr, cfg.github.in_progress_label),
      `remove ${cfg.github.in_progress_label} on #${pr}`,
    );
    if (owed) await this.closeMeasurement(owed, "inline");
    // Piggyback pending exec-policy findings on a wake that happens anyway;
    // violations by themselves never trigger an inject (no spam).
    const pendingViolations = this.execViolations.get(pr);
    this.execViolations.delete(pr);
    // The durable anomaly record — and the one wake funnel: both kinds here
    // are WAKE classes, so the store's sink writes the
    // overseer inject (dedup'd per kind+pr) from the message passed along.
    store.logAnomaly(
      kind,
      pr,
      roundNo,
      message,
      [
        `ANOMALY (${kind}) — PR #${pr}${roundNo !== null ? ` round ${roundNo}` : ""}`,
        message,
        `No review was produced: work remains owed as ${failure.incident_id} (never an approve). No reviewer was requested on GitHub.`,
        "Press u on the board to clear the FAILED_LOUD hold and rerun, or restart the session deliberately.",
        ...(pendingViolations && pendingViolations.length > 0
          ? [
              `Also: exec-policy violations were audited on this PR — ${pendingViolations.join(" · ")}`,
            ]
          : []),
      ].join("\n"),
    );
    await this.announceSafe((a) =>
      a.anomaly({
        pr,
        round_no: roundNo,
        kind,
        deadline_min: cfg.daemon.round_deadline_min,
        incident_id: failure.incident_id,
      }),
    );
    // FAILED_LOUD review debt owns the session ordering until an operator
    // presses u. Held conversation cannot overtake work that is still owed.
    this.log(`verdicts: anomaly (${kind}) on #${pr}`, message);
  }

  /**
   * Deadline-time recovery for a round whose prompt provably never arrived:
   * re-deliver the order and give the round a fresh deadline.
   *
   * The extension is what makes this a recovery rather than a formality — a
   * round already past its deadline would otherwise be re-judged on the very
   * next tick, before the session could possibly have finished. The clock is
   * reset from now, because the review has not started yet: none of the
   * elapsed time was spent reviewing.
   *
   * False ⇒ nothing was delivered (budget spent, or no saved prompt), and the
   * caller escalates.
   */
  private async recoverNeverDelivered(round: RoundRow): Promise<boolean> {
    return (await this.redeliverPrompt(round, "deadline")) === "redelivered";
  }

  /**
   * Re-deliver a round's own dispatched order — same round, same session,
   * the exact bytes — bounded by `max_prompt_redeliveries`. The one
   * redelivery of both the deadline path and the pre-deadline lost-prompt
   * net. A delivered order gets a fresh deadline from now, wherever it was
   * caught: the review has not started, so none of the elapsed time was spent
   * reviewing, and a prompt caught minutes before its deadline must not be
   * judged overdue before the session could have finished. The silent mark
   * is cleared, so the next escalation must be re-earned.
   *
   * `unavailable`: no hook, or the budget is spent — nothing attempted.
   * `failed`: attempted (the attempt counted), nothing delivered.
   */
  private async redeliverPrompt(
    round: RoundRow,
    at: "deadline" | "before_deadline",
  ): Promise<"redelivered" | "failed" | "unavailable"> {
    const { cfg, store } = this.deps;
    const hooks = this.deps.hooks;
    const cap = cfg.daemon.max_prompt_redeliveries ?? DEFAULT_MAX_PROMPT_REDELIVERIES;
    if (!hooks.redeliverRound || round.redeliveries >= cap) return "unavailable";
    const attempt = store.countRedelivery(round.id);
    let redelivered = false;
    try {
      redelivered = await hooks.redeliverRound.call(hooks, round.pr, round.round_no);
    } catch (err) {
      this.log(`verdicts: #${round.pr} round ${round.round_no} redelivery (${at}) failed`, err);
      return "failed";
    }
    if (!redelivered) {
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} has no saved prompt to redeliver (${at})`,
      );
      return "failed";
    }
    store.extendRoundDeadline(round.id, cfg.daemon.round_deadline_min);
    store.clearRoundSilent(round.id);
    store.logEvent("round_prompt_redelivered", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      attempt,
      cap,
      at,
      deadline_extended_min: cfg.daemon.round_deadline_min,
    });
    this.log(
      `verdicts: REDELIVER (${at}) #${round.pr} round ${round.round_no} attempt ${attempt}/${cap} — the prompt never reached the session; same round, same session, nothing cancelled or killed`,
    );
    return "redelivered";
  }

  /**
   * Deliver wakes that are held with no round left to flush them.
   *
   * `flushWakes` runs at a round's settled end — a verdict landing or a
   * guarded no-op — on the assumption that every round ends through one of
   * them. Three cancellations do not: `superseded`, a startup orphan that is
   * not requeued (the requeue needs `state === "reviewing"` and no later
   * round), and a self-requeue whose successor is cancelled the same way. The
   * wakes held while such a round was in flight — author replies included —
   * then sit in `pending_wakes` with nothing to flush them, and that table has
   * no expiry.
   *
   * A PR holding wakes with no round running and no review owed is
   * unambiguous: the reason to hold is gone, so deliver. A PR whose review
   * is owed FAILED_LOUD (the anomaly path, an exhausted recovery) keeps them
   * held — conversation never overtakes owed review work; the operator's `u`
   * resolves the debt, and the next sweep delivers them. A paused PR holding
   * only deferred rechecks keeps them too, until the pause lifts. Runs on the
   * deadline tick, which is already the daemon's "is anything stuck?" sweep.
   */
  private async flushStrandedWakes(): Promise<void> {
    const { store } = this.deps;
    for (const pr of store.prsWithStrandedWakes()) {
      if (store.getPr(pr)?.state === "closed") {
        // The session is archived — there is nothing to wake. Drop them rather
        // than leave rows nothing will ever read.
        const dropped = store.dropHeldWakes(pr);
        if (dropped > 0) store.logEvent("wakes_dropped_closed", pr, { dropped });
        continue;
      }
      // Owed FAILED_LOUD review work keeps its wakes behind it.
      if (store.openReviewFailure(pr)) continue;
      if (store.blockingSessionCommand(`pr-${pr}`)) continue;
      // A paused PR holding only deferred rechecks waits for the resume,
      // quietly: the next tick after the pause lifts delivers them.
      if (pauseDefersAllHeldWakes(store, pr)) continue;
      store.logEvent("wakes_stranded", pr, { held: store.heldWakes(pr).length });
      this.log(`verdicts: #${pr} held wakes with no round running — flushing`);
      await this.flushWakes(pr);
    }
  }

  /** Deliver the wakes held while this PR's round was in flight. */
  private async flushWakes(pr: number): Promise<void> {
    await this.safe(
      () =>
        flushHeldWakes(
          {
            store: this.deps.store,
            inject: (n, message) => this.deps.hooks.inject(n, message),
            log: this.log.bind(this),
          },
          pr,
        ),
      `flush held wakes on #${pr}`,
    );
  }

  /**
   * Stuck-round triage: is this overdue round one the daemon should requeue
   * itself? "Stuck" is overdue (the caller already established that) and
   * session dead (or live with a kill hook) and no verdict file on disk.
   * - no `sessionAlive` hook or a hook error ⇒ `not_stuck`: the anomaly path
   *   stands.
   * - session dead but the round's verdict file is sitting unconsumed ⇒
   *   `verdict_pending`: the sweep will consume it — neither a requeue nor an
   *   anomaly may race a real verdict (the restart-orphan/self-requeue
   *   idempotency hinges on never double-owning a round that already decided).
   */
  private async stuckDisposition(
    round: RoundRow,
  ): Promise<"not_stuck" | "verdict_pending" | "dead" | "alive_stuck" | "never_delivered"> {
    const alive = this.deps.hooks.sessionAlive;
    if (!alive) return "not_stuck";
    let dead: boolean;
    try {
      dead = !(await alive.call(this.deps.hooks, round.pr));
    } catch {
      return "not_stuck";
    }
    if (this.verdictFilePresent(round.pr, round.round_no)) return "verdict_pending";
    if (dead) return "dead";
    // A live session that never received the order is not wedged — it is
    // idle, waiting for work that was lost in transit. Killing it destroys a
    // healthy conversation to fix a file that failed to arrive, so the receipt
    // is checked before `alive_stuck` is concluded.
    if (round.prompt_marker && this.deps.hooks.roundPromptAccepted) {
      try {
        const startedMs = Date.parse(round.started_at);
        const accepted = Number.isFinite(startedMs)
          ? await this.deps.hooks.roundPromptAccepted.call(
              this.deps.hooks,
              round.pr,
              round.round_no,
              startedMs,
            )
          : null;
        if (accepted === false) return "never_delivered";
      } catch {
        // Unreadable evidence falls through to the judgement below.
      }
    }
    // Live but past the deadline with nothing on disk: recover, don't park —
    // the session is killed and the round requeued through the same capped
    // path. Without a kill hook the anomaly path stands — never inject a
    // fresh round into a wedged live session.
    return this.deps.hooks.killSession ? "alive_stuck" : "not_stuck";
  }

  /** Feed command-stage infrastructure failures into the same
   * capped cancellation→queue lifecycle as overdue/dead rounds. There is no
   * merits verdict and no GitHub mutation. A transient inability to stop an
   * active session is retryable; budget exhaustion is distinct durable fact. */
  async recoverInfrastructureFailure(
    pr: number,
    roundNo: number,
    stage: InfrastructureStage,
    detail: string,
  ): Promise<RoundRecoveryDisposition> {
    const round = this.runningRound(pr, roundNo);
    if (!round || round.status !== "running") return "requeued";
    if (round.posting_key) {
      const answered = await this.receiptAwareStage(round, stage, detail);
      if (answered) return answered;
      // The posting proof awaited GitHub: a round an operator or a verdict
      // ended meanwhile is not recovered — and its session, which may now be
      // the replacement round's, is not killed.
      if (!this.stillRunning(round)) return "requeued";
    }
    this.deps.store.logEvent("round_infrastructure_failure", pr, {
      round_id: round.id,
      round_no: roundNo,
      stage,
      detail,
    });
    const head = this.deps.store.getPr(pr)?.head_sha ?? "";
    const cap = this.deps.cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES;
    if (this.deps.store.selfRequeueCount(pr, head) >= cap) {
      const mode =
        stage === "settled_without_verdict" ? "infrastructure_settled" : "infrastructure_active";
      if (mode === "infrastructure_active" && !this.deps.hooks.killSession) return "retryable";
      // A session that could not be stopped, or a verdict that won before the
      // fence, leaves the round to the next check and the sweep.
      if ((await this.fenceForRecovery(round, mode)) !== "fenced") return "retryable";
      const command = this.deps.store.sessionCommandForRound(pr, roundNo);
      if (!command) return "retryable";
      const successor = this.deps.store.successorFor(pr);
      const reason = `round ${roundNo} failed a bounded daemon→Pi infrastructure stage before any merits verdict`;
      const failure = this.deps.store.terminalizeInfrastructureReviewFailure({
        pr,
        command_id: command.id,
        round_id: round.id,
        round_no: roundNo,
        head_sha: successor?.head_sha ?? this.deps.store.getPr(pr)?.head_sha ?? head,
        stage,
        detail,
        attempts: cap,
        retry_cap: cap,
        summary: `infrastructure recovery exhausted after ${cap} self-requeue(s) — ${reason}`,
      });
      if (!failure) {
        // An operator/verdict/concurrent recovery won the exact terminal CAS.
        return this.deps.store.reviewFailureForCommand(command.id)?.work_owed === 1
          ? "exhausted"
          : "requeued";
      }
      // The round's window closes now, and its measurement is owed from now;
      // it runs after the incident's durable rows, so no await sits between
      // the terminal CAS and them (the measurement reads its transcripts
      // async), and in the background: this is the round-stage supervisor's
      // serialized scan.
      const owed = this.oweMeasurement(round);
      this.deps.store.logEvent("self_requeue_cap_exhausted", pr, {
        round_id: round.id,
        round_no: roundNo,
        head_sha: head,
        attempts: cap,
        cap,
        mode,
      });
      this.deps.store.logEvent("round_infrastructure_recovery_exhausted", pr, {
        round_id: round.id,
        round_no: roundNo,
        head_sha: head,
        attempts: cap,
        mode,
      });
      this.deps.store.logAnomaly(
        "review_failed_loud",
        pr,
        roundNo,
        `${stage}: ${detail}; work remains owed as ${failure.incident_id}; ${
          failure.next_action === "retry_wait" && failure.next_retry_at
            ? `automatic retry scheduled for ${failure.next_retry_at} (u retries immediately)`
            : "press u to recover"
        }`,
      );
      // No round owns the review any more: the in-progress label comes off,
      // as on every other terminal path.
      await this.safe(
        () => this.deps.adapter.removeLabel(pr, this.deps.cfg.github.in_progress_label),
        `remove ${this.deps.cfg.github.in_progress_label} on #${pr}`,
      );
      await this.closeMeasurement(owed, "background");
      await this.announceSafe((a) =>
        a.anomaly({
          pr,
          round_no: roundNo,
          kind: "failed_loud",
          deadline_min: this.deps.cfg.daemon.round_deadline_min,
          incident_id: failure.incident_id,
        }),
      );
      return "exhausted";
    }
    if (stage !== "settled_without_verdict" && !this.deps.hooks.killSession) return "retryable";
    const recovered = await this.selfRequeue(
      round,
      stage === "settled_without_verdict" ? "infrastructure_settled" : "infrastructure_active",
      this.preFanoutRecovery(round, stage),
    );
    return recovered ? "requeued" : "retryable";
  }

  /**
   * Every stage limit asks the posting receipt first. The limits are
   * wall-clock bounds on a session that is supposed to be reviewing; once its
   * review is confirmed on GitHub, it is not — it is writing its ledger, its
   * findings record and its verdict file, and on a CPU-starved container that
   * tail can outlive the finalize grace. Cancelling and requeueing it then
   * would post a second review on the same head.
   *
   * So, for a round whose review is on GitHub (or was refused by guard 2 —
   * equally final):
   *   - a parent that has settled will write nothing more: settle now;
   *   - otherwise the tail gets `[daemon] round_posted_tail_grace_min` from the
   *     posting — `posted_wait`: nothing is cancelled, killed or requeued, and
   *     a verdict file that lands in that window is applied by the sweep as
   *     usual;
   *   - past it, settle from the receipt when it proves the decision
   *     (`decidedVerdictFromReceipt`), and fail loud (`posted_without_verdict`,
   *     the shape a posted round without a verdict always had) when it does
   *     not. Never a requeue, so never a second posting.
   * A POST still inside its ambiguous transport window (a `prepared` receipt
   * within `posting_receipt_grace_s`) is waited out too: killing the poster
   * there is how a review lands on GitHub with nothing local to say so.
   *
   * Before any of that, and whatever the receipt says — receipt or none — a
   * verdict file already on disk (or one the watcher is still reading) defers
   * the limit to the sweep: the session has finished, and cancelling the round
   * under its own verdict would only make that verdict land on a cancelled
   * round. The deferral is bounded by the sweep, which consumes the file within
   * its partial-write window (applied, or malformed and archived) every
   * `VERDICT_SWEEP_S`.
   *
   * Returns null for everything else — no receipt, an unreadable or
   * mismatched one, a legacy round — and the caller's own path runs:
   * unknown is not evidence of a posting.
   */
  private async receiptAwareStage(
    round: RoundRow,
    stage: InfrastructureStage,
    detail: string,
  ): Promise<RoundRecoveryDisposition | null> {
    const { store, cfg } = this.deps;
    // A verdict file on disk (or one the watcher is still reading) is the
    // sweep's, whatever the receipt says.
    if (
      this.verdictFilePresent(round.pr, round.round_no) ||
      this.inFlight.has(verdictFileName(round.pr, round.round_no))
    )
      return "retryable";
    const proof = await this.postingProof(round);
    if (proof.kind === "confirmed" || proof.kind === "skipped") {
      const graceMin =
        cfg.daemon.round_posted_tail_grace_min ?? DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN;
      if (
        stage !== "settled_without_verdict" &&
        this.inPostedTailGrace(round, proof, stage, detail)
      )
        return "posted_wait";
      const settled = await this.withVerdictSlot(
        round.pr,
        round.round_no,
        async (): Promise<RoundRecoveryDisposition> => {
          // The verdict may have landed while this awaited GitHub: it wins.
          if (this.verdictFilePresent(round.pr, round.round_no)) return "retryable";
          if (proof.kind === "skipped") {
            // Refused by guard 2 and no verdict file. The round is over
            // and nothing is owed; the delivered command stays as it is.
            return (await this.settleGuardedNoop(round, proof.noop!, stage)) === "failed"
              ? "failed_loud"
              : "settled";
          }
          const receipt = proof.receipt!;
          const why =
            stage === "settled_without_verdict"
              ? detail
              : `${detail}; no verdict file ${graceMin} min after the review was posted`;
          const decision = decidedVerdictFromReceipt(receipt);
          if (decision) {
            await this.settleFromReceipt(round, receipt, decision, stage, why);
            return "settled";
          }
          // Posted, the session has written nothing, and the receipt does not
          // say what was decided: loud, as a posted round without a verdict
          // always was — and never a requeue, which would post a second time.
          if (!this.stillRunning(round)) return "settled";
          await this.failPostingProof(
            round,
            `GitHub review ${receipt.gh_review_id ?? "confirmed"} was posted (${receipt.actual_event}) but ${stage === "settled_without_verdict" ? "the session settled before writing its verdict" : `the session wrote no verdict within ${graceMin} min of posting`}, and the posting receipt does not say what was decided`,
            "posted_without_verdict",
            "background",
          );
          return "failed_loud";
        },
      );
      return settled ?? "retryable";
    }
    if (stage === "settled_without_verdict") {
      // The parent stopped, so an ambiguous receipt gets its grace and then
      // fails loud — never a requeue that could post a second time.
      if (proof.kind === "waiting") return "retryable";
      if (proof.kind === "failed") {
        return stageFailure(
          await this.failPostingProofUnlessVerdict(
            round,
            proof.detail ?? "settled without a posting receipt",
            "posting_receipt",
          ),
        );
      }
      return null;
    }
    if (
      proof.kind === "waiting" &&
      (this.postInFlight(round) ||
        (round.posting_key &&
          pendingPosting(this.postingReceiptDir(), round.pr, round.round_no, round.posting_key)))
    ) {
      store.logEvent("round_stage_posting_in_flight", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        stage,
        detail,
      });
      return "retryable";
    }
    if (proof.kind === "failed" && proof.failure === "ambiguous") {
      // A POST for exactly this round may have landed — its receipt is still
      // `prepared` past its grace — and GitHub could not be read for its
      // marker. A requeue here could post twice; so could failing loud, whose
      // `u` reruns a round that cannot see the posting either. So the limit
      // waits for a read that can decide: the next check finds the marker (and
      // settles from it) or finds none (and requeues). Bounded by the round
      // deadline, where the same evidence fails loud.
      if (!this.loggedOnce.has(`ambiguous:${round.id}`)) {
        this.loggedOnce.add(`ambiguous:${round.id}`);
        store.logEvent("round_stage_posting_ambiguous", round.pr, {
          round_id: round.id,
          round_no: round.round_no,
          stage,
          detail,
          posting_key: round.posting_key,
        });
        this.log(
          `verdicts: #${round.pr} round ${round.round_no} hit ${stage} with a POST whose outcome is unknown (receipt still prepared, GitHub unreadable) — waiting for a read that can decide; nothing cancelled, killed or requeued`,
        );
      }
      return "retryable";
    }
    if (
      proof.kind === "failed" &&
      (proof.failure === "contradicted" || proof.failure === "exhausted")
    ) {
      // Evidence of a posting that disagrees with the round (conflicting
      // linkage, several matching reviews): a requeue could only add another.
      // Loud, as the verdict and deadline paths are on the same evidence.
      return stageFailure(
        await this.failPostingProofUnlessVerdict(
          round,
          proof.detail ?? "posting receipt contradicted",
          "posting_receipt",
        ),
      );
    }
    // Nothing says a review went out (no receipt, or GitHub read and no
    // marker): the caller's own path.
    return null;
  }

  /** Is this the same round, still running? A fresh read, for the paths that
   * awaited GitHub since they found it. */
  private stillRunning(round: RoundRow): boolean {
    const fresh = this.runningRound(round.pr, round.round_no);
    return fresh !== undefined && fresh.id === round.id && fresh.status === "running";
  }

  /**
   * Inside the posted-tail grace: the round's review is on GitHub (or guard
   * 2 refused it), and the session is still writing its ledger, findings
   * record and verdict file — not wedged. True while `now` is before the
   * posting + `[daemon] round_posted_tail_grace_min`, logged once per round
   * and limit. Shared by the stage limits and the round deadline, so neither
   * settles a round (and lets the supervisor kill the session) mid-tail.
   */
  private inPostedTailGrace(
    round: RoundRow,
    proof: { kind: string; receipt?: PostingReceipt; noop?: GuardedNoopReceipt },
    limit: InfrastructureStage | "round_deadline",
    detail: string,
  ): boolean {
    const postedAt =
      proof.kind === "confirmed"
        ? (proof.receipt?.confirmed_at ?? proof.receipt?.prepared_at)
        : proof.noop?.skipped_at;
    if (postedAt === undefined) return false;
    const graceMin =
      this.deps.cfg.daemon.round_posted_tail_grace_min ?? DEFAULT_ROUND_POSTED_TAIL_GRACE_MIN;
    const until = Date.parse(postedAt) + graceMin * 60_000;
    if (!Number.isFinite(until) || this.now().getTime() >= until) return false;
    const key = `${limit === "round_deadline" ? "deadline" : "stage"}:${round.id}`;
    if (!this.loggedOnce.has(key)) {
      this.loggedOnce.add(key);
      this.deps.store.logEvent("round_stage_posted_wait", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        stage: limit,
        detail,
        posting: proof.kind,
        posted_at: postedAt,
        wait_until: new Date(until).toISOString(),
      });
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} hit ${limit} after its review was ${proof.kind === "confirmed" ? "posted" : "refused by guard 2"} — ` +
          `not a failure; the session's tail has until ${new Date(until).toISOString()}, nothing cancelled or killed`,
      );
    }
    return true;
  }

  /** A `prepared` receipt for exactly this round: a POST whose outcome is not
   * known yet. */
  private postInFlight(round: RoundRow): boolean {
    const receipt = readPostingReceipt(this.postingReceiptDir(), round.pr, round.round_no);
    return (
      receipt !== undefined &&
      receipt.status === "prepared" &&
      receipt.posting_key === round.posting_key &&
      receipt.pr === round.pr &&
      receipt.round_no === round.round_no
    );
  }

  /** Only exact command-correlated pre-fanout failures get a changed-behavior
   * successor instruction. The retry epoch follows an automatic predecessor;
   * ordinary fresh work naturally starts again at epoch zero. */
  private preFanoutRecovery(
    round: RoundRow,
    stage: InfrastructureStage,
  ): { stage: "first_pass_start"; source_command_id: string; retry_epoch: number } | undefined {
    if (stage !== "first_pass_start") return undefined;
    const command = this.deps.store.sessionCommandForRound(round.pr, round.round_no);
    if (!command) return undefined;
    return {
      stage,
      source_command_id: command.id,
      retry_epoch:
        this.deps.store.roundRecoveryInstruction(round.pr, round.round_no)?.retry_epoch ?? 0,
    };
  }

  /**
   * Whether this round's review already went out: a posting the caller proved
   * from GitHub (`proven`), or a posting receipt other than a guard-2 refusal
   * — confirmed, or still owned by the daemon's delivery. A round whose
   * review went out is never redone, whatever else is wrong with it: a redo
   * would post a second review. The evidence's name (`proven` or the
   * receipt's status), or undefined when nothing went out.
   */
  private reviewWentOut(pr: number, roundNo: number, proven: boolean): string | undefined {
    if (proven) return "proven";
    const receipt = readPostingReceipt(this.postingReceiptDir(), pr, roundNo);
    return receipt !== undefined && receipt.status !== "skipped" ? receipt.status : undefined;
  }

  /**
   * The verdict-time belt for required passes (src/requiredpasses.ts). Every
   * failed pass of the round is recorded (`round_pass_failures`) — the gap is
   * internal, never on the PR. When a required pass is missing and nothing
   * was posted for the round, the round is cancelled and requeued within
   * `max_self_requeues` (true: the caller returns); past the cap it ends on
   * the anomaly path, never with a verdict applied over the gap. A gap whose
   * review already went out (`reviewWentOut`) is logged and applied as
   * usual — a requeue would post a second review. Unknown evidence never requeues.
   */
  private async requeueOnRequiredPassGap(
    v: VerdictFile,
    round: RoundRow,
    proven: boolean,
  ): Promise<boolean> {
    const { cfg, store, adapter } = this.deps;
    const progress = readRoundProgress(this.deps.root ?? sandboxRoot(), v.pr);
    const failures = failedPasses(progress, v.round_no);
    if (failures.length > 0)
      store.logEvent("round_pass_failures", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        failed: failures,
      });
    const gap = requiredPassGap(
      parsePlan(round.pass_plan),
      progress,
      v.round_no,
      parsePlan(round.sweep_plan),
    );
    if (gap.state !== "missing") return false;
    const missing = describeGap(gap.missing);
    const posted = this.reviewWentOut(v.pr, v.round_no, proven);
    if (posted) {
      store.logEvent("required_pass_missing_after_post", v.pr, {
        round_id: round.id,
        round_no: v.round_no,
        receipt: posted,
        missing,
      });
      return false;
    }
    store.logEvent("round_required_pass_missing", v.pr, {
      round_id: round.id,
      round_no: v.round_no,
      head_sha: v.head_sha,
      missing,
    });
    if (await this.selfRequeue(round, "required_pass_missing")) {
      await this.safe(
        () => adapter.removeLabel(v.pr, cfg.github.in_progress_label),
        `remove ${cfg.github.in_progress_label} on #${v.pr}`,
      );
      this.log(
        `verdicts: #${v.pr} round ${v.round_no} missing required pass(es) ${missing} — requeued, nothing posted`,
      );
      return true;
    }
    await this.handleAnomaly(
      v.pr,
      v.round_no,
      `round ${v.round_no} is missing required pass(es) ${missing} and could not be self-requeued — cap exhausted or no running round; nothing was posted`,
      "overdue",
    );
    return true;
  }

  /**
   * Stop a round's session before recovering it, then look for a verdict
   * that won while it was being stopped — the one fencing protocol the
   * self-requeue and the exhausted infrastructure recovery share. A wedged
   * (`alive_stuck`) or active-infrastructure session is killed; any other
   * has nothing left to stop. After a kill the read is definitive: no verdict
   * can appear once the session is gone; a settled parent's writes are over.
   *   - `kill_failed`: the session could not be stopped (logged) — nothing
   *     may be recovered over a session that may still write;
   *   - `verdict_won`: a verdict file is on disk (logged) — it is the sweep's;
   *   - `posting_won`: posting or its durable retry won; the ordinary receipt
   *     settlement sweep owns it, never a replacement review;
   *   - `fenced`: recover.
   */
  private async fenceForRecovery(
    round: RoundRow,
    mode: SelfRequeueMode,
  ): Promise<"kill_failed" | "verdict_won" | "posting_won" | "fenced"> {
    const { store } = this.deps;
    const kill = this.deps.hooks.killSession;
    if ((mode === "alive_stuck" || mode === "infrastructure_active") && kill) {
      try {
        await kill.call(this.deps.hooks, round.pr);
      } catch (error) {
        store.logEvent("session_recovery_kill_failed", round.pr, {
          round_id: round.id,
          round_no: round.round_no,
          mode,
          error: String(error),
        });
        return "kill_failed";
      }
    }
    const fencedModes: SelfRequeueMode[] = [
      "alive_stuck",
      "infrastructure_active",
      "infrastructure_settled",
    ];
    if (fencedModes.includes(mode) && this.verdictFilePresent(round.pr, round.round_no)) {
      store.logEvent("round_stage_verdict_won", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        mode,
      });
      return "verdict_won";
    }
    if (fencedModes.includes(mode) && round.posting_key) {
      const proof = await this.postingProof(round);
      if (
        proof.kind === "confirmed" ||
        proof.kind === "skipped" ||
        (proof.kind === "waiting" &&
          (this.postInFlight(round) ||
            pendingPosting(
              this.postingReceiptDir(),
              round.pr,
              round.round_no,
              round.posting_key,
            ))) ||
        (proof.kind === "failed" && proof.failure === "ambiguous")
      ) {
        store.logEvent("round_stage_posting_won", round.pr, {
          round_id: round.id,
          round_no: round.round_no,
          mode,
          proof: proof.kind,
        });
        return "posting_won";
      }
    }
    return "fenced";
  }

  /**
   * Self-requeue a stuck round. Returns true when the round was handled here
   * (cancelled + PR re-queued for a fresh dispatch through the normal pump —
   * same move as the overseer's rerun-round and the startup orphan requeue);
   * false when the per-head cap is exhausted (or the old session could not be
   * stopped) and the caller must take the anomaly path instead.
   *
   * Session-side only by construction: no label, no review, no gate call —
   * dry-run and live behave identically. The cancelled round keeps a NULL
   * verdict, so `priorRoundCount`/review_no never age (a failed round must
   * not age the PR). Held wakes stay held: the requeued round is about to
   * dispatch, and its own round-end paths flush them.
   */
  private async selfRequeue(
    round: RoundRow,
    mode: SelfRequeueMode = "dead",
    recovery?: { stage: "first_pass_start"; source_command_id: string; retry_epoch: number },
  ): Promise<boolean> {
    const { store, cfg } = this.deps;
    const row = store.getPr(round.pr);
    const head = row?.head_sha ?? "";
    const cap = cfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES;
    const attempt = store.selfRequeueCount(round.pr, head) + 1;
    const exhausted = attempt > cap;
    const infrastructure = mode === "infrastructure_active" || mode === "infrastructure_settled";
    if (exhausted) {
      store.logEvent("self_requeue_cap_exhausted", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        head_sha: head,
        attempts: attempt - 1,
        cap,
        mode,
      });
      return false;
    }
    const reason =
      mode === "dead"
        ? `round ${round.round_no} passed its deadline (${round.deadline_at}) with no verdict and its session is dead`
        : mode === "alive_stuck"
          ? `round ${round.round_no} passed its deadline (${round.deadline_at}) with no verdict; its session was alive but wedged and has been killed for a fresh rebirth`
          : mode === "lost_prompt"
            ? `round ${round.round_no}'s prompt left the inject dir but its receipt never appeared in the session transcript since the round started (${round.started_at}) — the prompt was dropped in delivery and redelivery is spent or impossible; redispatching`
            : mode === "required_pass_missing"
              ? `round ${round.round_no} ended with a required pass (pass-baseline or a risk lens) failed and never completed — the session posted nothing; redispatching`
              : mode === "head_moved"
                ? `round ${round.round_no} ended head_moved (guard 5): the PR advanced mid-round and the session correctly posted nothing — redispatching against the fresh head; the session is healthy and was not killed`
                : mode === "infrastructure_active" || mode === "infrastructure_settled"
                  ? `round ${round.round_no} failed a bounded daemon→Pi infrastructure stage before any merits verdict — redispatching through the ordinary pump`
                  : `round ${round.round_no} verdicted NEEDS_HUMAN without executing any passes — the review was not done, so it is redone rather than handed to a person`;
    if (mode === "infrastructure_active" && !this.deps.hooks.killSession) {
      store.logEvent("session_recovery_kill_unavailable", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        mode,
      });
      return false;
    }
    const fence = await this.fenceForRecovery(round, mode);
    if (fence === "kill_failed") {
      this.log(
        `verdicts: refusing ${mode} requeue for #${round.pr}; old session could not be stopped`,
      );
      return false;
    }
    // The verdict that won the fence is the 10s sweep's, never cancelled or
    // quarantined here. A wedged session's (`alive_stuck`) is handled — the
    // deadline path neither requeues nor fails the round; an infrastructure
    // stage's is not, and the stage is checked again.
    if (fence === "verdict_won" || fence === "posting_won") return mode === "alive_stuck";
    if (infrastructure && this.runningRound(round.pr, round.round_no)?.status !== "running")
      return true;
    const cause = SELF_REQUEUE_CAUSE[mode];
    const publication = store.cancelRoundAndQueueRecovery({
      pr: round.pr,
      round_id: round.id,
      round_no: round.round_no,
      summary: `self-requeue ${attempt}/${cap} — ${reason}`,
      cause,
      fallback_head_sha: head,
      trigger_ts: this.now().toISOString(),
      ...(recovery
        ? {
            recovery: {
              stage: recovery.stage,
              source_command_id: recovery.source_command_id,
              immediate_attempt: attempt,
              retry_epoch: recovery.retry_epoch,
            },
          }
        : {}),
    });
    if (!publication) return false;
    // A cancelled round burned real tokens and stays in every spend aggregate
    // (`SUM(est_usd) FROM rounds` has no status filter), so it must be
    // measured. The window's end is fixed here, and the measurement owed from
    // here; the successor's window begins later, so the two never overlap.
    // The reads (async) run after this requeue's durable rows below, so a
    // successor dispatched while they run never sees the cancel without its
    // `round_self_requeued` row. From the deadline tick and the round-stage
    // supervisor they run in the background.
    const owed = this.oweMeasurement(round);
    if (isLoudCancelCause(cause)) {
      // The durable twin of the inject below. A round that stopped dead
      // inside its deadline window is a real defect; the redeploy orphan
      // sweep writes nothing here. `round_stopped_dead` is deliberately absent
      // from anomalies.ts WAKE_KINDS: the bespoke SELF-REQUEUE inject a few
      // lines down is this record's wake, and listing it there would inject
      // the same event twice.
      store.logAnomaly(
        "round_stopped_dead",
        round.pr,
        round.round_no,
        `round ${round.round_no} stopped dead inside its deadline window (${round.started_at} → ${round.deadline_at}) and was cancelled; self-requeue attempt ${attempt}/${cap}`,
      );
    }
    store.logEvent("round_self_requeued", round.pr, {
      cancel_cause: cause,
      round_id: round.id,
      round_no: round.round_no,
      head_sha: head,
      attempt,
      cap,
      mode,
      reason,
    });
    await this.closeMeasurement(owed, measureModeForRequeue(mode));
    if (!publication.queued) {
      store.logEvent("round_self_requeue_terminal", round.pr, {
        round_id: round.id,
        round_no: round.round_no,
        reason: "pr_closed",
      });
      return true;
    }
    this.log(
      `verdicts: SELF-REQUEUE #${round.pr} round ${round.round_no} attempt ${attempt}/${cap} — ${reason}`,
    );
    await this.safe(
      () =>
        this.deps.hooks.injectOverseer(
          [
            `SELF-REQUEUE (recovery) — PR #${round.pr} round ${round.round_no}, attempt ${attempt}/${cap}`,
            reason,
            "The daemon cancelled the round and re-queued the PR for a fresh dispatch through the normal path. No GitHub state was touched.",
            "This is a recovery path, not a normal one — if it recurs on the same PR, investigate the cause the line above names.",
          ].join("\n"),
        ),
      "inject overseer self-requeue",
    );
    return true;
  }

  /**
   * Recover a round whose prompt never reached its session.
   *
   * Loss is judged from the receipt, never inferred from activity: a prompt
   * is dropped precisely because the agent is busy, and a busy agent always
   * has activity after round start. `roundPromptAccepted` is a fact (the
   * dispatched receipt token, echoed into the session JSONL only when pi
   * accepted the message), so `false` means the prompt is not there. It does
   * not depend on the head's self-requeue budget either: a `head_moved`
   * requeue spends one seconds before dispatching the round most likely to be
   * lost.
   *
   * Recovery is cheap first. A missing prompt is a delivery fault, so the
   * remedy is to deliver it again — same round, same session, same
   * conversation — and only a redelivery that also fails to land escalates to
   * the expensive path (a cancelled round, and for a live session a kill):
   * killing a healthy session because a file did not arrive destroys a live
   * conversation.
   */
  private async maybeRequeueLostPrompt(round: RoundRow, nowMs: number): Promise<void> {
    const { cfg, store } = this.deps;
    const hooks = this.deps.hooks;
    if (!hooks.roundPromptAccepted || !hooks.injectPending || !hooks.sessionAlive) return;
    // A round dispatched before receipts existed carries no marker, so its
    // delivery is unknowable — never guess at it.
    if (!round.prompt_marker) return;
    const graceMs = (cfg.daemon.round_stall_grace_min ?? DEFAULT_ROUND_STALL_GRACE_MIN) * 60_000;
    const startedMs = Date.parse(round.started_at);
    if (!Number.isFinite(startedMs) || nowMs - startedMs < graceMs) return;
    if (store.hasLaterRound(round.pr, round.round_no)) return; // superseded — the deadline sweep owns that case
    if (this.verdictFilePresent(round.pr, round.round_no)) return;
    const clearSilent = (): void => {
      if (round.silent_since) store.clearRoundSilent(round.id);
    };
    try {
      if (await hooks.injectPending.call(hooks, round.pr)) {
        clearSilent(); // bridge still holding/retrying — patience, not loss
        return;
      }
      const accepted = await hooks.roundPromptAccepted.call(
        hooks,
        round.pr,
        round.round_no,
        startedMs,
      );
      if (accepted !== false) {
        // true = delivered and the session owns it; null = no evidence either
        // way. Neither is loss.
        clearSilent();
        return;
      }
    } catch {
      clearSilent(); // an unreadable signal is not evidence
      return;
    }
    // Two consecutive observations before acting. The receipt is a fact, but
    // the window around it is not: a prompt delivered a moment ago may not yet
    // be flushed to the JSONL, and re-sending a round the session has already
    // started is worse than waiting one more tick.
    if (!round.silent_since) {
      store.markRoundSilent(round.id);
      this.log(
        `verdicts: #${round.pr} round ${round.round_no} shows no prompt receipt — marked; recovering on the next sweep if it is still missing`,
      );
      return;
    }
    store.logEvent("round_prompt_lost", round.pr, {
      round_id: round.id,
      round_no: round.round_no,
      started_at: round.started_at,
      silent_since: round.silent_since,
      redeliveries: round.redeliveries,
    });
    // ---- cheap recovery first: deliver the same order again ----------------
    if ((await this.redeliverPrompt(round, "before_deadline")) === "redelivered") return;
    // ---- redelivery is spent or impossible: the expensive path -------------
    await this.selfRequeue(round, "lost_prompt");
  }

  /** Deadline sweep — a running round past `deadline_at` is an anomaly.
   * A superseded round (a newer round exists on the same PR) is cancelled
   * silently instead: its PR state, labels and reviewer requests belong to
   * the newer round, and yanking them here would corrupt live reviews.
   * An overdue round with no verdict whose session is dead (or alive and
   * wedged) is self-requeued, capped per head.
   *
   * Never overlaps itself: a tick still running
   * — it awaits GitHub reads and, on the anomaly path, the round's measurement
   * — makes the next one a no-op, as the verdict sweep's per-file guards do
   * for it. */
  async checkDeadlines(): Promise<number[]> {
    if (this.deadlinesInFlight) return [];
    this.deadlinesInFlight = true;
    try {
      return await this.checkDeadlinesOnce();
    } finally {
      this.deadlinesInFlight = false;
    }
  }

  private async checkDeadlinesOnce(): Promise<number[]> {
    const overdue: number[] = [];
    const nowMs = this.now().getTime();
    const { store } = this.deps;
    await this.flushStrandedWakes();
    for (const round of store.runningRounds()) {
      if (Date.parse(round.deadline_at) > nowMs) {
        // Lost-prompt net, well before the deadline: the round's inject was
        // consumed (nothing pending, so the bridge is not merely retrying),
        // no verdict is on disk, and the session's JSONL carries no receipt
        // for the prompt. Redelivered first, then requeued through the same
        // capped path (`maybeRequeueLostPrompt`).
        await this.maybeRequeueLostPrompt(round, nowMs);
        continue;
      }
      if (store.hasLaterRound(round.pr, round.round_no)) {
        store.markRoundCancelled(
          round.id,
          `superseded — round ${round.round_no} outlived by a newer round`,
          "superseded",
        );
        store.logEvent("round_superseded", round.pr, {
          round_id: round.id,
          round_no: round.round_no,
        });
        // Slack: "read the newest one" — no existing review is touched, ever
        // (CLAUDE.md hard rule 2); the wording invariant lives in messages.ts.
        const newest = store
          .roundsFor(round.pr)
          .reduce((a, b) => (b.round_no > a.round_no ? b : a), round);
        await this.announceSafe((a) =>
          a.superseded({
            pr: round.pr,
            old_round_no: round.round_no,
            new_round_no: newest.round_no,
            head_sha: store.getPr(round.pr)?.head_sha ?? "",
          }),
        );
        this.log(`verdicts: #${round.pr} round ${round.round_no} cancelled (superseded)`);
        continue;
      }
      if (round.posting_key && !this.verdictFilePresent(round.pr, round.round_no)) {
        const proof = await this.postingProof(round);
        if (proof.kind === "waiting") continue;
        // The deadline honours the posted-tail grace the stage limits give:
        // settling minutes after the post would end the round under a session
        // still writing its tail, and the supervisor's terminal-round path
        // would then kill it, losing its summary and pass telemetry. Past the
        // grace it settles; a verdict file that lands within it is the
        // sweep's.
        if (
          (proof.kind === "skipped" || proof.kind === "confirmed") &&
          this.inPostedTailGrace(
            round,
            proof,
            "round_deadline",
            `round ${round.round_no} passed its deadline (${round.deadline_at}) with no verdict file`,
          )
        )
          continue;
        if (proof.kind === "skipped") {
          // Refused by guard 2, no verdict file by the deadline. Not
          // stuck, not failed — settled, and a late verdict file replays inertly.
          await this.settleGuardedNoop(round, proof.noop!, "deadline");
          continue;
        }
        if (proof.kind === "confirmed" && proof.receipt) {
          // The review is on GitHub; the missing verdict file is settled from
          // the receipt, never re-run (a rerun would post a second review). A
          // receipt that does not say what was decided keeps the loud path.
          const receipt = proof.receipt;
          const decision = decidedVerdictFromReceipt(receipt);
          if (!decision) {
            await this.failPostingProofUnlessVerdict(
              round,
              `GitHub review ${receipt.gh_review_id ?? "confirmed"} was posted (${receipt.actual_event}) but no verdict file arrived before the round deadline, and the posting receipt does not say what was decided`,
              "posted_without_verdict",
            );
            continue;
          }
          await this.withVerdictSlot(round.pr, round.round_no, async () => {
            if (this.verdictFilePresent(round.pr, round.round_no)) return;
            await this.settleFromReceipt(
              round,
              receipt,
              decision,
              "deadline",
              `round ${round.round_no} passed its deadline (${round.deadline_at}) with its review posted and no verdict file`,
            );
          });
          continue;
        }
        if (proof.kind === "failed") {
          await this.failPostingProofUnlessVerdict(
            round,
            proof.detail ?? "round ended without posting confirmation",
            "posting_receipt",
          );
          continue;
        }
      }
      const stuck = await this.stuckDisposition(round);
      if (stuck === "verdict_pending") {
        // A real verdict is on disk — the sweep consumes it; do nothing here.
        this.log(
          `verdicts: #${round.pr} round ${round.round_no} overdue but its verdict file is pending — leaving it to the sweep`,
        );
        continue;
      }
      // A live session that provably never got the order: deliver it again
      // rather than kill a healthy conversation. Only when redelivery
      // is spent or impossible does this fall through to the expensive path.
      if (stuck === "never_delivered" && (await this.recoverNeverDelivered(round))) continue;
      const expensive = stuck === "dead" || stuck === "alive_stuck" || stuck === "never_delivered";
      if (
        expensive &&
        (await this.selfRequeue(round, stuck === "never_delivered" ? "lost_prompt" : stuck))
      )
        continue;
      overdue.push(round.pr);
      await this.handleAnomaly(
        round.pr,
        round.round_no,
        `round ${round.round_no} passed its deadline (${round.deadline_at}); started ${round.started_at}` +
          (expensive ? " — the self-requeue cap is exhausted; parking" : ""),
        "overdue",
      );
    }
    return overdue;
  }

  /** Slack is a side channel: absent announcer ⇒ nothing happens, and a Slack
   * failure is logged, never propagated into the verdict path. */
  private async announceSafe(fn: (a: VerdictAnnouncer) => Promise<void>): Promise<void> {
    const announcer = this.deps.announce;
    if (!announcer) return;
    try {
      await fn(announcer);
    } catch (err) {
      this.log("verdicts: slack announcement failed", err);
    }
  }

  private async safe<T>(fn: () => Promise<T>, what: string): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.log(`verdicts: ${what} failed`, err);
      // A side channel's failure record must not become a failure of its
      // own: the delayed round tail can outlive the store it writes to.
      try {
        this.deps.store.logEvent("verdict_action_failed", null, { what, error: String(err) });
      } catch (logErr) {
        this.log(`verdicts: ${what} failure not recorded`, logErr);
      }
      return undefined;
    }
  }
}
