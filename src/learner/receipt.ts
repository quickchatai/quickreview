// The EOD curation receipt (S8) — the schema of the
// `eod-curation-receipt` overseer command, as a leaf so the command whitelist
// (src/commands.ts) can validate it without loading the learner.
//
// WHY A RECEIPT. For 30 days (2026-09-03..10-02) the EOD curator "wrote" its
// lessons into a memory that refused every write, and said so only in digests
// nobody read: 0 lessons persisted, nothing alerted. The receipt makes the
// curator's work a fact the daemon can check: per candidate it was handed, the
// curator says `adopted` (and wrote a typed lesson citing it), `declined` (with
// a reason) or `refused` (the write failed — with the error). The daemon then
// VERIFIES every adoption against memory (a lesson header citing the
// candidate), wakes `eod_lessons_not_persisted` for a refused or missing
// write, and `eod_curation_missing` when no receipt comes at all.
//
// STRICT, like every command: unknown fields are a rejection, at the top level
// and inside each decision.

export const RECEIPT_DECISIONS = ["adopted", "declined", "refused"] as const;
export type ReceiptDecisionKind = (typeof RECEIPT_DECISIONS)[number];

/** Caps: a day's packet offers at most a few dozen candidates; a receipt this
 * large is a mistake, not a day's work. */
export const RECEIPT_LIMITS = Object.freeze({
  decisions: 200,
  candidatesPerDecision: 200,
  reasonChars: 1000,
  lessonChars: 300,
});

export interface ReceiptDecision {
  /** Learner candidate ids (`c42` in the packet). */
  candidates: number[];
  decision: ReceiptDecisionKind;
  /** Required for `declined` and `refused`. */
  reason?: string;
  /** The lesson's URI, when the curator names it (`adopted` only). */
  lesson?: string;
}

export interface CurationReceipt {
  /** The ops day whose packet this curates (`YYYY-MM-DD`). */
  day: string;
  decisions: ReceiptDecision[];
}

/** `c42` / `42` / 42 → 42; anything else null. */
export function candidateIdOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === "string") {
    const m = /^c?(\d{1,12})$/i.exec(v.trim());
    if (m) {
      const n = Number(m[1]);
      return n > 0 ? n : null;
    }
  }
  return null;
}

/** The packet's spelling of a candidate id. */
export function candidateLabel(id: number): string {
  return `c${id}`;
}

export type ReceiptValidation =
  { ok: true; receipt: CurationReceipt } | { ok: false; reason: string };

/**
 * Validate the payload of an `eod-curation-receipt` command (the envelope's
 * `command` field excluded). Every decision names at least one candidate; no
 * candidate appears in two decisions; `declined` and `refused` carry a reason;
 * only `adopted` may name a lesson. An empty `decisions` list is allowed — a
 * curator confirming it had nothing to decide.
 */
export function validateReceipt(obj: Record<string, unknown>): ReceiptValidation {
  const unknownTop = Object.keys(obj).filter(
    (k) => k !== "command" && k !== "day" && k !== "decisions",
  );
  if (unknownTop.length > 0)
    return { ok: false, reason: `unknown field(s): ${unknownTop.join(", ")}` };
  const day = obj["day"];
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    return { ok: false, reason: "'day' must be the packet's ops day, YYYY-MM-DD" };
  const raw = obj["decisions"];
  if (!Array.isArray(raw))
    return {
      ok: false,
      reason: "'decisions' must be a list of {candidates, decision, reason?, lesson?}",
    };
  if (raw.length > RECEIPT_LIMITS.decisions)
    return {
      ok: false,
      reason: `'decisions' has ${raw.length} entries; at most ${RECEIPT_LIMITS.decisions}`,
    };
  const seen = new Set<number>();
  const decisions: ReceiptDecision[] = [];
  for (const [i, d] of raw.entries()) {
    const at = `decisions[${i}]`;
    if (!d || typeof d !== "object" || Array.isArray(d))
      return { ok: false, reason: `${at} must be an object` };
    const o = d as Record<string, unknown>;
    const unknown = Object.keys(o).filter(
      (k) => !["candidates", "decision", "reason", "lesson"].includes(k),
    );
    if (unknown.length > 0)
      return { ok: false, reason: `${at}: unknown field(s): ${unknown.join(", ")}` };
    const kind = o["decision"];
    if (typeof kind !== "string" || !(RECEIPT_DECISIONS as readonly string[]).includes(kind))
      return { ok: false, reason: `${at}.decision must be one of ${RECEIPT_DECISIONS.join(", ")}` };
    const cands = o["candidates"];
    if (!Array.isArray(cands) || cands.length === 0)
      return {
        ok: false,
        reason: `${at}.candidates must name at least one candidate id (e.g. "c42")`,
      };
    if (cands.length > RECEIPT_LIMITS.candidatesPerDecision)
      return {
        ok: false,
        reason: `${at}.candidates names ${cands.length}; at most ${RECEIPT_LIMITS.candidatesPerDecision}`,
      };
    const ids: number[] = [];
    for (const c of cands) {
      const id = candidateIdOf(c);
      if (id === null)
        return {
          ok: false,
          reason: `${at}.candidates: '${String(c)}' is not a candidate id (e.g. "c42")`,
        };
      if (seen.has(id))
        return { ok: false, reason: `candidate c${id} appears in more than one decision` };
      seen.add(id);
      ids.push(id);
    }
    const reason = o["reason"];
    if (
      reason !== undefined &&
      (typeof reason !== "string" || reason.length > RECEIPT_LIMITS.reasonChars)
    )
      return {
        ok: false,
        reason: `${at}.reason must be a string of at most ${RECEIPT_LIMITS.reasonChars} characters`,
      };
    if (
      (kind === "declined" || kind === "refused") &&
      (typeof reason !== "string" || reason.trim() === "")
    )
      return {
        ok: false,
        reason: `${at}: a '${kind}' decision needs a 'reason' (${kind === "declined" ? "why not a lesson" : "the write's error"})`,
      };
    const lesson = o["lesson"];
    if (lesson !== undefined) {
      if (kind !== "adopted")
        return { ok: false, reason: `${at}.lesson is only for an 'adopted' decision` };
      if (
        typeof lesson !== "string" ||
        lesson.trim() === "" ||
        lesson.length > RECEIPT_LIMITS.lessonChars
      )
        return { ok: false, reason: `${at}.lesson must be the lesson's viking:// URI` };
    }
    decisions.push({
      candidates: ids,
      decision: kind as ReceiptDecisionKind,
      ...(typeof reason === "string" && reason.trim() !== "" ? { reason: reason.trim() } : {}),
      ...(typeof lesson === "string" ? { lesson: lesson.trim() } : {}),
    });
  }
  return { ok: true, receipt: { day, decisions } };
}
