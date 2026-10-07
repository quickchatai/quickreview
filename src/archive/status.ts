// status.json `archive` (docs/archiving.md §11): the closed-PR
// archiver as a person reads it — `qcr status`'s one line, `qcr archive
// status`. The block is the WRITER's promise; `readArchiveStatus` is total
// over whatever JSON is there and answers absent / unreadable / read, never a
// throw (one would take all of `qcr status` with it) and never a guess:
// `backlog` is null until the first plan completes — never 0.
import type { ArchiveMode } from "../config.js";
import { ARCHIVE_MODES } from "../config.js";

export const ARCHIVE_STATES = [
  "unknown",
  "off",
  "plan",
  "idle",
  "running",
  "held",
  "failed",
] as const;
export type ArchiveState = (typeof ARCHIVE_STATES)[number];

/** Why the archiver started nothing this tick. */
export const ARCHIVE_HOLD_REASONS = [
  "awaiting_reconcile",
  "start_delay",
  "draining",
  "loop_stalled",
  "cpu_starved",
  "disk_low",
  "disk_unknown",
] as const;
export type ArchiveHoldReason = (typeof ARCHIVE_HOLD_REASONS)[number];

export interface ArchiveBacklog {
  prs: number;
  bytes: number;
  event_rows: number;
  delivery_rows: number;
}

export interface ArchiveTotals {
  prs: number;
  files: number;
  bytes_in: number;
  bytes_out: number;
  event_rows: number;
  delivery_rows: number;
  duplicates_removed: number;
}

export interface ArchiveDisk {
  archive_free: number;
  state_free: number;
  headroom: number;
}

/** status.json `archive`. */
export interface ArchiveStatus {
  mode: ArchiveMode;
  /**
   *   `unknown` — not measured yet (the archiver has not ticked);
   *   `off`     — `[archive] mode = "off"`: no timer armed;
   *   `plan`    — the last tick computed a plan and moved nothing by design;
   *   `idle`    — on, nothing to do;
   *   `running` — a tick is in progress (`running_since`);
   *   `held`    — the last tick started nothing (`held_reason`);
   *   `failed`  — the last tick failed (`last_error`).
   */
  state: ArchiveState;
  held_reason: ArchiveHoldReason | null;
  /** For `start_delay`: when the first tick may run. */
  held_until: string | null;
  running_since: string | null;
  last_tick_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  /** When the backlog below was computed; null before the first plan. */
  plan_at: string | null;
  /** What a pass would move. NULL until the first plan completes, never 0. */
  backlog: ArchiveBacklog | null;
  /** What was moved (all time); null when the ledger could not be read. */
  totals: ArchiveTotals | null;
  /** Free bytes on both mounts at the last check, and the headroom kept. */
  disk: ArchiveDisk | null;
  verify_failures_24h: number | null;
  restores: { pending: number; done: number; failed: number } | null;
  /** Closed PRs past the window that the rule holds: a count, the first 20. */
  held_prs: { count: number; first: Array<{ pr: number; reason: string }> } | null;
  /** `pi-sessions/pr-<n>` dirs with no registry row: never touched. */
  orphans: { count: number; first: string[] } | null;
  /** state.db's free pages (the daemon never VACUUMs; deleted pages are
   * reused). */
  freelist_pages: number | null;
  /** The archiver's longest measured synchronous span. */
  max_sync_span_ms: number | null;
}

/** The block before the archiver exists (the daemon is still assembling):
 * the mode is known, nothing else is — never 0. */
export function pendingArchiveStatus(mode: ArchiveMode): ArchiveStatus {
  return {
    mode,
    state: "unknown",
    held_reason: null,
    held_until: null,
    running_since: null,
    last_tick_at: null,
    last_success_at: null,
    last_error: null,
    plan_at: null,
    backlog: null,
    totals: null,
    disk: null,
    verify_failures_24h: null,
    restores: null,
    held_prs: null,
    orphans: null,
    freelist_pages: null,
    max_sync_span_ms: null,
  };
}

// ---- the total reader ------------------------------------------------------------

