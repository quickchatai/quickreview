/**
 * Required passes: the rows a round may not post without.
 *
 * The plan builder marks them (`PassPlanEntry.required`, `buildPassPlan` in
 * dispatch.ts): pass-baseline, every row of a split baseline, the risk
 * passes outside the security family, and the exploit chain's `delta` row.
 * This module answers one question over the round's recorded plan
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
 *
 * A row that runs one strategy of its lens (the exploit chain's `delta`,
 * `forward`, …: one agent, one row per strategy) is its own obligation,
 * keyed `<lens>:<strategy>`, and only executions launched for that strategy
 * (`LiveAgentProgress.strategy`, from the task file's name) count for it: a
 * completed `forward` never covers a failed `delta`. A row with no strategy
 * counts every execution of its lens, as before.
 *
 * `failedSecurityRows` reads the same evidence for the security family's
 * rows, required or not: the ones that failed and never completed are what
 * the review body names as not completed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  lensForAgent,
  parseRoundProgress,
  type RoundProgressSnapshot,
} from "@quickchatai/pi-quickreview/src/round-progress.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import type { PassPlanEntry } from "@quickchatai/pi-quickreview/src/types.js";

export interface MissingPass {
  lens: string;
  /** The row's strategy, on a lens that runs one row per strategy. */
  strategy?: string;
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

/** The key a row is counted under: its lens, or `<lens>:<strategy>` on a
 * row that runs one strategy of its lens. A lens name never holds a `:`. */
export function rowKey(row: { lens: string; strategy?: string | undefined }): string {
  return row.strategy !== undefined ? `${row.lens}:${row.strategy}` : row.lens;
}

function keyParts(key: string): { lens: string; strategy?: string } {
  const at = key.indexOf(":");
  return at < 0 ? { lens: key } : { lens: key.slice(0, at), strategy: key.slice(at + 1) };
}

/** The required rows of a plan, by `rowKey`, each with its row count. */
export function requiredRows(plan: readonly PassPlanEntry[]): Map<string, number> {
  return countRows(plan.filter((row) => row.required === true));
}

function countRows(plan: readonly PassPlanEntry[]): Map<string, number> {
  const rows = new Map<string, number>();
  for (const row of plan) rows.set(rowKey(row), (rows.get(rowKey(row)) ?? 0) + 1);
  return rows;
}

/** The executions that answer for one counted row in one phase: its lens's
 * (any tier), launched from that phase's task directory, and — for a
 * strategy row — launched for that strategy. */
function runsFor(
  progress: RoundProgressSnapshot,
  key: string,
  phase: "plan" | "sweep" | "post",
): RoundProgressSnapshot["agents"] {
  const { lens, strategy } = keyParts(key);
  return progress.agents.filter(
    (a) =>
      lensForAgent(a.agent) === lens &&
      (strategy === undefined || a.strategy === strategy) &&
      (phase === "plan" ? a.phase === undefined || a.phase === "plan" : a.phase === phase),
  );
}

/** The counted rows that failed and never completed, in one phase. */
function gapsOf(
  progress: RoundProgressSnapshot,
  obligations: ReadonlyMap<string, number>,
  phase: "plan" | "sweep" | "post",
): Array<Omit<MissingPass, "phase">> {
  const out: Array<Omit<MissingPass, "phase">> = [];
  for (const [key, rows] of obligations) {
    const runs = runsFor(progress, key, phase);
    const completed = runs.filter((a) => a.status === "completed").length;
    const failedRuns = runs.filter((a) => a.status === "failed");
    if (failedRuns.length > 0 && completed < rows)
      out.push({
        ...keyParts(key),
        rows,
        completed,
        failed: failedRuns.length,
        errors: failedRuns.map((a) => a.error ?? "failed"),
      });
  }
  return out;
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
  const missing: MissingPass[] = [
    ...gapsOf(progress, required, "plan"),
    ...gapsOf(progress, sweepRequired, "sweep").map((m) => ({ ...m, phase: "sweep" as const })),
  ];
  return missing.length > 0 ? { state: "missing", missing } : { state: "complete" };
}

/** A security-family row that failed and never completed. */
export interface FailedSecurityRow {
  lens: string;
  strategy?: string;
  /** The failed executions' error texts. */
  errors: string[];
}

/** What the round's evidence says of its security-family rows: `known`
 * with the rows that failed and never completed (empty when none did, or the
 * plan has no family row), or `unknown` when there are family rows and no
 * snapshot of this round to read — never an empty `known`, which would read
 * as "every security pass completed". */
export type SecurityRowFailures =
  { state: "known"; failed: FailedSecurityRow[] } | { state: "unknown"; reason: string };

/**
 * The security-family rows of a round that failed and never completed —
 * required or not (only the chain's `delta` is required; the others never
 * hold the post back, so the review body says which did not complete). The
 * rule is `requiredPassGap`'s, row by row and strategy by strategy, over the
 * plan's rows and the post-discovery rows (`post_plan`, launched from
 * `tasks-post`).
 */
export function failedSecurityRows(
  plan: readonly PassPlanEntry[] | null,
  progress: RoundProgressSnapshot | undefined,
  roundNo: number,
  postPlan?: readonly PassPlanEntry[] | null,
): SecurityRowFailures {
  const family = (rows: readonly PassPlanEntry[] | null | undefined) =>
    countRows((rows ?? []).filter((row) => SECURITY_FAMILY.includes(row.lens)));
  const planned = family(plan);
  const post = family(postPlan);
  if (planned.size === 0 && post.size === 0) return { state: "known", failed: [] };
  if (!progress) return { state: "unknown", reason: "no readable round-progress snapshot" };
  if (progress.round_no !== roundNo)
    return {
      state: "unknown",
      reason: `round-progress snapshot is for round ${progress.round_no ?? "?"}, not ${roundNo}`,
    };
  return {
    state: "known",
    failed: [...gapsOf(progress, planned, "plan"), ...gapsOf(progress, post, "post")].map(
      ({ lens, strategy, errors }) => ({
        lens,
        ...(strategy !== undefined ? { strategy } : {}),
        errors,
      }),
    ),
  };
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
        `${m.phase === "sweep" ? "sweep " : ""}${rowKey(m)} (${m.completed}/${m.rows} completed, ${m.failed} failed: ${m.errors.join("; ")})`,
    )
    .join(", ");
}
