// Severity → posting-tag mapping (spec §5): P0/P1 → [blocker]; P2 → [blocker]
// iff confidence ≥ 0.8 else [question]; P3 → [question] (or [nit] when the
// finding is a nit-class polish item). Nits and questions never block.

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

export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "ESCALATE";

export interface VerdictInput {
  hasBlockers: boolean;
  escalationWorthy: boolean;
  selfEscalated: boolean;
}

/** Verdict logic (spec §5): any [blocker] ⇒ REQUEST_CHANGES; escalation
 * criteria or self-escalation ⇒ ESCALATE; else APPROVE. */
export function deriveVerdict(v: VerdictInput): Verdict {
  if (v.hasBlockers) return "REQUEST_CHANGES";
  if (v.escalationWorthy || v.selfEscalated) return "ESCALATE";
  return "APPROVE";
}
