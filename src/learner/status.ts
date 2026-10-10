// The learner's status block — `memory.curation` in status.json.
//
// A LEAF on purpose: src/memory/health.ts (and through it the TUI and the
// CLI) reads this shape and renders its phrase, and must not load the learner
// (which holds the state database) to do it.
import type { LessonBalance } from "../memory/lessons.js";

/** One curation failure nothing has made good yet. */
export interface UnresolvedCuration {
  day: string;
  state: "missing" | "not_persisted";
  /** `missing`: the candidates the day's packet offered; `not_persisted`:
   * the day's lessons still not in memory. */
  count: number;
  /** When it became a failure: the receipt's deadline for `missing`, the
   * first refusal or unfound adoption for `not_persisted`. */
  since: string;
}

/** The curation as status.json `memory.curation` carries it: the newest
 * UNRESOLVED failure when there is one, else the latest EOD day's. */
export interface CurationStatus {
  /** The day reported: the newest unresolved failure's, else the latest ops
   * day a packet was written for; null before the first. */
  day: string | null;
  /**
   *  `no_packet`     — no packet yet (a fresh install);
   *  `packet_ready`  — written, the sweep not delivered yet;
   *  `nothing`       — delivered with nothing to decide (no receipt owed);
   *  `awaiting`      — delivered, the receipt not due yet;
   *  `missing`       — no receipt `receipt_wait_min` after delivery (WOKEN),
   *                    and none since for that day or a later one;
   *  `not_persisted` — receipted, but a claimed lesson is not in memory or a
   *                    write was refused (WOKEN), and that candidate is still
   *                    undecided;
   *  `received`      — receipted, every adoption so far found.
   *  The two WOKEN states stay reported until made good — the next day's
   *  packet does not clear them.
   */
  state:
    | "no_packet"
    | "packet_ready"
    | "nothing"
    | "awaiting"
    | "missing"
    | "not_persisted"
    | "received";
  offered: number;
  adopted: number;
  declined: number;
  /** Adoptions claimed but memory not checked yet. */
  verifying: number;
  /** Adoptions memory does not hold, and writes the curator reported refused. */
  not_persisted: number;
  expired_today: number;
  /** Every candidate still undecided (offered ones), and the queued ones. */
  open: number;
  queued: number;
  receipt_at: string | null;
  /** The look-for : don't-raise balance of the lessons in force, and when it
   * was read; null until memory has been read (UNKNOWN, never zero). */
  balance: (LessonBalance & { as_of: string }) | null;
  /** Every unresolved failure, newest first (the last 30 curation days).
   * Absent from a daemon that predates it. */
  unresolved?: UnresolvedCuration[];
  /** The OLDEST unresolved failure — the incident one tracker ticket is filed
   * for (keyed by its state and day, dated by `since`); null when none. */
  incident?: UnresolvedCuration | null;
}

/** " (+N earlier unresolved day(s))" when more than the reported day is
 * unresolved; "" otherwise. */
export function earlierPhrase(c: CurationStatus): string {
  const more = new Set((c.unresolved ?? []).map((u) => u.day));
  if (c.day !== null) more.delete(c.day);
  return more.size > 0
    ? ` (+${more.size} earlier unresolved day${more.size === 1 ? "" : "s"})`
    : "";
}

/** `qcr status`'s clause for the curation block: "" when there is nothing to
 * say (and from a daemon that does not report it); UNKNOWN when the daemon
 * could not read its ledger — a dropped clause would read as "all well". */
export function curationPhrase(c: CurationStatus | null | undefined): string {
  if (c === undefined) return "";
  if (c === null) return "; EOD curation UNKNOWN (the daemon could not read its ledger)";
  const bal = c.balance
    ? `; lessons look-for:dont-raise ${c.balance.look_for}:${c.balance.dont_raise}`
    : "";
  switch (c.state) {
    case "missing":
      return `; EOD CURATION MISSING for ${c.day} (${c.offered} candidates, no receipt)${earlierPhrase(c)}${bal}`;
    case "not_persisted":
      return `; EOD LESSONS NOT PERSISTED for ${c.day} (${c.not_persisted})${earlierPhrase(c)}${bal}`;
    case "no_packet":
      return bal;
    default:
      return `; EOD curation ${c.day} ${c.state.replace("_", " ")}${c.open + c.queued > 0 ? ` (${c.open} open, ${c.queued} queued)` : ""}${bal}`;
  }
}

/** Is this curation state one a person must hear about (the board banner,
 * the desktop notification)? */
export function curationNeedsAttention(c: CurationStatus | null | undefined): boolean {
  return !!c && (c.state === "missing" || c.state === "not_persisted");
}
