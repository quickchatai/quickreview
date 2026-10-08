// The archive PLAN (docs/archiving.md §7.1, §7.2, §13): what an
// archive pass WOULD move, computed without moving, writing or reading the
// contents of anything.
//
//   - Inventory (`prfiles.ts`, shared with the archive pass): one async `readdir` of each live directory the per-PR
//     artifacts sit in (§7.2), grouped by PR; a recursive async walk only
//     inside an ELIGIBLE PR's own dirs; an async `lstat` per file for its
//     size. No synchronous directory walk anywhere (`authwatch.ts` and
//     `newestSessionFile` are the anti-patterns).
//   - Eligibility: the one rule, `prEligibility` (§7.1), per closed PR.
//   - Orphans: a `pi-sessions/pr-<n>` dir with no `pr_state` row is reported,
//     never touched.
//   - Rows: the reader-less event kinds older than `events_after_days` and the
//     webhook deliveries older than `after_days`, counted through ROWID
//     WINDOWS from the mover's watermark — never a kind-filtered scan, never a
//     `MAX(id) WHERE ts < …` full scan — stopping at the first window that
//     holds a younger row. A memo carries the settled prefix between plans,
//     so a daemon's later plans read only the rows that aged since.
//
// Every synchronous span is small (a window of rows, one PR's point reads,
// one listing's grouping) with a real event-loop turn (`yieldToLoop`) between
// them, and the longest is measured. Plan mode writes nothing: no file, no
// directory, no row.
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { StateStore } from "../state.js";
import { yieldToLoop } from "../yieldloop.js";
import { prEligibility, type IneligibleReason } from "./eligibility.js";
import { rowAge } from "./dbmove.js";
import { ARCHIVE_EVENT_KINDS } from "./kinds.js";
import { measureOverseer } from "./overseer.js";
import { measurePiGlobal } from "./piglobal.js";
import type { StoreTally } from "./storepass.js";
import {
  ARTIFACT_CLASSES,
  PR_DIR,
  SpanMeter,
  listLiveTree,
  prInventory,
  topLevelInjectFiles,
  type ArtifactClass,
} from "./prfiles.js";

export { ARTIFACT_CLASSES, SpanMeter, type ArtifactClass };

const DAY_MS = 86_400_000;

/** Rows per counting window: three narrow columns, a few ms on the VM. */
export const COUNT_WINDOW_ROWS = 2000;

/** The plan's own bound on the tmux ask, whatever answers it: past this, tmux
 * is UNKNOWN (every candidate holds `tmux_unknown`) and the plan goes on. A
 * little over `Tmux.listSessionsKnown`'s own kill, so the real one answers
 * null itself first. */
export const LIVE_SESSIONS_DEADLINE_MS = 12_000;

export interface Tally {
  files: number;
  bytes: number;
}

export interface PlannedPr {
  pr: number;
  closed_at: string | null;
  /** What the window counts from (the close, or a later restore). */
  since: string | null;
  files: number;
  bytes: number;
  artifacts: Partial<Record<ArtifactClass, Tally>>;
}

/** Why a closed PR past the window is not archived — the eligibility rule's
 * reasons, plus `unreadable` (its files could not be listed whole). */
export type PlanHoldReason = IneligibleReason | "unreadable";

export interface HeldPr {
  pr: number;
  reason: PlanHoldReason;
  reasons: PlanHoldReason[];
  detail?: string;
}

export interface RowBacklog {
  /** Qualifying rows: older than the cut-off (and, for events, of an
   * archivable kind), from the mover's watermark on. */
  rows: number;
  by_kind?: Record<string, number>;
  cutoff: string;
  /** The mover's watermark the count starts after (0 = nothing moved). */
  from_id: number;
  /** Rows this plan examined (a memo resumes the settled prefix). */
  examined: number;
  windows: number;
}

