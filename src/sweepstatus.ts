// The pre-approval sweep's recorded status (docs/follow-up-rounds.md)
// — a pure leaf, so the verdict tail (verdicts.ts) and the bench's follow-up
// replay (src/bench/runner.ts, which may not import verdicts.ts) read a
// session's sweep report one way.

/** What became of a follow-up round's pre-approval sweep
 * (`rounds.sweep_status`). */
export type SweepStatus = "ran" | "not_owed" | "not_reached" | "skipped" | "unknown";

/**
 * The sweep status a follow-up round's verdict earns. `ran` only
 * when the session CLAIMED it and its executed telemetry carries sweep-phase
 * passes; every contradiction or gap is `unknown` with a note — never `ran`,
 * because a run sweep is a full look and an unknown one must stay owed. Pure.
 *
 * `sweepPasses`: the count of executed `phase: "sweep"` entries, null when the
 * verdict carried no usable pass telemetry. `verdict`: the round's decided
 * verdict — `not_reached` means "decided REQUEST_CHANGES first", so an
 * APPROVE claiming it (or `not_owed` beside an owed sweep) is a
 * contradiction, recorded `unknown`.
 */
export function sweepStatusOf(args: {
  owed: boolean;
  claim: "ran" | "not_owed" | "not_reached" | "skipped" | null;
  sweepPasses: number | null;
  receiptSettled: boolean;
  verdict?: string | null;
}): { status: SweepStatus; note?: string } {
  const { owed, claim, sweepPasses, receiptSettled } = args;
  const executed = sweepPasses !== null && sweepPasses > 0;
  if (!owed) {
    return claim === "ran" || executed
      ? {
          status: "not_owed",
          note: `the order carried no sweep, yet ${claim === "ran" ? "the session claimed one ran" : `${sweepPasses} sweep-phase passes executed`}`,
        }
      : { status: "not_owed" };
  }
  if (receiptSettled)
    return { status: "unknown", note: "settled from the posting receipt — no sweep telemetry" };
  if (claim === "ran") {
    if (executed) return { status: "ran" };
    return {
      status: "unknown",
      note:
        sweepPasses === null
          ? "claimed ran, but the executed passes are unknown"
          : "claimed ran, but no sweep-phase pass executed",
    };
  }
  if (executed)
    return {
      status: "unknown",
      note: `${sweepPasses} sweep-phase passes executed, but the claim is ${claim ?? "absent"}`,
    };
  // The session decided the owed sweep was not needed (`follow_up_extent
  // = "session"`) — a decision with its reason, recorded as such. Never a full
  // look: a later round that owes the sweep still owes it.
  if (claim === "skipped") return { status: "skipped" };
  if (args.verdict === "APPROVE" && (claim === "not_reached" || claim === "not_owed"))
    return {
      status: "unknown",
      note: `the round approved, yet claims the owed sweep was ${claim}`,
    };
  if (claim === "not_reached") return { status: "not_reached" };
  if (claim === "not_owed")
    return { status: "not_reached", note: "claimed not_owed, but the order carried a sweep" };
  return { status: "unknown", note: "no sweep claim in the verdict" };
}