export type ArchiveStatusRead =
  { kind: "absent" } | { kind: "unreadable"; why: string } | { kind: "read"; view: ArchiveStatus };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** A value from the block, as a reason names it: short, quoted, escaped. */
function shown(v: unknown): string {
  if (isStr(v)) return JSON.stringify(v.slice(0, 40));
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean")
    return String(v);
  return Array.isArray(v) ? "an array" : `a${typeof v === "object" ? "n" : ""} ${typeof v}`;
}

class Unreadable extends Error {}
const bad = (why: string): never => {
  throw new Unreadable(why);
};

function strOrNull(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === null) return null;
  if (!isStr(v)) bad(`${k} is ${shown(v)}, not a string or null`);
  return v as string;
}

function numOrNull(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  if (v === null) return null;
  if (!isNum(v)) bad(`${k} is ${shown(v)}, not a number or null`);
  return v as number;
}

/** A nullable object of numeric fields, each checked. */
function numbers<K extends string>(
  o: Record<string, unknown>,
  k: string,
  keys: readonly K[],
): Record<K, number> | null {
  const v = o[k];
  if (v === null) return null;
  if (!isObj(v)) return bad(`${k} is ${shown(v)}, not an object or null`);
  const out = {} as Record<K, number>;
  for (const key of keys) {
    if (!isNum(v[key])) bad(`${k}.${key} is ${shown(v[key])}, not a number`);
    out[key] = v[key] as number;
  }
  return out;
}

/** status.json `archive` read back — total over whatever JSON is there. */
export function readArchiveStatus(v: unknown): ArchiveStatusRead {
  if (v === undefined) return { kind: "absent" };
  try {
    if (!isObj(v)) return bad(`the archive block is ${shown(v)}, not an object`);
    if (!(ARCHIVE_MODES as readonly unknown[]).includes(v.mode))
      bad(`mode ${shown(v.mode)} is not one this build knows`);
    if (!(ARCHIVE_STATES as readonly unknown[]).includes(v.state))
      bad(`state ${shown(v.state)} is not one this build knows`);
    const heldPrs = v.held_prs;
    let held: ArchiveStatus["held_prs"] = null;
    if (heldPrs !== null) {
      if (!isObj(heldPrs) || !isNum(heldPrs.count) || !Array.isArray(heldPrs.first))
        bad("held_prs is unreadable");
      const h = heldPrs as Record<string, unknown>;
      const first = (h.first as unknown[]).map((e) => {
        if (!isObj(e) || !isNum(e.pr) || !isStr(e.reason))
          return bad("held_prs.first is unreadable");
        return { pr: e.pr, reason: e.reason };
      });
      held = { count: h.count as number, first };
    }
    const orph = v.orphans;
    let orphans: ArchiveStatus["orphans"] = null;
    if (orph !== null) {
      if (
        !isObj(orph) ||
        !isNum(orph.count) ||
        !Array.isArray(orph.first) ||
        !orph.first.every(isStr)
      )
        bad("orphans is unreadable");
      const o = orph as Record<string, unknown>;
      orphans = { count: o.count as number, first: [...(o.first as string[])] };
    }
    const view: ArchiveStatus = {
      mode: v.mode as ArchiveMode,
      state: v.state as ArchiveState,
      held_reason: strOrNull(v, "held_reason") as ArchiveHoldReason | null,
      held_until: strOrNull(v, "held_until"),
      running_since: strOrNull(v, "running_since"),
      last_tick_at: strOrNull(v, "last_tick_at"),
      last_success_at: strOrNull(v, "last_success_at"),
      last_error: strOrNull(v, "last_error"),
      plan_at: strOrNull(v, "plan_at"),
      backlog: numbers(v, "backlog", ["prs", "bytes", "event_rows", "delivery_rows"] as const),
      totals: numbers(v, "totals", [
        "prs",
        "files",
        "bytes_in",
        "bytes_out",
        "event_rows",
        "delivery_rows",
        "duplicates_removed",
      ] as const),
      disk: numbers(v, "disk", ["archive_free", "state_free", "headroom"] as const),
      verify_failures_24h: numOrNull(v, "verify_failures_24h"),
      restores: numbers(v, "restores", ["pending", "done", "failed"] as const),
      held_prs: held,
      orphans,
      freelist_pages: numOrNull(v, "freelist_pages"),
      max_sync_span_ms: numOrNull(v, "max_sync_span_ms"),
    };
    return { kind: "read", view };
  } catch (err) {
    if (err instanceof Unreadable) return { kind: "unreadable", why: err.message };
    return { kind: "unreadable", why: String(err) };
  }
}