export interface ArchivePlan {
  computed_at: string;
  took_ms: number;
  after_days: number;
  events_after_days: number;
  files_cutoff: string;
  registry: {
    prs: number;
    open: number;
    closed: number;
    /** Closed, but inside the window. */
    waiting: number;
    eligible: number;
    held: number;
    /** Archived already, with nothing live left. */
    archived: number;
  };
  /** Eligible PRs with something to move, the oldest close first (the order
   * an archive pass takes them). */
  candidates: PlannedPr[];
  /** Eligible PRs with nothing live to move — they still get a zero-file
   * `archived` row (§7.4), so passes stop revisiting them. */
  empty: number[];
  held: HeldPr[];
  /** `pi-sessions/pr-<n>` dirs with no `pr_state` row: reported, never
   * touched. */
  orphans: string[];
  /** Over the candidates. */
  artifacts: Record<ArtifactClass, Tally>;
  /** `state/ledgers/pr-<n>.md` of the candidates: SNAPSHOTTED into the
   * bundle, the live file kept (the reopen continuity). */
  ledger_snapshots: Tally;
  /** `archive/pr-<n>/session.jsonl` of the candidates: the legacy copies
   * checked as duplicates of an archived transcript (§7.5). */
  legacy_copies: Tally;
  events: RowBacklog;
  deliveries: RowBacklog;
  backlog: { prs: number; bytes: number; event_rows: number; delivery_rows: number };
  /** False when the planner could not see the daemon's in-flight session
   * births (`qcr archive status --plan` runs in its own process); the daemon
   * re-checks them before anything moves. */
  births_observed: boolean;
  /** Whether tmux answered; "unknown" holds every candidate (`tmux_unknown`). */
  tmux: "answered" | "unknown";
  /** Do `archive/` and `state/` sit on one device? null when unknown. */
  same_device: boolean | null;
  /** The plan's longest synchronous span, measured. */
  max_sync_span_ms: number;
  /** The stores that belong to no PR (S4, §13): what is there and what a
   * pass would move. `pi_global` is null when the planner was given no store
   * dir. Absent from a plan an older build made. */
  stores?: { overseer: StoreTally; pi_global: StoreTally | null };
}

/** Carried between a daemon's plans: the settled prefix of each row count. */
export interface PlanMemo {
  events?: CountMemo;
  deliveries?: CountMemo;
}

interface CountMemo {
  watermark: number;
  cutoff: string;
  /** Every row with id ≤ this was examined and older than `cutoff`. */
  settledTo: number;
  rows: number;
  byKind: Record<string, number>;
}

export interface PlanDeps {
  store: StateStore;
  /** The sandbox root (`state/`, `inject/`, `verdict/`, `archive/` below it). */
  root: string;
  /** The pi session dirs' parent (`<root>/<[pi] session_dir>`). */
  sessionsRoot: string;
  now: () => Date;
  afterDays: number;
  eventsAfterDays: number;
  /** Live tmux session names; null = tmux could not be asked. */
  liveSessions: () => Promise<readonly string[] | null>;
  /** How long the plan waits for `liveSessions` before reading tmux as
   * UNKNOWN (default `LIVE_SESSIONS_DEADLINE_MS`). */
  liveSessionsDeadlineMs?: number;
  /** The daemon's in-flight births; absent = not observable (a CLI). */
  birthInFlight?: (pr: number) => boolean;
  /** In/out: the settled row-count prefixes from the previous plan. */
  memo?: PlanMemo;
  /** The overseer's birth (which of its files a pass may move); absent =
   * unknown here (a CLI) — the movable count is then null. */
  overseerBornAt?: () => Date | null;
  /** pi's global session store; absent = not measured. */
  piGlobalDir?: string;
  signal?: AbortSignal;
}

const emptyTally = (): Tally => ({ files: 0, bytes: 0 });
const add = (t: Tally, bytes: number): void => {
  t.files += 1;
  t.bytes += bytes;
};

/**
 * Ask which tmux sessions live — bounded and abortable. A throw, or no answer
 * by `deadlineMs`, is null (UNKNOWN, which holds every candidate), never
 * "none alive"; the plan's signal (the archiver's `stop()`) rejects at once,
 * so a hung tmux can neither wedge the strict mutex nor outlive a stop.
 */
export function askLiveSessions(
  ask: () => Promise<readonly string[] | null>,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<readonly string[] | null> {
  /** The abort's reason as an Error (a bare `abort()` gives a DOMException,
   * which is one). */
  const aborted = (): Error =>
    signal!.reason instanceof Error ? signal!.reason : new Error(String(signal!.reason));
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(aborted()));
    const timer = setTimeout(() => finish(() => resolvePromise(null)), deadlineMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    let asked: Promise<readonly string[] | null>;
    try {
      asked = ask();
    } catch {
      asked = Promise.resolve(null);
    }
    asked.then(
      (names) => finish(() => resolvePromise(names)),
      () => finish(() => resolvePromise(null)),
    );
  });
}

