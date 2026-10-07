// The lesson-delivery status block (S9a) — `memory.lessons` in
// status.json, and its clause in `qcr status`.
//
// A LEAF on purpose, like src/learner/status.ts: src/memory/health.ts (and
// through it the TUI and the CLI) reads this shape and renders its phrase,
// and must not load the ledger (which holds the state database) to do it.
import type { MemoryDelivery } from "../config.js";

/** One match tier's share of the headline (R9): the distinct
 * findings counted on that tier, and what humans then did with them. */
export interface LessonTierCounts {
  marks: number;
  harm: number;
  help: number;
  unknown: number;
}

/** The headline the owner reads before switching `[memory] delivery` to
 * `on`: the switch, the operator's kill switch, and the last `window_days`
 * of the shadow ledger. */
export interface LessonDeliveryStatus {
  /** `[memory] delivery` as configured. */
  delivery: MemoryDelivery;
  /** Whether lessons actually reach a prompt (S9b): `[memory]
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
   * lens and path, the lens-level matching of the owner's ruling R9. Only
   * the `class` tier of them is what the validator would be licensed to
   * demote (`tiers`); from a daemon that predates R9 they are all that. */
  marks: number;
  /** …of which humans then FIXED (the lesson would have hidden a real
   * finding), refuted or set aside (it would have helped), or unknown yet. */
  harm: number;
  help: number;
  unknown: number;
  /** The same findings by match tier (R9), each on its strongest:
   * `class` — a lesson's class matched too (what the validator's license
   * needs); `lens` — lens and path alone. They add up to the totals above.
   * Absent from a daemon that predates R9 — UNKNOWN, never zero. */
  tiers?: { class: LessonTierCounts; lens: LessonTierCounts };
  as_of: string;
}

/** The headline as one phrase — the `qcr status` clause without its "; ",
 * and the first line the TUI's feedback tab paints. UNKNOWN when the daemon
 * could not read its ledger (null): never "nothing happened". */
export function lessonHeadline(s: LessonDeliveryStatus | null): string {
  if (s === null) return "lessons UNKNOWN (the daemon could not read its lesson ledger)";
  if (s.delivery === "off") return "lessons delivery off";
  const supp = s.suppressed > 0 ? `, ${s.suppressed} suppressed` : "";
  if (s.lessons_off) return `LESSONS OFF (operator kill switch)${supp}`;
  const mode = s.delivering
    ? "on"
    : s.delivery === "on"
      ? "on (nothing delivered — memory is off)"
      : "shadow";
  const time = s.timeouts > 0 ? `, ${s.timeouts} prefetch timeouts` : "";
  const unread = s.unreadable > 0 ? `, ${s.unreadable} unreadable` : "";
  // Since R9 the total holds lens-tier findings too, which the validator's
  // license never reaches — so it is "marked", and "would-demote" belongs to
  // the class tier on the tier line. A daemon that predates R9 marked on the
  // class alone: its total IS what the license would demote.
  const label = s.tiers === undefined ? "would-demote" : "marked";
  return (
    `lessons ${mode} ${s.window_days}d: ${s.rounds} rounds${time}${unread}, ` +
    `${s.marks} ${label} (harm ${s.harm}, help ${s.help}, unknown ${s.unknown})${supp}`
  );
}

function tierPhrase(name: string, label: string, t: LessonTierCounts): string {
  return `${name} ${t.marks} ${label} (harm ${t.harm}, help ${t.help}, unknown ${t.unknown})`;
}

/**
 * The marked findings split by match tier (R9) — the second line the
 * TUI's feedback tab paints, and the tail of the `qcr status` clause. The
 * class tier is the would-demote one (what the validator's `lesson-shape`
 * license reaches); the lens tier is evidence only. Null where the headline
 * counts nothing (no status, delivery off, the kill switch off); UNKNOWN from
 * a daemon that predates R9 — a missing split is never painted as an empty
 * one.
 */
export function lessonTierLine(s: LessonDeliveryStatus | null): string | null {
  if (s === null || s.delivery === "off" || s.lessons_off) return null;
  if (s.tiers === undefined)
    return "by tier: UNKNOWN (this daemon predates lens-level matching, R9)";
  return (
    `by tier: ${tierPhrase("class", "would-demote", s.tiers.class)} · ` +
    tierPhrase("lens", "evidence only", s.tiers.lens)
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
