import { canonicalLensIds } from "./lensids.js";
import type { RoundFindingInput } from "./storerows.js";

/** Semantic finding fields shared by file fallback and durable ingestion. */
export function findingRowFields(f: RoundFindingInput) {
  return {
    finding_key: f.key,
    path: f.path ?? null,
    line: f.line ?? null,
    lens: f.lens ?? "",
    tier: f.tier ?? null,
    severity: f.severity ?? null,
    confidence: f.confidence ?? null,
    reachability: f.reachability ?? null,
    kind: f.kind ?? null,
    disposition: f.disposition ?? "unknown",
    axis: f.axis ?? null,
    word: f.word ?? null,
    reason: f.reason ?? null,
    evidence: f.evidence ?? null,
    posted_as: f.posted_as ?? null,
    raised_in_round: f.raised_in_round ?? null,
    thread_id: f.thread_id ?? null,
    title: f.title ?? null,
    lens_ids: JSON.stringify(canonicalLensIds(f.lens ?? "")),
  };
}
