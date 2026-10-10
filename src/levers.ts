// The dispatch levers: `drain` and `pause-pr`, and who may hold them for how
// long.
//
// Both levers stop review work — the drain stops all of it, a pause stops one
// PR's. An LLM session must never hold an uncapped availability lever, so the
// SESSION's hold is bounded and the OPERATOR's is not:
//
//   * An OPERATOR lever is the deploy flow's valve. `qcr drain on` engages it,
//     the new boot's first healthy reconcile pass lifts it (daemon.ts), and it
//     has no expiry — a broken deploy must not resume work blind.
//   * A SESSION lever ALWAYS carries an expiry and ALWAYS draws on a per-day
//     minute budget. The grant type below has no member that spells a session
//     hold without an expiry, and `boundSessionGrant` refuses or shortens
//     anything past the configured cap. A session cannot lift an operator's
//     hold and cannot widen one; an operator's grant upgrades a session's.
//
// WHO is deciding is never read from the command file. It is decided by which
// command directory the file arrived in (`src/commands.ts`): the operator's
// directory is root-owned and unwritable by the daemon's uid — the uid every
// session runs as — so a session cannot put a file there, and a file that
// arrives there without that seal is treated as a session's. See
// `operatorSealVerdict` in commands.ts.
import type { LeversConfig } from "./config.js";
import { opsDay } from "./eod.js";
import type { FileOutcome } from "./improvements.js";
import type { StateStore } from "./state.js";

export type LeverIssuer = "operator" | "session";
export type LeverKind = "drain" | "pause";

/**
 * A hold as granted. The union is the brace: a session grant carries an
 * `expires_at` STRING, never null — there is no way to write a session hold
 * that lasts until lifted.
 */
export type LeverGrant =
  { issuer: "operator"; expires_at: string | null } | { issuer: "session"; expires_at: string };

/** A hold as stored: the same shape, read back. */
export interface LeverHold {
  issuer: LeverIssuer;
  expires_at: string | null;
}

export type HoldOutcome = "engaged" | "upgraded" | "extended" | "unchanged";

/** Later of two expiries, where `null` (until lifted) is the latest of all. */
function widerExpiry(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return a > b ? a : b;
}

/**
 * Fold a new grant onto the hold that stands. Pure, and the one place the
 * precedence lives:
 *   nothing standing         → engaged with the grant;
 *   operator over session    → upgraded (the operator's terms replace);
 *   session over operator    → unchanged (a session never narrows an operator);
 *   same issuer over itself  → extended when the grant reaches later, else unchanged.
 */
export function mergeHold(
  current: LeverHold | null,
  grant: LeverGrant,
): { hold: LeverHold; outcome: HoldOutcome } {
  if (!current)
    return { hold: { issuer: grant.issuer, expires_at: grant.expires_at }, outcome: "engaged" };
  if (current.issuer === "operator" && grant.issuer === "session")
    return { hold: current, outcome: "unchanged" };
  if (current.issuer === "session" && grant.issuer === "operator") {
    return { hold: { issuer: "operator", expires_at: grant.expires_at }, outcome: "upgraded" };
  }
  const expires_at = widerExpiry(current.expires_at, grant.expires_at);
  if (expires_at === current.expires_at) return { hold: current, outcome: "unchanged" };
  return { hold: { issuer: current.issuer, expires_at }, outcome: "extended" };
}

/** May `by` lift `current`? An operator lifts anything; a session lifts only a session's hold. */
export function mayLift(current: LeverHold, by: LeverIssuer): boolean {
  return by === "operator" || current.issuer === "session";
}

/** Is the hold still in force at `nowIso`? A null expiry never lapses. */
export function holdActive(hold: LeverHold | null, nowIso: string): hold is LeverHold {
  return hold !== null && (hold.expires_at === null || hold.expires_at > nowIso);
}

