// Severity → posting-tag mapping (spec §5): P0/P1 → [blocker]; P2 → [blocker]
// iff confidence ≥ 0.8 else [question]; P3 → [question] (or [nit] when the
// finding is a nit-class polish item). Nits and questions never block.
//
// adds a third axis, `reachability` — how often the triggering state
// actually arises, as opposed to how bad it is (severity) or whether the claim
// is true (confidence). It is applied as a gate BEFORE the severity mapping and
// can only ever weaken a tag: `contrived` never blocks at any severity,
// `plausible` demotes P2 to a question, `routine` (and an absent field) leaves
// the mapping exactly as it was. The blocker bar itself does not move — a
// `routine` P0/P1 blocks today as it always did.

import type { Verdict as VerdictType } from "./types.js";

export type Severity = "P0" | "P1" | "P2" | "P3" | "nit";
export type PostTag = "blocker" | "question" | "nit";

/** How often the state a finding depends on actually arises. */
export type Reachability = "routine" | "plausible" | "contrived";

export const REACHABILITY_VALUES: readonly Reachability[] = ["routine", "plausible", "contrived"];

/** Findings that omit the axis are read as `routine` — the legacy
 * behaviour, so an un-upgraded pass can never accidentally soften a blocker. */
export function normalizeReachability(value: string | undefined | null): Reachability {
  return REACHABILITY_VALUES.includes(value as Reachability) ? (value as Reachability) : "routine";
}

export function postTag(severity: Severity, confidence: number, reachability?: Reachability | null): PostTag {
  const reach = normalizeReachability(reachability);
  // Reachability gate — never blocks something the base mapping wouldn't.
  if (reach === "contrived") return severity === "nit" ? "nit" : "question";
  if (reach === "plausible" && severity === "P2") return "question";
  switch (severity) {
    case "P0":
    case "P1":
      return "blocker";
    case "P2":
      return confidence >= 0.8 ? "blocker" : "question";
    case "P3":
      return "question";
    case "nit":
      return "nit";
  }
}

export type { Verdict } from "./types.js";

export interface VerdictInput {
  hasBlockers: boolean;
  /** The session's own "I cannot decide this" call. Since the escalation
   * heuristic was scrapped (2026-08-18) this is the ONLY input that parks a
   * PR — no daemon-side criteria feed it. */
  needsHuman: boolean;
}

/** Verdict logic: any [blocker] ⇒ REQUEST_CHANGES; the session cannot decide
 * ⇒ NEEDS_HUMAN; else APPROVE. */
export function deriveVerdict(v: VerdictInput): VerdictType {
  if (v.hasBlockers) return "REQUEST_CHANGES";
  if (v.needsHuman) return "NEEDS_HUMAN";
  return "APPROVE";
}
