// status.json `archive` (docs/archiving.md §11): the closed-PR
// archiver as a person reads it — `qcr status`'s one line, `qcr archive
// status`. The block is the WRITER's promise; `readArchiveStatus` is total
// over whatever JSON is there and answers absent / unreadable / read, never a
// throw (one would take all of `qcr status` with it) and never a guess:
// `backlog` is null until the first plan completes — never 0.
import type { ArchiveMode } from "../config.js";
import { ARCHIVE_MODES } from "../config.js";

/** How long an operator's `archive-run` / `archive-restore` waits for
 * its tick or restore before it answers "still running". The operator
 * channel serves one command at a time, so this bounds what one archive verb
 * can hold a `qcr drain` or an unwedge behind it for; the work itself goes
 * on. Here (a leaf) so the CLI client reads it without the archiver. */
export const OPERATOR_WAIT_MS = 60_000;

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

/** The DB phase (docs/archiving.md §9): what the last run of the
 * event and delivery mover did, and the archive databases. Null until the
 * DB phase has run (never in plan mode). */
export interface ArchiveDbStatus {
  last_run_at: string;
  /** `caught_up` | `budget` | `held` | `aborted` | `skipped` | `failed`. */
  outcome: string;
  /** Why the run's first refused batch deleted nothing: `archive_busy`,
   * `live_busy`, `verify_mismatch`, `live_changed`, `wal_sync_failed`. A
   * refusal confined to one table (`archive_busy`, `verify_mismatch`,
   * `live_changed`) lets the other table's rows move in the same run. */
  skipped_reason: string | null;
  events_moved: number;
  deliveries_moved: number;
  /** The adapted batch size the next run starts at. */
  batch_rows: number;
  /** The run's synchronous time, in total. */
  sync_ms: number;
  months_open: number;
  months_sealed: number;
}

/** The file phase (docs/archiving.md §7): what the last run of
 * the per-PR archiver did. Null until it has run (never in plan mode). */
export interface ArchiveFilesStatus {
  last_run_at: string;
  /** `done` | `budget` | `yielded` (to a restore) | `held` | `none` (nothing
   * eligible) | `failed`. */
  outcome: string;
  /** For `held`: why — a hold reason, or `births_unknown` (the daemon's
   * births could not be observed, so nothing moves). */
  held_reason: string | null;
  prs_started: number;
  prs_archived: number;
  prs_partial: number;
  prs_held: number;
  transcripts: number;
  state_files: number;
  bytes_in: number;
  bytes_out: number;
  removed: number;
  duplicates_removed: number;
  verify_failures: number;
}

/** One store's last pass (docs/archiving.md §5): the overseer's
 * non-current transcripts (`overseer`), pi's global session store
 * (`pi_global`). Null until that store's pass has run (never in plan mode). */
export interface ArchiveStoreStatus {
  last_run_at: string;
  /** `done` | `partial` | `held` | `none` (nothing to move) | `failed`. */
  outcome: string;
  /** Why a held, partial or failed pass stopped: `birth_unknown` (the
   * overseer's birth record could not be read), `manifest_unreadable`, a
   * hold reason, `budget`, `restore_pending`, `verify_failed`, `legacy_copy_waits`
   * (an overseer legacy copy whose transcript is still live waits), … */
  reason: string | null;
  archived: number;
  bytes_in: number;
  bytes_out: number;
  removed: number;
  duplicates_removed: number;
  verify_failures: number;
  /** Files kept live by design (the overseer's current one, pi files younger
   * than a day). */
  kept_live: number;
}

