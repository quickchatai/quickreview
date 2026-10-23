/**
 * Required passes: the rows a round may not post without.
 *
 * The plan builder marks them (`PassPlanEntry.required`, `buildPassPlan` in
 * dispatch.ts): pass-baseline, every row of a split baseline, and the risk
 * passes. This module answers one question over the round's recorded plan
 * and its live round-progress snapshot: did a required pass FAIL and never
 * complete? Only positive evidence counts — a snapshot that is missing,
 * unreadable or belongs to another round is UNKNOWN, never a gap, so broken
 * telemetry cannot wedge posting.
 *
 * Two readers, one rule:
 *  - the session's posting route (`scripts/required-passes.py`, called by
 *    post-review.sh and approve-pr.sh before anything is queued or sent)
 *    refuses to post while a required pass is missing;
 *  - the daemon's verdict apply (`verdicts.ts`) requeues such a round within
 *    `max_self_requeues` instead of applying its verdict.
 * `tests/required-passes.test.ts` runs the Python copy against this one.
 *
 * Each task-directory phase owns its required rows independently. A sweep
 * completion cannot repair a plan failure, or vice versa; unclassified legacy
 * executions keep their original plan interpretation.
 * The rule per required lens in one phase: it is MISSING when at least one of its
 * executions failed and fewer executions completed than the plan has rows
 * for it. A session that relaunched the failed pass and got a return is
 * whole again; a still-running pass is not a gap (nothing has failed yet).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lensForAgent, parseRoundProgress, type RoundProgressSnapshot } from "./round-progress.js";
import type { PassPlanEntry } from "./types.js";

export interface MissingPass {
  lens: string;
  phase?: "sweep";
  /** Plan rows for this lens. */
  rows: number;
  completed: number;
  failed: number;
  /** The failed executions' error texts (a timeout names itself). */
  errors: string[];
}

export type RequiredPassGap =
  | { state: "complete" }
  | { state: "missing"; missing: MissingPass[] }
  | { state: "unknown"; reason: string };

/** The required lenses of a plan, each with its row count. */
export function requiredRows(plan: readonly PassPlanEntry[]): Map<string, number> {
  const rows = new Map<string, number>();
  for (const row of plan)
    if (row.required === true) rows.set(row.lens, (rows.get(row.lens) ?? 0) + 1);
  return rows;
}

/** The pure rule (see the module header). */
export function requiredPassGap(
  plan: readonly PassPlanEntry[] | null,
  progress: RoundProgressSnapshot | undefined,
  roundNo: number,
  sweepPlan?: readonly PassPlanEntry[] | null,
): RequiredPassGap {
  const required = requiredRows(plan ?? []);
  const sweepRequired = requiredRows(sweepPlan ?? []);
  if (required.size === 0 && sweepRequired.size === 0) return { state: "complete" };
  if (!progress) return { state: "unknown", reason: "no readable round-progress snapshot" };
  if (progress.round_no !== roundNo)
    return {
      state: "unknown",
      reason: `round-progress snapshot is for round ${progress.round_no ?? "?"}, not ${roundNo}`,
    };
  const missing: MissingPass[] = [];
  for (const [phase, obligations] of [
    ["plan", required],
    ["sweep", sweepRequired],
  ] as const) {
    for (const [lens, rows] of obligations) {
      const runs = progress.agents.filter(
        (a) =>
          lensForAgent(a.agent) === lens &&
          (phase === "sweep" ? a.phase === "sweep" : a.phase === undefined || a.phase === "plan"),
      );
      const completed = runs.filter((a) => a.status === "completed").length;
      const failedRuns = runs.filter((a) => a.status === "failed");
      if (failedRuns.length > 0 && completed < rows)
        missing.push({
          lens,
          ...(phase === "sweep" ? { phase } : {}),
          rows,
          completed,
          failed: failedRuns.length,
          errors: failedRuns.map((a) => a.error ?? "failed"),
        });
    }
  }
  return missing.length > 0 ? { state: "missing", missing } : { state: "complete" };
}

/** Every failed pass execution in a round's snapshot — the round's gap
 * record, required or not. Empty for a snapshot of another round. */
export function failedPasses(
  progress: RoundProgressSnapshot | undefined,
  roundNo: number,
): Array<{ agent: string; error: string }> {
  if (!progress || progress.round_no !== roundNo) return [];
  return progress.agents
    .filter((a) => a.status === "failed")
    .map((a) => ({ agent: a.agent, error: a.error ?? "failed" }));
}

/** The live snapshot of one PR's session, or undefined when unreadable. */
export function readRoundProgress(root: string, pr: number): RoundProgressSnapshot | undefined {
  try {
    return parseRoundProgress(
      readFileSync(join(root, "state", "round-progress", `pr-${pr}.json`), "utf8"),
    );
  } catch {
    return undefined;
  }
}

/** A round row's recorded plan, or null when absent or unreadable. */
export function parsePlan(raw: string | null): PassPlanEntry[] | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((r) => typeof r === "object" && r !== null)
      ? (value as PassPlanEntry[])
      : null;
  } catch {
    return null;
  }
}

/** One line naming what is missing — the requeue's reason and the event. */
export function describeGap(missing: readonly MissingPass[]): string {
  return missing
    .map(
      (m) =>
        `${m.phase === "sweep" ? "sweep " : ""}${m.lens} (${m.completed}/${m.rows} completed, ${m.failed} failed: ${m.errors.join("; ")})`,
    )
    .join(", ");
}
