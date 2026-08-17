// Slack concierge caps + cooldowns (slice S2).
//
// Every limit here is enforced in DAEMON CODE, never by prompt: a session (or
// an operator) may ask the concierge to speak, this module decides whether it
// may. Nothing in this file performs I/O or talks to Slack — it is pure
// decision logic over the sqlite ledgers in src/state.ts plus [slack.policy].
//
// Windows:
//   * turn + post caps are **Warsaw-day** windows, DST-correct, derived from
//     the Intl helpers in src/eod.ts (the single date implementation in this
//     codebase — never re-derived here), exactly as the improvement/issue rate
//     caps count filed_items rows inside a day window.
//   * the announcement limiter is a ROLLING hour, not a calendar one.
//
// Announcements are cheap (no model turn) and therefore BYPASS the turn caps —
// but they still pass the per-hour limiter and the per-cause cooldown table,
// whose fold/bypass semantics mirror src/tui/alerts.ts AlertPolicy: one fire
// per cause per cooldown, repeats inside the window fold into a counter, and a
// genuine escalation may break the cooldown exactly once per Warsaw day.
import type { Config, SlackCausePolicy } from "../config.js";
import { localWallClockToInstant, zoneDateString, zonedParts } from "../eod.js";
import type { SlackPostKind, StateStore } from "../state.js";

const DAY_MS = 86_400_000;

export interface DayWindow {
  /** "YYYY-MM-DD" in the policy timezone — the cooldown table's day key. */
  day: string;
  /** Half-open [startIso, endIso) of that local day, as UTC ISO instants. */
  startIso: string;
  endIso: string;
}

/**
 * The local calendar day containing `now`, as a half-open instant window.
 * Built from eod.ts's zone helpers so the 23h/25h DST days are exact.
 */
export function dayWindow(now: Date, timeZone: string): DayWindow {
  const p = zonedParts(now, timeZone);
  const start = localWallClockToInstant(p.year, p.month, p.day, 0, 0, timeZone);
  const nextCal = new Date(Date.UTC(p.year, p.month - 1, p.day) + DAY_MS);
  const end = localWallClockToInstant(
    nextCal.getUTCFullYear(),
    nextCal.getUTCMonth() + 1,
    nextCal.getUTCDate(),
    0,
    0,
    timeZone,
  );
  return { day: zoneDateString(now, timeZone), startIso: start.toISOString(), endIso: end.toISOString() };
}

/** The Warsaw (policy-timezone) day window in force for this config. */
export function policyWindow(cfg: Config, now: Date): DayWindow {
  return dayWindow(now, cfg.slack.policy.timezone);
}

// ---- turn admission (pre-injection, at the router) ------------------------

export type TurnCap = "daily_turns" | "per_user_daily_turns";

export interface TurnDecision {
  allow: boolean;
  /** Which cap refused — set iff `allow` is false. Callers key the one-per-day
   * `slack.cap_reached` announcement off this, so a denial is never mistaken
   * for any other kind of drop. */
  cap?: TurnCap;
  reason?: string;
  day: string;
  used: number;
  userUsed: number;
}

/**
 * May this inbound Slack message become a model turn? Counts `injected`
 * events in the Warsaw day, channel-wide and (when the sender is known) for
 * that one person. An unknown sender is only subject to the channel cap.
 */
export function decideTurn(
  store: StateStore,
  cfg: Config,
  input: { slackUser?: string | null },
  now: Date = new Date(),
): TurnDecision {
  const { daily_turns, per_user_daily_turns } = cfg.slack.policy;
  const w = policyWindow(cfg, now);
  const used = store.slackTurnsBetween(w.startIso, w.endIso);
  const user = input.slackUser ?? null;
  const userUsed = user ? store.slackTurnsBetween(w.startIso, w.endIso, user) : 0;
  const base = { day: w.day, used, userUsed };
  if (used >= daily_turns) {
    return { ...base, allow: false, cap: "daily_turns", reason: `Slack daily turn cap reached (${used}/${daily_turns})` };
  }
  if (user && userUsed >= per_user_daily_turns) {
    return {
      ...base,
      allow: false,
      cap: "per_user_daily_turns",
      reason: `Slack per-user daily turn cap reached for ${user} (${userUsed}/${per_user_daily_turns})`,
    };
  }
  return { ...base, allow: true };
}

// ---- reply admission (at the slack_reply path) ---------------------------

export type ReplyCap = "daily_posts" | "thread_replies_per_day" | "idempotent";

export interface ReplyDecision {
  allow: boolean;
  cap?: ReplyCap;
  reason?: string;
  day: string;
  /** Non-announcement posts already made today, channel-wide. */
  used: number;
  /** Posts already made into this thread today. */
  threadUsed: number;
}

/**
 * May the daemon post this reply? Three guards, cheapest first: the shared
 * post ledger (a spent `idem_key` means the message is already in the channel
 * — a retry must never double-post), the channel-wide daily post ceiling
 * (`daily_turns`, since every conversational post follows a turn), and the
 * per-thread `thread_replies_per_day`.
 */
