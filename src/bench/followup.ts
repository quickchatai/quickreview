// The bench's follow-up replay (docs/follow-up-rounds.md "Validation"):
// round k of a recorded PR, replayed offline at its head after an earlier
// round reviewed `prev_head`, so the follow-up round can be measured against
// the full re-review of the same pair.
//
// Everything that decides what the round looks like is PRODUCTION's, called,
// never re-implemented:
//   - the delta: `WorktreeManager.prOwnedDelta`, run over the case's replay
//     tree (the tree's own git dir stands in for the base clone);
//   - the plan, the fallback reasons and the sweep plan: dispatch's
//     `planFollowUp` (the pure half of `decideFollowUp`);
//   - the delta patch and the order's delta: `renderDeltaPatch`,
//     `roundDeltaOf`; the sweep's task order: `sweepOrderOf`;
//   - the prior findings: `computePriorFindings` over rows built from the
//     case, rendered by `renderPriorFindingsNote`.
// What differs is only what a recorded case must supply in place of the
// daemon's state: the previous head, the round and review numbers, whether
// the sweep was owed, the open prior findings and the ledger.
//
// A doubt is a FULL round here exactly as in production: the knob, a delta
// git could not compute, a delta over the ratio, a plan without the baseline
// — the case then runs today's full re-review (`round-re-review.md`), and the
// case summary says why.

import { basename, dirname } from "node:path";
import { REVIEW_DEFAULTS, type Config } from "../config.js";
import {
  followUpSweepOwed,
  planFollowUp,
  type FollowUpDecision,
  type FollowUpFullReason,
  type PassPlan,
} from "../dispatch.js";
import type { Ecosystem } from "../ecosystem.js";
import type { PrFileEntry } from "../github.js";
import type { HeuristicsExtension } from "../heuristics.js";
import type { CiLinter } from "../lintconfig.js";
import {
  computePriorFindings,
  renderPriorFindingsNote,
  priorSidecarText,
  type PriorFindingsList,
} from "../priorfindings.js";
import type { RoundFindingRow } from "../state.js";
import type { ExecFn } from "../tmux.js";
import { WorktreeManager, type PrOwnedDelta } from "../worktrees.js";
import type { BenchCase, PrefetchMeta } from "./aacr.js";
import { GIT_ISOLATION_ENV, run } from "./exec.js";

const GIT_ENV = { ...process.env, ...GIT_ISOLATION_ENV };

/** The bench's subprocess helper in the shape `WorktreeManager` takes —
 * never the daemon's exec plumbing (src/bench/exec.ts header). */
const benchExec: ExecFn = async (cmd, args, opts = {}) => {
  const r = await run(cmd, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: GIT_ENV,
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
};

/**
 * The PR-owned change from the case's previous head to its head, computed by
 * production's `WorktreeManager.prOwnedDelta` over the replay tree. The tree
 * has no remote, so a missing previous head is `old-head-missing` (nothing is
 * fetched); every unknown is `{ok:false, reason}` — a full round.
 */
export async function benchDelta(
  tree: string,
  c: BenchCase,
  meta: PrefetchMeta,
  exec: ExecFn = benchExec,
): Promise<PrOwnedDelta> {
  if (!meta.prev_head) return { ok: false, reason: "no-reviewed-head" };
  const wm = new WorktreeManager({
    root: dirname(tree),
    repo: c.repo,
    cloneDir: basename(tree),
    run: exec,
  });
  // As dispatch asks it: the round's merge base and the base tip it fetched.
  return wm.prOwnedDelta({
    pr: c.pr,
    from: meta.prev_head,
    to: meta.head_commit,
    mergeBase: meta.merge_base,
    baseSha: meta.base_commit,
  });
}

/** What a follow-up replay case runs as. */
export type BenchFollowUpDecision =
  | { kind: "delta"; decision: FollowUpDecision }
  | { kind: "full"; reason: FollowUpFullReason; detail?: Record<string, unknown> };

/**
 * Production's follow-up decision for a recorded case: the `[review]
 * follow_up` knob, then the delta (computed by the caller with `benchDelta`;
 * undefined = no git seam), then `planFollowUp` with the case's own answer
 * to "is the sweep owed".
 */
export function decideBenchFollowUp(
  cfg: Config,
  heuristics: HeuristicsExtension | undefined,
  c: BenchCase,
  args: {
    delta: PrOwnedDelta | undefined;
    files: PrFileEntry[];
    fullPlan: PassPlan;
    ecosystem: Ecosystem;
    styleGuide: readonly string[];
    ciLinters: readonly CiLinter[];
  },
): BenchFollowUpDecision {
  const fu = c.followup;
  if (!fu) return { kind: "full", reason: "no-reviewed-head" };
  if ((cfg.review.follow_up ?? REVIEW_DEFAULTS.follow_up) !== "delta")
    return { kind: "full", reason: "follow_up_full" };
  const d = args.delta;
  if (!d) return { kind: "full", reason: "no-adapter" };
  if (!d.ok)
    return {
      kind: "full",
      reason: d.reason,
      ...(d.detail ? { detail: { detail: d.detail } } : {}),
    };
  return planFollowUp(cfg, heuristics, {
    delta: d,
    fromSha: fu.prev_head,
    files: args.files,
    fullPlan: args.fullPlan,
    ecosystem: args.ecosystem,
    styleGuide: args.styleGuide,
    ciLinters: args.ciLinters,
    // A post-approval case follows production's size rule; any other keeps
    // the answer recorded when the case was built.
    sweepOwed: (deltaLines) =>
      fu.prev_approved === true
        ? followUpSweepOwed(cfg, {
            standing: "APPROVE",
            approvalWithheld: false,
            fullLookSinceFirst: () => true,
            deltaLines,
          })
        : fu.sweep_owed,
  });
}

/**
 * The case's open prior findings as production lists them: one posted
 * `round_findings` row per finding (the exporter already collapsed re-post
 * chains), through `computePriorFindings` — so the order, the blocking flag
 * and the sort are the daemon's.
 */
export function benchPriorList(c: BenchCase): PriorFindingsList {
  const fu = c.followup;
  const rows: RoundFindingRow[] = (fu?.prior_findings ?? []).map((f, i) => ({
    id: i + 1,
    pr: c.pr,
    round_id: null,
    round_no: f.round_no,
    head_sha: fu!.prev_head,
    finding_key: f.finding_key,
    path: f.path,
    line: f.line,
    lens: f.lens_ids.join(","),
    tier: null,
    unplanned: 0,
    severity: f.severity,
    confidence: null,
    reachability: null,
    kind: null,
    disposition: "posted",
    axis: null,
    word: null,
    reason: f.reason,
    evidence: f.evidence,
    posted_as: f.posted_as,
    raised_in_round: null,
    thread_id: null,
    recorded_at: "",
    title: f.title,
    lens_ids: JSON.stringify(f.lens_ids),
  }));
  return computePriorFindings({ pr: c.pr, roundNo: fu?.round_no ?? 2, rows, checks: [] });
}

/** `{{prior_findings_note}}` for the case and its sidecar (written by the
 * caller at `sidecarPath`, which the note names). */
export function benchPriorFindings(
  c: BenchCase,
  sidecarPath: string,
): { note: string; sidecar: string; list: PriorFindingsList } {
  const list = benchPriorList(c);
  return {
    list,
    note: renderPriorFindingsNote(list, { sidecar: sidecarPath }),
    sidecar: priorSidecarText(list, c.head_commit),
  };
}