/** The device a path lives on — the nearest existing ancestor's, since a
 * directory not yet created will be created there. */
async function deviceOf(path: string): Promise<number | null> {
  let p = resolve(path);
  for (;;) {
    try {
      return (await stat(p)).dev;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const up = dirname(p);
      if (up === p) return null;
      p = up;
    }
  }
}

/**
 * Count the rows of `table` past the watermark that are older than `cutoff`
 * (and pass `keep`), in rowid windows; stop at the first window holding a
 * younger row. `memo` resumes after the prefix a previous count settled.
 */
async function countRows(
  store: StateStore,
  meter: SpanMeter,
  opts: {
    sql: string;
    watermark: number;
    cutoff: string;
    kinds: boolean;
    memo: CountMemo | undefined;
    /** The row holding the table's highest rowid never moves (deliveries). */
    keepNewest?: boolean;
    maxSql?: string;
    signal?: AbortSignal;
  },
): Promise<{ backlog: RowBacklog; memo: CountMemo }> {
  const cutoffMs = Date.parse(opts.cutoff);
  const reuse =
    opts.memo &&
    opts.memo.watermark === opts.watermark &&
    Date.parse(opts.memo.cutoff) <= cutoffMs &&
    opts.memo.settledTo >= opts.watermark;
  let from = reuse ? opts.memo!.settledTo : opts.watermark;
  let rows = reuse ? opts.memo!.rows : 0;
  const byKind: Record<string, number> = reuse ? { ...opts.memo!.byKind } : {};
  let settled: CountMemo = {
    watermark: opts.watermark,
    cutoff: opts.cutoff,
    settledTo: from,
    rows,
    byKind: { ...byKind },
  };
  const stmt = store.db.prepare(opts.sql).raw(true);
  const newest = opts.keepNewest
    ? meter.measure(
        () =>
          (store.db.prepare(opts.maxSql!).get() as { m: number | null } | undefined)?.m ??
          Number.POSITIVE_INFINITY,
      )
    : Number.POSITIVE_INFINITY;
  let examined = 0;
  let windows = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    const done = meter.measure(() => {
      const batch = stmt.all(from, COUNT_WINDOW_ROWS) as Array<[number, string, string | null]>;
      if (batch.length === 0) return true;
      windows += 1;
      examined += batch.length;
      // The mover's own rule (dbmove.ts): old rows of an archivable kind count
      // wherever they sit in the window; the count stops after the first window
      // holding a row younger than the cut-off (or, with `keepNewest`, the
      // table's highest rowid, which never moves); an undatable row is passed
      // over — never archived, never read as old, never a stop.
      let allOld = true;
      for (const [id, ts, kind] of batch) {
        const age = id >= newest ? "young" : rowAge(ts, cutoffMs);
        if (age === "young") {
          allOld = false;
          continue;
        }
        if (age === "undatable") continue;
        if (opts.kinds && !(kind !== null && ARCHIVE_EVENT_KINDS.has(kind))) continue;
        rows += 1;
        if (opts.kinds) byKind[kind!] = (byKind[kind!] ?? 0) + 1;
      }
      from = batch[batch.length - 1]![0];
      if (!allOld) return true;
      settled = {
        watermark: opts.watermark,
        cutoff: opts.cutoff,
        settledTo: from,
        rows,
        byKind: { ...byKind },
      };
      return batch.length < COUNT_WINDOW_ROWS;
    });
    if (done) break;
    await yieldToLoop();
  }
  return {
    backlog: {
      rows,
      ...(opts.kinds ? { by_kind: byKind } : {}),
      cutoff: opts.cutoff,
      from_id: opts.watermark,
      examined,
      windows,
    },
    memo: settled,
  };
}

/** A mover watermark from `archive_marks` (0 when absent or unreadable as a
 * number). */