export function decideReply(
  store: StateStore,
  cfg: Config,
  input: { threadTs?: string | null; idemKey?: string },
  now: Date = new Date(),
): ReplyDecision {
  const { daily_turns, thread_replies_per_day } = cfg.slack.policy;
  const w = policyWindow(cfg, now);
  const total = store.slackPostsBetween(w.startIso, w.endIso);
  const announces = store.slackPostsBetween(w.startIso, w.endIso, "announce");
  const used = total - announces; // announcements never consume the reply budget
  const threadUsed = input.threadTs ? store.slackThreadPostsBetween(input.threadTs, w.startIso, w.endIso) : 0;
  const base = { day: w.day, used, threadUsed };
  if (input.idemKey && store.slackPost(input.idemKey)) {
    return { ...base, allow: false, cap: "idempotent", reason: `already posted (idem_key ${input.idemKey})` };
  }
  if (used >= daily_turns) {
    return { ...base, allow: false, cap: "daily_posts", reason: `Slack daily post cap reached (${used}/${daily_turns})` };
  }
  if (input.threadTs && threadUsed >= thread_replies_per_day) {
    return {
      ...base,
      allow: false,
      cap: "thread_replies_per_day",
      reason: `thread reply cap reached (${threadUsed}/${thread_replies_per_day})`,
    };
  }
  return { ...base, allow: true };
}

// ---- announcement admission (cause switch + cooldown + hourly limiter) ---

/** Per-PR cause key: one stuck PR must never silence another. */
export function announcementKey(cause: string, pr?: number | null): string {
  return pr === null || pr === undefined ? cause : `${cause}:${pr}`;
}

/** The cause's own switch + cooldown; unlisted causes take the default. */
export function causePolicy(cfg: Config, cause: string): SlackCausePolicy {
  return cfg.slack.policy.causes[cause] ?? { enabled: true, cooldown_min: cfg.slack.policy.default_cooldown_min };
}

export type AnnouncementBlock = "disabled" | "per_hour" | "cooldown";

export interface AnnouncementDecision {
  allow: boolean;
  /** The per-PR cooldown key this decision was taken against. */
  key: string;
  /** True when a genuine escalation spent today's one cooldown bypass. */
  bypass: boolean;
  block?: AnnouncementBlock;
  reason?: string;
  /** Repeats swallowed inside the current cooldown window (0 when firing). */
  folds?: number;
}

/**
 * Decide *and record*: on a fire the cooldown row is stamped, on a suppressed
 * repeat the fold counter grows — the same mutate-on-decide contract as
 * AlertPolicy.decide, so a caller can never fire without paying the cooldown.
 * A disabled cause and an hour-limiter refusal write nothing: neither is a
 * "we already told you", so the cause stays free to speak later.
 */
export function decideAnnouncement(
  store: StateStore,
  cfg: Config,
  input: { cause: string; pr?: number | null; escalated?: boolean },
  now: Date = new Date(),
): AnnouncementDecision {
  const key = announcementKey(input.cause, input.pr);
  const policy = causePolicy(cfg, input.cause);
  if (!policy.enabled) {
    return { allow: false, key, bypass: false, block: "disabled", reason: `cause '${input.cause}' is disabled` };
  }

  const perHour = cfg.slack.policy.announcements_per_hour;
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const recent = store.slackPostsSince(hourAgo, "announce");
  if (recent >= perHour) {
    return {
      allow: false,
      key,
      bypass: false,
      block: "per_hour",
      reason: `announcement rate cap reached (${recent}/${perHour} in the last hour)`,
    };
  }

  const w = policyWindow(cfg, now);
  const prev = store.slackCooldown(key);
  // A row from an earlier Warsaw day is not "already told you today": the day
  // rollover resets the fold counter and the escalation bypass with it.
  const sameDay = prev !== undefined && prev.warsaw_day === w.day;
  if (!sameDay) {
    store.recordSlackCooldownFire(key, w.day);
    return { allow: true, key, bypass: false, folds: 0 };
  }
  const elapsedMin = (now.getTime() - Date.parse(prev!.last_fired_at)) / 60_000;
  if (elapsedMin >= policy.cooldown_min) {
    store.recordSlackCooldownFire(key, w.day);
    return { allow: true, key, bypass: false, folds: 0 };
  }
  if (input.escalated && prev!.bypassed === 0) {
    store.recordSlackCooldownFire(key, w.day, true);
    return { allow: true, key, bypass: true, folds: 0 };
  }
  const folds = store.foldSlackCooldown(key);
  return {
    allow: false,
    key,
    bypass: false,
    block: "cooldown",
    reason: `cooldown for '${key}' (${elapsedMin.toFixed(1)}/${policy.cooldown_min} min, folded ×${folds})`,
    folds,
  };
}

// ---- ledger helper --------------------------------------------------------

/**
 * Claim an idempotence key before posting. Returns false when the key was
 * already spent — the caller must then NOT call Slack. The row is settled with
 * the Slack-assigned ts (or the failure) via StateStore.settleSlackPost.
 */
export function claimPost(
  store: StateStore,
  claim: { idem_key: string; kind: SlackPostKind; pr?: number | null; thread_ts?: string | null; chars?: number },
): boolean {
  return store.recordSlackPost(claim);
}
