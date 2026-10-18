// The lesson-delivery status block — `memory.lessons` in
// status.json, and its clause in `qcr status`.
//
// A leaf on purpose, like src/learner/status.ts: src/memory/health.ts (and
// through it the TUI and the CLI) reads this shape and renders its phrase,
// and must not load the ledger (which holds the state database) to do it.
import type { MemoryDelivery } from "../config.js";

/** One match tier's share of the headline: the distinct
 * findings counted on that tier, and what humans then did with them. */
export interface LessonTierCounts {
  marks: number;
  harm: number;
  help: number;
  unknown: number;
}

/** The headline the operator reads before switching `[memory] delivery` to
 * `on`: the switch, the operator's kill switch, and the last `window_days`
 * of the shadow ledger. */
export interface LessonDeliveryStatus {
  /** `[memory] delivery` as configured. */
  delivery: MemoryDelivery;
  /** Whether lessons actually reach a prompt: `[memory]
   * delivery = "on"`, the operator's kill switch on, and a selector built
   * (memory switched on). False under `shadow`. */
  delivering: boolean;
  /** The operator's kill switch (`qcr lessons off`). */
  lessons_off: boolean;
  /** Lessons the operator suppressed one by one. */
  suppressed: number;
  window_days: number;
  /** Rounds the selector recorded in the window. */
  rounds: number;
  /** Rounds with at least one find still out at the prefetch's deadline. */
  timeouts: number;
  /** Rounds whose finds memory refused (or memory not built yet). */
  unreadable: number;
  /** Posted findings a selected dont-raise lesson would have touched — on its
   * lens and path (lens-level matching). Only the `class` tier of them is
   * what the validator would be licensed to demote (`tiers`); from a daemon
   * that predates lens-level matching they are all that. */
  marks: number;
  /** …of which humans then fixed (the lesson would have hidden a real
   * finding), refuted or set aside (it would have helped), or unknown yet. */
  harm: number;
  help: number;
  unknown: number;
  /** The same findings by match tier, each on its strongest:
   * `class` — a lesson's class matched too (what the validator's license
   * needs); `lens` — lens and path alone. They add up to the totals above.
   * Absent from a daemon that predates lens-level matching — unknown, never
   * zero. */
  tiers?: { class: LessonTierCounts; lens: LessonTierCounts };
  as_of: string;
}

function deliveryMode(s: LessonDeliveryStatus): "off" | "killed" | "on" | "inactive" | "shadow" {
  if (s.delivery === "off") return "off";
  if (s.lessons_off) return "killed";
  return s.delivering ? "on" : s.delivery === "on" ? "inactive" : "shadow";
}

/** The TUI section's short mode label, with the same precedence as its headline. */
export function lessonSectionTitle(s: LessonDeliveryStatus): string {
  const mode = deliveryMode(s);
  if (mode === "off") return "LESSONS (delivery off)";
  if (mode === "killed") return "LESSONS (kill switch OFF)";
  return `LESSONS (${mode === "inactive" ? "on — nothing delivered" : mode}, ${s.window_days}d)`;
}

/** The headline as one phrase — the `qcr status` clause without its "; ",
 * and the first line the TUI's feedback tab paints. UNKNOWN when the daemon
 * could not read its ledger (null): never "nothing happened". */
export function lessonHeadline(s: LessonDeliveryStatus | null): string {
  if (s === null) return "lessons UNKNOWN (the daemon could not read its lesson ledger)";
  const delivery = deliveryMode(s);
  if (delivery === "off") return "lessons delivery off";
  const supp = s.suppressed > 0 ? `, ${s.suppressed} suppressed` : "";
  if (delivery === "killed") return `LESSONS OFF (operator kill switch)${supp}`;
  const mode = delivery === "inactive" ? "on (nothing delivered — memory is off)" : delivery;
  const time = s.timeouts > 0 ? `, ${s.timeouts} prefetch timeouts` : "";
  const unread = s.unreadable > 0 ? `, ${s.unreadable} unreadable` : "";
  // The total holds lens-tier findings too, which the validator's license
  // never reaches — so it is "marked", and "would-demote" belongs to the
  // class tier on the tier line. A daemon without tiers marked on the class
  // alone: its total is what the license would demote.
  const label = s.tiers === undefined ? "would-demote" : "marked";
  return (
    `lessons ${mode} ${s.window_days}d: ${s.rounds} rounds${time}${unread}, ` +
    `${outcomePhrase(label, s)}${supp}`
  );
}

function outcomePhrase(label: string, t: LessonTierCounts): string {
  return `${t.marks} ${label} (harm ${t.harm}, help ${t.help}, unknown ${t.unknown})`;
}

/**
 * The marked findings split by match tier — the second line the
 * TUI's feedback tab paints, and the tail of the `qcr status` clause. The
 * class tier is the would-demote one (what the validator's `lesson-shape`
 * license reaches); the lens tier is evidence only. Null where the headline
 * counts nothing (no status, delivery off, the kill switch off); UNKNOWN from
 * a daemon without tiers — a missing split is never painted as an empty
 * one.
 */
export function lessonTierLine(s: LessonDeliveryStatus | null): string | null {
  if (s === null || s.delivery === "off" || s.lessons_off) return null;
  if (s.tiers === undefined)
    return "by tier: UNKNOWN (this daemon predates lens-level matching)";
  return (
    `by tier: class ${outcomePhrase("would-demote", s.tiers.class)} · ` +
    `lens ${outcomePhrase("evidence only", s.tiers.lens)}`
  );
}

/** `qcr status`'s clause for the lesson block: "" from a daemon that does not
 * report it; UNKNOWN when the daemon could not read its ledger — a dropped
 * clause would read as "nothing happened". */
export function lessonDeliveryPhrase(s: LessonDeliveryStatus | null | undefined): string {
  if (s === undefined) return "";
  const tiers = lessonTierLine(s);
  return `; ${lessonHeadline(s)}${tiers === null ? "" : ` — ${tiers}`}`;
}