function watermark(store: StateStore, name: string): number {
  const row = store.db.prepare("SELECT value FROM archive_marks WHERE name = ?").get(name) as
    { value: unknown } | undefined;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Compute the plan. Reads only; throws when a live directory cannot be
 * listed (an unreadable listing is never "nothing there"). */
export async function computePlan(deps: PlanDeps): Promise<ArchivePlan> {
  const t0 = performance.now();
  const meter = new SpanMeter();
  const { store, root, signal } = deps;
  const now = deps.now();
  const filesCutoff = new Date(now.getTime() - deps.afterDays * DAY_MS).toISOString();
  const eventsCutoff = new Date(now.getTime() - deps.eventsAfterDays * DAY_MS).toISOString();
  const stateDir = join(root, "state");

  // ---- the registry, and what tmux says is alive ---------------------------
  const registry = meter.measure(
    () =>
      store.db.prepare("SELECT number, state FROM pr_state").all() as Array<{
        number: number;
        state: string;
      }>,
  );
  const known = new Set(registry.map((r) => r.number));
  const archivedRows = meter.measure(
    () =>
      new Map(
        (
          store.db.prepare("SELECT pr, state FROM archive_prs").all() as Array<{
            pr: number;
            state: string;
          }>
        ).map((r) => [r.pr, r.state]),
      ),
  );
  const names = await askLiveSessions(
    deps.liveSessions,
    deps.liveSessionsDeadlineMs ?? LIVE_SESSIONS_DEADLINE_MS,
    signal,
  );
  const alive: Set<number> | null =
    names === null
      ? null
      : new Set(
          names.flatMap((n) => {
            const m = PR_DIR.exec(n);
            return m ? [Number(m[1])] : [];
          }),
        );

  // ---- one readdir per live directory, grouped by PR (prfiles.ts) -----------
  const listing = await listLiveTree(root, deps.sessionsRoot, meter);

  const orphans = [...listing.sessionDirs.keys()]
    .filter((pr) => !known.has(pr))
    .sort((a, b) => a - b)
    .map((pr) => `pr-${pr}`);

  // ---- every closed PR through the one rule ---------------------------------
  const counts = { open: 0, closed: 0, waiting: 0, eligible: 0, held: 0, archived: 0 };
  const eligible: Array<{
    pr: number;
    closed_at: string | null;
    since: string | null;
    stale: string[];
  }> = [];
  const held: HeldPr[] = [];
  for (const { number: pr, state } of registry) {
    if (state !== "closed") {
      counts.open += 1;
      continue;
    }
    counts.closed += 1;
    signal?.throwIfAborted();
    await yieldToLoop();
    // The PR's inject dir: its top-level wakes are an eligibility input.
    let injectFiles: string[] | null;
    try {
      injectFiles = await topLevelInjectFiles(listing.injectDirs.get(pr)?.[0]);
    } catch {
      injectFiles = null;
    }
    const e = meter.measure(() =>
      prEligibility(store, pr, {
        now,
        afterDays: deps.afterDays,
        outside: {
          tmuxAlive: alive === null ? null : alive.has(pr),
          birthInFlight: deps.birthInFlight?.(pr) ?? false,
          injectFiles,
        },
      }),
    );
    if (e.reasons.includes("closed_recently")) counts.waiting += 1;
    else if (!e.eligible) {
      counts.held += 1;
      held.push({ pr, reason: e.reason!, reasons: e.reasons });
    } else eligible.push({ pr, closed_at: e.closed_at, since: e.since, stale: e.stale_injects });
  }

  // ---- what each eligible PR would move ---------------------------------------
  eligible.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "") || a.pr - b.pr);
  const artifacts = Object.fromEntries(ARTIFACT_CLASSES.map((c) => [c, emptyTally()])) as Record<
    ArtifactClass,
    Tally
  >;
  const ledgerSnapshots = emptyTally();
  const legacyCopies = emptyTally();
  const candidates: PlannedPr[] = [];
  const empty: number[] = [];
  for (const c of eligible) {
    signal?.throwIfAborted();
    await yieldToLoop();
    const planned: PlannedPr = {
      pr: c.pr,
      closed_at: c.closed_at,
      since: c.since,
      files: 0,
      bytes: 0,
      artifacts: {},
    };
    const tally = (cls: ArtifactClass, bytes: number): void => {
      add((planned.artifacts[cls] ??= emptyTally()), bytes);
      planned.files += 1;
      planned.bytes += bytes;
    };
    const ledger: Tally = emptyTally();
    const legacy: Tally = emptyTally();
    try {
      const inv = await prInventory(listing, c.pr, {
        store,
        root,
        staleInjects: c.stale,
        signal,
        meter,
      });
      for (const t of inv.transcripts) tally("transcripts", t.size);
      for (const f of inv.small) tally(f.cls, f.size);
      if (inv.ledger) add(ledger, inv.ledger.size);
      if (inv.legacy) add(legacy, inv.legacy.size);
    } catch (err) {
      if (signal?.aborted) throw err;
      counts.held += 1;
      held.push({
        pr: c.pr,
        reason: "unreadable",
        reasons: ["unreadable"],
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    counts.eligible += 1;
    if (planned.files === 0) {
      // Archived already and nothing live left: not backlog.
      if (archivedRows.get(c.pr) === "archived") counts.archived += 1;
      else empty.push(c.pr);
      continue;
    }
    candidates.push(planned);
    for (const cls of ARTIFACT_CLASSES) {
      const t = planned.artifacts[cls];
      if (t) {
        artifacts[cls].files += t.files;
        artifacts[cls].bytes += t.bytes;
      }
    }
    ledgerSnapshots.files += ledger.files;
    ledgerSnapshots.bytes += ledger.bytes;
    legacyCopies.files += legacy.files;
    legacyCopies.bytes += legacy.bytes;
  }
  held.sort((a, b) => a.pr - b.pr);

  // ---- rows: the reader-less events, and the webhook deliveries -------------
  const events = await countRows(store, meter, {
    sql: "SELECT id, ts, kind FROM events WHERE id > ? ORDER BY id LIMIT ?",
    watermark: watermark(store, "events.last_id"),
    cutoff: eventsCutoff,
    kinds: true,
    memo: deps.memo?.events,
    signal,
  });
  const deliveries = await countRows(store, meter, {
    sql: "SELECT rowid, received_at, NULL FROM deliveries WHERE rowid > ? ORDER BY rowid LIMIT ?",
    watermark: watermark(store, "deliveries.last_rowid"),
    cutoff: filesCutoff,
    kinds: false,
    keepNewest: true,
    maxSql: "SELECT MAX(rowid) AS m FROM deliveries",
    memo: deps.memo?.deliveries,
    signal,
  });
  if (deps.memo) {
    deps.memo.events = events.memo;
    deps.memo.deliveries = deliveries.memo;
  }

  const [archiveDev, stateDev] = await Promise.all([
    deviceOf(join(root, "archive")),
    deviceOf(stateDir),
  ]);
  // The stores that belong to no PR (S4): listings and lstats only.
  const stores: NonNullable<ArchivePlan["stores"]> = {
    overseer: await measureOverseer({
      root,
      sessionsRoot: deps.sessionsRoot,
      ...(deps.overseerBornAt ? { bornAt: deps.overseerBornAt } : {}),
      ...(signal ? { signal } : {}),
    }),
    pi_global: deps.piGlobalDir
      ? await measurePiGlobal({
          storeDir: deps.piGlobalDir,
          now: deps.now,
          ...(signal ? { signal } : {}),
        })
      : null,
  };
  const bytes = candidates.reduce((n, c) => n + c.bytes, 0);
  return {
    computed_at: now.toISOString(),
    took_ms: Math.round(performance.now() - t0),
    after_days: deps.afterDays,
    events_after_days: deps.eventsAfterDays,
    files_cutoff: filesCutoff,
    registry: { prs: registry.length, ...counts },
    candidates,
    empty,
    held,
    orphans,
    artifacts,
    ledger_snapshots: ledgerSnapshots,
    legacy_copies: legacyCopies,
    events: events.backlog,
    deliveries: deliveries.backlog,
    backlog: {
      prs: candidates.length + empty.length,
      bytes,
      event_rows: events.backlog.rows,
      delivery_rows: deliveries.backlog.rows,
    },
    births_observed: deps.birthInFlight !== undefined,
    tmux: alive === null ? "unknown" : "answered",
    same_device: archiveDev === null || stateDev === null ? null : archiveDev === stateDev,
    max_sync_span_ms: Math.round(meter.max * 10) / 10,
    stores,
  };
}