// ---- what a person reads ---------------------------------------------------------

/** Bytes the way a person reads them: `812 B`, `3.4 KB`, `1.2 GB`. */
export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** A count the way a person reads it: `812`, `113.6k`, `1.10M`. */
export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const HOLD_WORDS: Record<string, string> = {
  awaiting_reconcile: "waiting for the daemon's first healthy reconcile",
  start_delay: "start delay after the first healthy reconcile",
  draining: "draining",
  loop_stalled: "the event loop is stalled",
  cpu_starved: "the container's CPU is starved",
  disk_low: "free disk below the headroom",
  disk_unknown: "free disk UNKNOWN",
};

/** The backlog phrase: the numbers, or UNKNOWN — never 0 for "not planned". */
export function backlogPhrase(s: ArchiveStatus): string {
  const b = s.backlog;
  if (!b) return "backlog UNKNOWN (no plan has completed yet)";
  return `backlog ${b.prs} PR(s) · ${fmtBytes(b.bytes)} · ${fmtCount(b.event_rows)} event row(s) · ${fmtCount(b.delivery_rows)} delivery row(s)${s.plan_at ? ` (planned ${s.plan_at})` : ""}`;
}

/**
 * The one archive line `qcr status` prints. An absent block (an older
 * daemon), an unmeasured one and one this build cannot read whole each say
 * so; none throws.
 */
export function archiveStatusLine(v: unknown): string {
  const r = readArchiveStatus(v);
  if (r.kind === "absent") return "archive: NOT REPORTED (this daemon predates the archive block)";
  if (r.kind === "unreadable") return `archive: UNKNOWN (unreadable block: ${r.why})`;
  const s = r.view;
  if (s.state === "off") return 'archive: off ([archive] mode = "off" — nothing armed)';
  const extras: string[] = [];
  if (s.held_prs && s.held_prs.count > 0) extras.push(`${s.held_prs.count} closed PR(s) held`);
  if (s.orphans && s.orphans.count > 0) extras.push(`${s.orphans.count} orphan session dir(s)`);
  if (s.restores && s.restores.failed > 0) extras.push(`${s.restores.failed} RESTORE(S) FAILED`);
  if (s.verify_failures_24h) extras.push(`${s.verify_failures_24h} verify failure(s) in 24h`);
  const tail = extras.length > 0 ? `; ${extras.join("; ")}` : "";
  const mode = `mode ${s.mode}`;
  switch (s.state) {
    case "unknown":
      return `archive: ${mode} — UNKNOWN, not ticked yet; ${backlogPhrase(s)}`;
    case "held": {
      const why = s.held_reason ? (HOLD_WORDS[s.held_reason] ?? s.held_reason) : "reason unknown";
      const until = s.held_until ? ` until ${s.held_until}` : "";
      return `archive: ${mode} — HELD (${why})${until}; ${backlogPhrase(s)}${tail}`;
    }
    case "failed":
      return `archive: ${mode} — FAILED${s.last_tick_at ? ` at ${s.last_tick_at}` : ""}: ${(s.last_error ?? "no error recorded").slice(0, 200)}; ${backlogPhrase(s)}${tail}`;
    case "running":
      return `archive: ${mode} — running${s.running_since ? ` since ${s.running_since}` : ""}; ${backlogPhrase(s)}${tail}`;
    case "plan":
      return `archive: ${mode} — planning only, nothing moved; ${backlogPhrase(s)}${tail}`;
    case "idle":
      return `archive: ${mode} — idle; ${backlogPhrase(s)}${tail}`;
  }
}