/** status.json `archive`. */
export interface ArchiveStatus {
  mode: ArchiveMode;
  /**
   *   `unknown` — not measured yet (the archiver has not ticked);
   *   `off`     — `[archive] mode = "off"`: no timer armed;
   *   `plan`    — the last tick computed a plan and moved nothing by design;
   *   `idle`    — on: the last tick ran its phases (restores, the DB rows,
   *               the per-PR files, sealing — see `db` and `files`);
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
  /** The DB phase; null before it has run (and always in plan mode). Absent
   * from an older daemon's block, read as null. */
  db: ArchiveDbStatus | null;
  /** The file phase; null before it has run (and always in plan mode).
   * Absent from an older daemon's block, read as null. */
  files: ArchiveFilesStatus | null;
  /** The stores that belong to no PR; null from an older daemon or
   * before the archiver exists, each store null until its pass has run. */
  stores: { overseer: ArchiveStoreStatus | null; pi_global: ArchiveStoreStatus | null } | null;
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
    db: null,
    files: null,
    stores: null,
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

const DB_NUMBERS = [
  "events_moved",
  "deliveries_moved",
  "batch_rows",
  "sync_ms",
  "months_open",
  "months_sealed",
] as const;

/** The `db` sub-block: absent (an older daemon) and null read as null. */
function readDb(v: unknown): ArchiveDbStatus | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return bad(`db is ${shown(v)}, not an object or null`);
  if (!isStr(v.last_run_at)) bad(`db.last_run_at is ${shown(v.last_run_at)}, not a string`);
  if (!isStr(v.outcome)) bad(`db.outcome is ${shown(v.outcome)}, not a string`);
  const out = {
    last_run_at: v.last_run_at as string,
    outcome: v.outcome as string,
    skipped_reason: strOrNull(v, "skipped_reason"),
  } as ArchiveDbStatus;
  for (const k of DB_NUMBERS) {
    if (!isNum(v[k])) bad(`db.${k} is ${shown(v[k])}, not a number`);
    out[k] = v[k] as number;
  }
  return out;
}

const FILES_NUMBERS = [
  "prs_started",
  "prs_archived",
  "prs_partial",
  "prs_held",
  "transcripts",
  "state_files",
  "bytes_in",
  "bytes_out",
  "removed",
  "duplicates_removed",
  "verify_failures",
] as const;

/** The `files` sub-block: absent (an older daemon) and null read as null. */
function readFiles(v: unknown): ArchiveFilesStatus | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return bad(`files is ${shown(v)}, not an object or null`);
  if (!isStr(v.last_run_at)) bad(`files.last_run_at is ${shown(v.last_run_at)}, not a string`);
  if (!isStr(v.outcome)) bad(`files.outcome is ${shown(v.outcome)}, not a string`);
  const out = {
    last_run_at: v.last_run_at as string,
    outcome: v.outcome as string,
    held_reason: strOrNull(v, "held_reason"),
  } as ArchiveFilesStatus;
  for (const k of FILES_NUMBERS) {
    if (!isNum(v[k])) bad(`files.${k} is ${shown(v[k])}, not a number`);
    out[k] = v[k] as number;
  }
  return out;
}

const STORE_NUMBERS = [
  "archived",
  "bytes_in",
  "bytes_out",
  "removed",
  "duplicates_removed",
  "verify_failures",
  "kept_live",
] as const;

/** One store's sub-block: absent and null read as null. */
function readStore(name: string, v: unknown): ArchiveStoreStatus | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return bad(`stores.${name} is ${shown(v)}, not an object or null`);
  if (!isStr(v.last_run_at))
    bad(`stores.${name}.last_run_at is ${shown(v.last_run_at)}, not a string`);
  if (!isStr(v.outcome)) bad(`stores.${name}.outcome is ${shown(v.outcome)}, not a string`);
  const out = {
    last_run_at: v.last_run_at as string,
    outcome: v.outcome as string,
    reason: strOrNull(v, "reason"),
  } as ArchiveStoreStatus;
  for (const k of STORE_NUMBERS) {
    if (!isNum(v[k])) bad(`stores.${name}.${k} is ${shown(v[k])}, not a number`);
    out[k] = v[k] as number;
  }
  return out;
}

