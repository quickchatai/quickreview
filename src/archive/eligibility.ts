// Archive eligibility (docs/archiving.md §7.1) — one function,
// `prEligibility`, the rule every archive pass and the synchronous re-check
// right before an unlink apply. A PR's files may leave the live tree
// only when EVERY clause holds:
//
//   - pr_state says `closed` (a PR with no registry row is unknown, never
//     eligible — its dirs are orphans, reported and never touched);
//   - its close is at least `[archive] after_days` old. The close time is the
//     newest `pr_closed` event (an indexed lookup), else `pr_state.updated_at`;
//     a PR restored earlier counts from the newer of its close and its
//     `archive_prs.restored_at`;
//   - tmux `pr-<n>` is not alive (and tmux answered: unknown holds);
//   - no session birth is in flight;
//   - no `rounds` row is running (or overdue — not terminal either);
//   - no `session_commands` row is pending or running;
//   - no `review_failures` row owes work (`work_owed = 1`) — clearing that on
//     a closed PR is the owner's `resolve-terminal-failure`, never the
//     archiver's (docs/archiving.md §0);
//   - no wake is held for it;
//   - no top-level `inject/pr-<n>/*.md` whose command row is non-terminal or
//     missing (an undelivered wake a reborn session would receive; a dir we
//     could not list holds too).
//
// Pure over the store and the facts the caller gathered outside it (tmux,
// births, the inject listing): synchronous, a handful of indexed point reads.
import type { StateStore } from "../state.js";
import { TERMINAL_COMMAND_STATUSES } from "./prfiles.js";

export const INELIGIBLE_REASONS = [
  "unknown_pr",
  "not_closed",
  "closed_recently",
  "tmux_alive",
  "tmux_unknown",
  "birth_in_flight",
  "round_running",
  "round_overdue",
  "command_active",
  "failure_open",
  "wake_held",
  "pending_inject",
  "inject_unknown",
] as const;
export type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

/** What the caller learned outside the database, for one PR. */
export interface OutsideFacts {
  /** Is tmux `pr-<n>` alive? null = tmux could not be asked (holds). */
  tmuxAlive: boolean | null;
  /** Is a session birth in flight for it (the daemon's `prSessionBirths`)? */
  birthInFlight: boolean;
  /** The absolute paths of the top-level `*.md` files in `inject/pr-<n>/`
   * ([] when the dir is absent); null = the dir could not be listed (holds). */
  injectFiles: readonly string[] | null;
}

export interface Eligibility {
  pr: number;
  eligible: boolean;
  /** The first failing clause, in the order above; null when eligible. */
  reason: IneligibleReason | null;
  /** Every failing clause. */
  reasons: IneligibleReason[];
  /** The close the window is counted from; null for a PR that is not closed. */
  closed_at: string | null;
  closed_source: "pr_closed_event" | "pr_state_updated_at" | null;
  /** The later of the close and an earlier restore — what the window counts
   * from. */
  since: string | null;
  /** The top-level inject files whose command row is terminal (acked,
   * cancelled or failed) — leftovers, archived as `stale_inject`. */
  stale_injects: string[];
}

const DAY_MS = 86_400_000;
/** A wake whose command reached one of these is stale — the same terminal
 * statuses whose payloads the inventory lets leave. */
const TERMINAL_COMMAND: ReadonlySet<string> = new Set(TERMINAL_COMMAND_STATUSES);

/** When the PR closed, as far as the store says: the newest `pr_closed`
 * event, else the registry row's `updated_at`. */
export function closedAt(
  store: StateStore,
  pr: number,
): { at: string; source: "pr_closed_event" | "pr_state_updated_at" } | null {
  const ev = store.lastEventAt("pr_closed", pr);
  if (ev && Number.isFinite(Date.parse(ev))) return { at: ev, source: "pr_closed_event" };
  const row = store.db.prepare("SELECT updated_at FROM pr_state WHERE number = ?").get(pr) as
    { updated_at: string } | undefined;
  if (row && Number.isFinite(Date.parse(row.updated_at)))
    return { at: row.updated_at, source: "pr_state_updated_at" };
  return null;
}

/**
 * Is `pr` eligible for archiving at `now`? Synchronous: every database clause
 * is an indexed point read; tmux, births and the inject listing arrive in
 * `outside`.
 */
export function prEligibility(
  store: StateStore,
  pr: number,
  opts: { now: Date; afterDays: number; outside: OutsideFacts },
): Eligibility {
  const out: Eligibility = {
    pr,
    eligible: false,
    reason: null,
    reasons: [],
    closed_at: null,
    closed_source: null,
    since: null,
    stale_injects: [],
  };
  const fail = (r: IneligibleReason): void => {
    if (!out.reasons.includes(r)) out.reasons.push(r);
  };
  const row = store.db.prepare("SELECT state FROM pr_state WHERE number = ?").get(pr) as
    { state: string } | undefined;
  if (!row) fail("unknown_pr");
  else if (row.state !== "closed") fail("not_closed");
  else {
    const close = closedAt(store, pr);
    out.closed_at = close?.at ?? null;
    out.closed_source = close?.source ?? null;
    const restored = store.db
      .prepare("SELECT restored_at FROM archive_prs WHERE pr = ?")
      .get(pr) as { restored_at: string | null } | undefined;
    const sinceMs = Math.max(
      close ? Date.parse(close.at) : Number.NaN,
      restored?.restored_at ? Date.parse(restored.restored_at) : Number.NEGATIVE_INFINITY,
    );
    if (!Number.isFinite(sinceMs)) fail("closed_recently");
    else {
      out.since = new Date(sinceMs).toISOString();
      if (opts.now.getTime() - sinceMs < opts.afterDays * DAY_MS) fail("closed_recently");
    }
  }
  if (out.reasons.includes("unknown_pr") || out.reasons.includes("not_closed")) {
    out.reason = out.reasons[0]!;
    return out;
  }

  const { tmuxAlive, birthInFlight, injectFiles } = opts.outside;
  if (tmuxAlive === null) fail("tmux_unknown");
  else if (tmuxAlive) fail("tmux_alive");
  if (birthInFlight) fail("birth_in_flight");

  const rounds = store.db
    .prepare("SELECT DISTINCT status FROM rounds WHERE pr = ? AND status IN ('running', 'overdue')")
    .all(pr) as Array<{ status: string }>;
  if (rounds.some((r) => r.status === "running")) fail("round_running");
  if (rounds.some((r) => r.status === "overdue")) fail("round_overdue");

  if (
    store.db
      .prepare(
        "SELECT 1 FROM session_commands WHERE pr = ? AND status IN ('pending', 'running') LIMIT 1",
      )
      .get(pr)
  )
    fail("command_active");

  if (store.db.prepare("SELECT 1 FROM review_failures WHERE pr = ? AND work_owed = 1").get(pr))
    fail("failure_open");

  if (store.hasHeldWakes(pr)) fail("wake_held");

  if (injectFiles === null) fail("inject_unknown");
  else
    for (const file of injectFiles) {
      const command = store.getSessionCommandByInjectPath(file);
      if (!command || !TERMINAL_COMMAND.has(command.status)) fail("pending_inject");
      else out.stale_injects.push(file);
    }

  out.eligible = out.reasons.length === 0;
  out.reason = out.reasons[0] ?? null;
  return out;
}