export function minutesFromNow(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

export type SessionGrantVerdict =
  { ok: true; minutes: number; expires_at: string } | { ok: false; reason: string };

/**
 * Bound a session's ask. The bound is applied whether or not the session
 * stated a duration — an omitted `for_min` gets the largest grant the cap and
 * the day's remaining budget allow, never "until lifted". An explicit ask past
 * the cap or past the remaining budget is refused with the number, so the
 * session can ask again smaller instead of silently getting less than it
 * planned around.
 */
export function boundSessionGrant(input: {
  kind: LeverKind;
  requestedMin: number | undefined;
  maxMin: number;
  budgetMin: number;
  usedMin: number;
  now: Date;
}): SessionGrantVerdict {
  const { kind, requestedMin, maxMin, budgetMin, usedMin, now } = input;
  const remaining = Math.max(0, budgetMin - usedMin);
  if (remaining === 0) {
    return {
      ok: false,
      reason: `${kind}: the session's ${budgetMin}-minute ${kind} budget for today is spent; the lever is the operator's for the rest of the day`,
    };
  }
  if (requestedMin === undefined) {
    const minutes = Math.min(maxMin, remaining);
    return { ok: true, minutes, expires_at: minutesFromNow(now, minutes) };
  }
  if (requestedMin > maxMin) {
    return {
      ok: false,
      reason: `${kind}: for_min ${requestedMin} exceeds the session cap of ${maxMin} minutes`,
    };
  }
  if (requestedMin > remaining) {
    return {
      ok: false,
      reason: `${kind}: for_min ${requestedMin} exceeds the ${remaining} minutes left of today's ${budgetMin}-minute session budget`,
    };
  }
  return { ok: true, minutes: requestedMin, expires_at: minutesFromNow(now, requestedMin) };
}

// ---- the daemon-side handlers -----------------------------------------------

export interface LeverDeps {
  store: StateStore;
  levers: LeversConfig;
  /** `[ops] timezone` — the day the session budget is counted in. */
  timezone: string;
  now?: () => Date;
}

/** Resolve the grant a caller may have: the operator's is taken verbatim, a session's is bounded and charged to the day. */
function grantFor(
  deps: LeverDeps,
  kind: LeverKind,
  pr: number | null,
  issuer: LeverIssuer,
  forMin: number | undefined,
): { ok: true; grant: LeverGrant; charge: () => void } | { ok: false; reason: string } {
  const now = (deps.now ?? (() => new Date()))();
  if (issuer === "operator") {
    return {
      ok: true,
      grant: {
        issuer: "operator",
        expires_at: forMin === undefined ? null : minutesFromNow(now, forMin),
      },
      charge: () => {},
    };
  }
  const day = opsDay(deps.timezone, now);
  const maxMin =
    kind === "drain" ? deps.levers.session_drain_max_min : deps.levers.session_pause_max_min;
  const budgetMin =
    kind === "drain"
      ? deps.levers.session_drain_budget_min_per_day
      : deps.levers.session_pause_budget_min_per_day;
  const verdict = boundSessionGrant({
    kind,
    requestedMin: forMin,
    maxMin,
    budgetMin,
    usedMin: deps.store.leverMinutesUsed(kind, day, pr),
    now,
  });
  if (!verdict.ok) return verdict;
  return {
    ok: true,
    grant: { issuer: "session", expires_at: verdict.expires_at },
    charge: () => deps.store.recordLeverGrant(kind, pr, verdict.minutes, day, verdict.expires_at),
  };
}

/**
 * The `drain` handler. ON engages (or upgrades/extends) the drain; OFF lifts
 * it — a session's OFF is refused while the operator holds it. Never touches
 * GitHub, never goes near the gate.
 */
export async function drainLever(
  deps: LeverDeps,
  on: boolean,
  issuer: LeverIssuer,
  forMin: number | undefined,
  afterLift: () => Promise<void>,
): Promise<FileOutcome> {
  const { store } = deps;
  if (!on) {
    const res = store.liftDrain(issuer);
    if (res.refused) {
      return {
        ok: false,
        reason:
          "drain is held by the operator (qcr drain on); only the operator lifts it (qcr drain off) or the next boot's first healthy reconcile",
      };
    }
    if (res.changed)
      store.logEvent("drain_off", null, { by: issuer, dropped_deliveries: res.dropped });
    await afterLift();
    return { ok: true, draining: false, issuer, dropped_deliveries: res.dropped };
  }
  const resolved = grantFor(deps, "drain", null, issuer, forMin);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const res = store.engageDrain(resolved.grant);
  const state = res.state;
  if (!state.draining) {
    // Structurally unreachable — a grant that merged has a holder — but the
    // union does not know that, and a lie here ("draining") would be worse
    // than a loud refusal.
    return {
      ok: false,
      reason: "drain did not take: the store reads not draining after the grant",
    };
  }
  if (res.outcome !== "unchanged") {
    resolved.charge();
    store.logEvent("drain_on", null, {
      by: issuer,
      outcome: res.outcome,
      expires_at: state.expires_at,
    });
  }
  return {
    ok: true,
    draining: true,
    outcome: res.outcome,
    issuer: state.issued_by,
    expires_at: state.expires_at,
    running_rounds: store.runningRounds().length,
  };
}

/** The `pause-pr` handler: hold one PR out of dispatch and re-trigger. */
export function pauseLever(
  deps: LeverDeps,
  pr: number,
  reason: string,
  issuer: LeverIssuer,
  forMin: number | undefined,
): FileOutcome {
  const { store } = deps;
  if (!store.getPr(pr)) return { ok: false, reason: `unknown PR #${pr}` };
  const resolved = grantFor(deps, "pause", pr, issuer, forMin);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const res = store.pausePr(pr, resolved.grant, reason);
  if (res.outcome !== "unchanged") {
    resolved.charge();
    store.logEvent("pr_paused", pr, {
      reason,
      by: issuer,
      outcome: res.outcome,
      expires_at: res.hold.expires_at,
    });
  }
  return {
    ok: true,
    paused: pr,
    outcome: res.outcome,
    issuer: res.hold.issuer,
    expires_at: res.hold.expires_at,
  };
}

/** The `resume-pr` handler: a session cannot lift an operator's pause. */
export async function resumeLever(
  deps: LeverDeps,
  pr: number,
  issuer: LeverIssuer,
  afterResume: () => Promise<void>,
): Promise<FileOutcome> {
  const { store } = deps;
  if (!store.getPr(pr)) return { ok: false, reason: `unknown PR #${pr}` };
  const res = store.resumePr(pr, issuer);
  if (res.refused) {
    return {
      ok: false,
      reason: `PR #${pr} is paused by the operator; only the operator resumes it`,
    };
  }
  store.promoteSuccessor(pr);
  store.logEvent("pr_resumed", pr, { by: issuer });
  await afterResume();
  return { ok: true, resumed: pr };
}

/**
 * Retire holds whose expiry has passed and say so in the event ledger. The
 * readers (`drainState`, every PR row) already fold expiry themselves, so a
 * lapsed hold stops binding the moment it lapses — this sweep is the record,
 * not the enforcement. Runs from the dispatch pump.
 */
export function sweepExpiredLevers(
  store: StateStore,
  log: (line: string) => void,
): { drain: boolean; pauses: number[] } {
  const expired = store.expireLevers();
  if (expired.drain) {
    store.logEvent("drain_expired", null, {});
    log("drain_expired — the session's drain lapsed; dispatch resumes");
  }
  for (const pr of expired.pauses) {
    store.logEvent("pr_pause_expired", pr, {});
    log(`pr_pause_expired — #${pr} is back in the queue`);
  }
  return expired;
}