/** The `stores` sub-block: absent (an older daemon) and null read as null. */
function readStores(v: unknown): ArchiveStatus["stores"] {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) return bad(`stores is ${shown(v)}, not an object or null`);
  return {
    overseer: readStore("overseer", v.overseer),
    pi_global: readStore("pi_global", v.pi_global),
  };
}

/** The figures an `archive-run` result carries — the backlog and the
 * last DB, file and store passes — read with the same checks as the block;
 * null when they cannot be read whole (never a guess). */
export function readArchiveRunFigures(
  v: unknown,
): Pick<ArchiveStatus, "backlog" | "db" | "files" | "stores"> | null {
  if (!isObj(v)) return null;
  try {
    return {
      backlog:
        v.backlog === undefined
          ? null
          : numbers(v, "backlog", ["prs", "bytes", "event_rows", "delivery_rows"] as const),
      db: readDb(v.db),
      files: readFiles(v.files),
      stores: readStores(v.stores),
    };
  } catch {
    return null;
  }
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
      db: readDb(v.db),
      files: readFiles(v.files),
      stores: readStores(v.stores),
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

/** The DB phase in a few words; "" before it has run. */
export function dbPhrase(s: ArchiveStatus): string {
  const d = s.db;
  if (!d) return "";
  const moved = `db: ${fmtCount(d.events_moved)} event / ${fmtCount(d.deliveries_moved)} delivery row(s) moved last run`;
  const months = `${d.months_open} open month(s), ${d.months_sealed} sealed`;
  if (d.outcome === "skipped" && d.skipped_reason === "checkpoint_failed")
    return `db STOPPED (checkpoint_failed: the live checkpoint off the loop failed) at ${d.last_run_at} after ${fmtCount(d.events_moved)} event / ${fmtCount(d.deliveries_moved)} delivery row(s) moved; ${months}`;
  if (d.outcome === "skipped")
    return `db SKIPPED (${d.skipped_reason ?? "reason unknown"}) at ${d.last_run_at}, nothing deleted; ${months}`;
  if (d.outcome === "failed") return `db FAILED at ${d.last_run_at}; ${months}`;
  const tail = d.outcome === "caught_up" ? "caught up" : d.outcome;
  return `${moved} (${tail}); ${months}`;
}

/** The file phase in a few words; "" before it has run. */
export function filesPhrase(s: ArchiveStatus): string {
  const f = s.files;
  if (!f) return "";
  if (f.outcome === "failed") return `files FAILED at ${f.last_run_at}`;
  if (f.outcome === "held" && f.prs_started === 0)
    return `files HELD (${f.held_reason ?? "reason unknown"}) at ${f.last_run_at}`;
  if (f.outcome === "none") return "files: nothing eligible last run";
  const verify = f.verify_failures > 0 ? `, ${f.verify_failures} VERIFY FAILURE(S)` : "";
  return (
    `files: ${f.prs_archived} PR(s) archived last run (${fmtBytes(f.bytes_in)} → ${fmtBytes(f.bytes_out)}, ` +
    `${f.removed} live file(s) removed${f.duplicates_removed ? `, ${f.duplicates_removed} legacy duplicate(s)` : ""}${verify}; ${f.outcome})`
  );
}

/** One store's last pass in a few words. */
export function storePhrase(label: string, st: ArchiveStoreStatus | null): string {
  if (!st) return "";
  if (st.outcome === "none") return `${label}: nothing to move (${st.kept_live} kept live)`;
  if (st.outcome === "failed" || st.outcome === "held")
    return `${label} ${st.outcome.toUpperCase()} (${st.reason ?? "reason unknown"}) at ${st.last_run_at}`;
  const verify = st.verify_failures > 0 ? `, ${st.verify_failures} VERIFY FAILURE(S)` : "";
  return (
    `${label}: ${st.archived} file(s) archived last run (${fmtBytes(st.bytes_in)} → ${fmtBytes(st.bytes_out)}, ` +
    `${st.removed} removed${st.duplicates_removed ? `, ${st.duplicates_removed} legacy duplicate(s)` : ""}${verify}; ` +
    `${st.kept_live} kept live; ${st.outcome}${st.reason ? `: ${st.reason}` : ""})`
  );
}

/** The stores phrase `qcr status` carries: only what needs a look (a held or
 * failed store, a verify failure) — the full lines are `qcr archive status`'s. */
export function storesAlertPhrase(s: ArchiveStatus): string {
  const parts: string[] = [];
  for (const [label, st] of [
    ["overseer store", s.stores?.overseer ?? null],
    ["pi-global store", s.stores?.pi_global ?? null],
  ] as const)
    if (st && (st.outcome === "failed" || st.outcome === "held" || st.verify_failures > 0))
      parts.push(storePhrase(label, st));
  return parts.join("; ");
}

/** How many reopened PRs wait for their archived files to come back, and
 * who will bring them: in mode `on` a birth or the next tick; in any other
 * mode nothing does (§8.3), so the phrase names the verb. ""
 * when none waits (or restores could not be counted). */
export function pendingRestorePhrase(s: ArchiveStatus): string {
  const n = s.restores?.pending ?? 0;
  if (n <= 0) return "";
  return s.mode === "on"
    ? `${n} reopened PR(s) awaiting restore`
    : `${n} REOPENED PR(S) AWAITING RESTORE — mode is ${s.mode}, so no tick or birth restores them: run \`qcr archive restore <pr>\``;
}

/**
 * What in the archive block needs a PERSON (docs/archiving.md §11) — the
 * board's banner and the companion's view: held for disk (low, or UNKNOWN), a
 * restore that failed, a reopened PR no tick or birth will restore (mode not
 * `on`; until it is restored its archived receipts read UNKNOWN and its
 * pre-close recheck claims stay standing), or ≥ 3 verify failures in 24 h.
 * [] when nothing does. Pure.
 */
export function archiveAttention(s: ArchiveStatus): string[] {
  const out: string[] = [];
  if (s.state === "held" && s.held_reason === "disk_low")
    out.push("HELD: free disk below the headroom");
  if (s.state === "held" && s.held_reason === "disk_unknown") out.push("HELD: free disk UNKNOWN");
  if (s.restores && s.restores.failed > 0) out.push(`${s.restores.failed} RESTORE(S) FAILED`);
  if (s.mode !== "on" && s.restores && s.restores.pending > 0)
    out.push(
      `${s.restores.pending} REOPENED PR(S) AWAITING RESTORE (mode ${s.mode}: qcr archive restore <pr>)`,
    );
  if (s.verify_failures_24h !== null && s.verify_failures_24h >= 3)
    out.push(`${s.verify_failures_24h} VERIFY FAILURES in 24h`);
  return out;
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
  if (s.state === "off") {
    // Off arms nothing — but files an earlier `on` period archived are still
    // archived, and a reopened PR's must come back by hand.
    const left = [
      s.restores && s.restores.failed > 0 ? `${s.restores.failed} RESTORE(S) FAILED` : "",
      pendingRestorePhrase(s),
    ].filter((x) => x !== "");
    return `archive: off ([archive] mode = "off" — nothing armed)${left.length > 0 ? `; ${left.join("; ")}` : ""}`;
  }
  const extras: string[] = [];
  if (s.held_prs && s.held_prs.count > 0) extras.push(`${s.held_prs.count} closed PR(s) held`);
  if (s.orphans && s.orphans.count > 0) extras.push(`${s.orphans.count} orphan session dir(s)`);
  if (s.restores && s.restores.failed > 0) extras.push(`${s.restores.failed} RESTORE(S) FAILED`);
  const pending = pendingRestorePhrase(s);
  if (pending) extras.push(pending);
  if (s.verify_failures_24h) extras.push(`${s.verify_failures_24h} verify failure(s) in 24h`);
  const db = dbPhrase(s);
  if (db) extras.push(db);
  const files = filesPhrase(s);
  if (files) extras.push(files);
  const stores = storesAlertPhrase(s);
  if (stores) extras.push(stores);
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
