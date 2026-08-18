// Severity → posting-tag mapping (spec §5): P0/P1 → [blocker]; P2 → [blocker]
// iff confidence ≥ 0.8 else [question]; P3 → [question] (or [nit] when the
// finding is a nit-class polish item). Nits and questions never block.

import type { Verdict as VerdictType } from "./types.js";

export type Severity = "P0" | "P1" | "P2" | "P3" | "nit";
export type PostTag = "blocker" | "question" | "nit";

export function postTag(severity: Severity, confidence: number): PostTag {
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
