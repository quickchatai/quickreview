// The lesson-delivery status block (S9a) — `memory.lessons` in
// status.json, and its clause in `qcr status`.
//
// A LEAF on purpose, like src/learner/status.ts: src/memory/health.ts (and
// through it the TUI and the CLI) reads this shape and renders its phrase,
// and must not load the ledger (which holds the state database) to do it.
import type { MemoryDelivery } from "../config.js";

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
  /** Posted findings a selected dont-raise lesson would have touched. */
  marks: number;
  /** …of which humans then FIXED (the lesson would have hidden a real
   * finding), refuted or set aside (it would have helped), or unknown yet. */
  harm: number;
  help: number;
  unknown: number;
  as_of: string;
}

/** The headline as one phrase — the `qcr status` clause without its "; ",
 * and the line the TUI's feedback tab paints. UNKNOWN when the daemon could
 * not read its ledger (null): never "nothing happened". */
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
  return (
    `lessons ${mode} ${s.window_days}d: ${s.rounds} rounds${time}${unread}, ` +
    `${s.marks} would-demote (harm ${s.harm}, help ${s.help}, unknown ${s.unknown})${supp}`
  );
}

/** `qcr status`'s clause for the lesson block: "" from a daemon that does not
 * report it; UNKNOWN when the daemon could not read its ledger — a dropped
 * clause would read as "nothing happened". */
export function lessonDeliveryPhrase(s: LessonDeliveryStatus | null | undefined): string {
  if (s === undefined) return "";
  return `; ${lessonHeadline(s)}`;
}
