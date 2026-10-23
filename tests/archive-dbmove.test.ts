// The DB MOVER (docs/archiving.md §9.1–§9.3) on a seeded
// StateStore(":memory:") and a temp `archive/db/`: only the reader-less kinds
// older than `events_after_days` move, ids and DDL preserved; a crash at any
// step leaves every row in at least one place and a re-run converges; a
// locked archive month fails a batch fast and is reported; every batch is its
// own synchronous span with a turn between, sized to stay ≤ 25 ms; old
// deliveries move while a recent guid still dedupes; plan mode moves nothing.
import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Archiver, VERIFY_FAILURES_SQL } from "../src/archive/archiver.js";
import { ArchiveConn, ArchiveDb, monthFile } from "../src/archive/archivedb.js";
import {
  BATCH_PAUSE_MS,
  DB_SYNC_BUDGET_MS,
  MAX_BATCH_ROWS,
  MIN_BATCH_ROWS,
  fileRowsMark,
  rowAge,
  type BatchReport,
  type FaultPoint,
} from "../src/archive/dbmove.js";
import { ARCHIVE_EVENT_KINDS } from "../src/archive/kinds.js";
import type { ArchivePlan } from "../src/archive/plan.js";
import { ARCHIVE_DEFAULTS } from "../src/config.js";
import {
  DAY,
  T0,
  archived,
  ddl,
  iso,
  liveDeliveries,
  liveEvents,
  mark,
  rig,
  seedDeliveries,
  seedEvents,
  type Rig,
  type Row,
} from "./helpers/archive-rows.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.close();
});
const make = async (): Promise<Rig> => {
  const r = await rig();
  rigs.push(r);
  return r;
};

const OLD = T0 - 40 * DAY; // 2026-09-11 — past the 35-day cut-off
const YOUNG = T0 - 10 * DAY; // 2026-10-11 — inside it
const SEPT = (r: Rig): string => join(r.dir, monthFile("2026-09", 1));

const FACT_KINDS = [
  "pr_closed",
  "verdict_applied",
  "head_push",
  "anomaly",
  "pingpong_decision_applied",
];
const REGISTER_KINDS = ["overseer_heartbeat", "memory_incident", "round_memory_seeded"];

describe("what moves (acceptance 2)", () => {
  it(
    "only the allowlisted kinds older than events_after_days; facts, registers and young rows stay; ids and DDL preserved",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = await make();
      const rows: Array<[string, string, number | null, unknown]> = [];
      let k = 0;
      // Old rows of every kind, interleaved as the live table interleaves them.
      for (let i = 0; i < 3; i++) {
        for (const kind of [
          ...ARCHIVE_EVENT_KINDS,
          ...FACT_KINDS,
          ...REGISTER_KINDS,
          "comment_sweep",
        ])
          rows.push([iso(OLD + k++ * 60_000), kind, 100 + i, { i, kind }]);
      }
      // An undatable row of an archivable kind, among the old ones: passed
      // over and kept live — never archived on a guess, never a wedge.
      rows.push(["not a date", "webhook_event", null, undefined]);
      // Young rows of the archivable kinds.
      for (const kind of ARCHIVE_EVENT_KINDS)
        rows.push([iso(YOUNG + k++ * 60_000), kind, 7, { young: true }]);
      seedEvents(r.store, rows);
      const before = liveEvents(r.store);
      const newestRegister = Object.fromEntries(
        REGISTER_KINDS.map((kind) => [kind, r.store.lastEventPayload(kind)]),
      );

      const res = await r.mover().run();
      expect(res.outcome).toBe("caught_up");
      expect(res.skipped_reason).toBeNull();

      const after = liveEvents(r.store);
      const movedExpected = before.filter(
        (e) =>
          ARCHIVE_EVENT_KINDS.has(e.kind as string) && Date.parse(e.ts as string) < T0 - 35 * DAY,
      );
      expect(movedExpected).toHaveLength(3 * ARCHIVE_EVENT_KINDS.size);
      expect(res.events.moved).toBe(movedExpected.length);
      expect(res.events.undatable).toBe(1);
      // Live keeps everything else, untouched.
      const movedIds = new Set(movedExpected.map((e) => e.id));
      expect(after).toEqual(before.filter((e) => !movedIds.has(e.id)));
      for (const kind of [...FACT_KINDS, ...REGISTER_KINDS, "comment_sweep"])
        expect(
          after.filter((e) => e.kind === kind),
          kind,
        ).toHaveLength(3);
      for (const kind of REGISTER_KINDS)
        expect(r.store.lastEventPayload(kind), kind).toEqual(newestRegister[kind]);
      for (const kind of ARCHIVE_EVENT_KINDS)
        expect(
          after.filter(
            (e) => e.kind === kind && ((e.payload as string | null) ?? "").includes("young"),
          ),
        ).toHaveLength(1);
      expect(after.some((e) => e.ts === "not a date")).toBe(true);

      // The archive holds exactly the moved rows, original ids and bytes.
      expect(archived(SEPT(r), "events")).toEqual(movedExpected);
      // Same schema: the archive table's DDL is the live one, verbatim.
      const db = new Database(SEPT(r), { timeout: 0 });
      try {
        expect(ddl(db, "events")).toBe(ddl(r.store.db, "events"));
      } finally {
        db.close();
      }
      // The rollup, the running total and the watermark.
      const counts = r.store.db
        .prepare("SELECT kind, day, n FROM archived_event_counts ORDER BY kind")
        .all() as Array<{ kind: string; day: string; n: number }>;
      expect(counts).toEqual(
        [...ARCHIVE_EVENT_KINDS].sort().map((kind) => ({ kind, day: "2026-09-11", n: 3 })),
      );
      expect(Number(mark(r.store, fileRowsMark(monthFile("2026-09", 1), "events")))).toBe(
        movedExpected.length,
      );
      expect(mark(r.store, "events.caught_up_to")).toBe(iso(T0 - 35 * DAY));
      // The watermark stopped before the first young row, past the undatable one.
      const firstYoung = before.find(
        (e) => e.ts !== "not a date" && Date.parse(e.ts as string) >= T0 - 35 * DAY,
      )!;
      expect(Number(mark(r.store, "events.last_id"))).toBe(Number(firstYoung.id) - 1);

      // A second run finds nothing more: the same rows, no new archive rows.
      const again = await r.mover().run();
      expect(again).toMatchObject({
        outcome: "caught_up",
        events: { moved: 0 },
        deliveries: { moved: 0 },
      });
      expect(liveEvents(r.store)).toEqual(after);
      expect(archived(SEPT(r), "events")).toHaveLength(movedExpected.length);
    },
  );

  it("rowAge: old, young, and undatable — an undatable row is never read as old", () => {
    const cut = T0 - 35 * DAY;
    expect(rowAge(iso(cut - 1), cut)).toBe("old");
    expect(rowAge(iso(cut), cut)).toBe("young");
    expect(rowAge("garbage", cut)).toBe("undatable");
    expect(rowAge(null, cut)).toBe("undatable");
  });

  it("an old row past a young one inside the window still moves; the watermark stays before the young one", async () => {
    const r = await make();
    seedEvents(r.store, [
      [iso(OLD), "webhook_event"],
      [iso(YOUNG), "webhook_event"], // a clock step: young, then old again
      [iso(OLD + 1000), "recheck_noop"],
    ]);
    const res = await r.mover().run();
    expect(res).toMatchObject({ outcome: "caught_up", events: { moved: 2 } });
    expect(liveEvents(r.store).map((e) => e.ts)).toEqual([iso(YOUNG)]);
    expect(Number(mark(r.store, "events.last_id"))).toBe(1);
  });

  it("rows of two months land in two files, each with its own running total", async () => {
    const r = await make();
    seedEvents(r.store, [
      [iso(Date.parse("2026-08-30T10:00:00Z")), "ci_completed"],
      [iso(Date.parse("2026-09-02T10:00:00Z")), "ci_completed"],
      [iso(Date.parse("2026-09-03T10:00:00Z")), "ci_completed"],
    ]);
    expect((await r.mover().run()).events.moved).toBe(3);
    expect(archived(join(r.dir, monthFile("2026-08", 1)), "events")).toHaveLength(1);
    expect(archived(SEPT(r), "events")).toHaveLength(2);
    expect(Number(mark(r.store, fileRowsMark(monthFile("2026-08", 1), "events")))).toBe(1);
    expect(Number(mark(r.store, fileRowsMark(monthFile("2026-09", 1), "events")))).toBe(2);
    expect(r.adb.files().map((f) => [f.file, f.state])).toEqual([
      ["state-2026-08.sqlite", "open"],
      ["state-2026-09.sqlite", "open"],
    ]);
  });
});

describe("crash at any step — every row in at least one place; a re-run converges (acceptance 3)", () => {
  const POINTS: FaultPoint[] = [
    "after_archive_commit",
    "after_fsync",
    "after_verify",
    "after_live_delete",
    "before_watermark",
    "after_live_commit",
  ];

  for (const point of POINTS) {
    it(`a crash ${point.replace(/_/g, " ")}`, { timeout: HEAVY_TIMEOUT_MS }, async () => {
      const r = await make();
      const rows: Array<[string, string, number | null, unknown]> = [];
      for (let i = 0; i < 1200; i++) {
        rows.push([iso(OLD + i * 1000), "pingpong_decision_failed", 5, { i }]);
        if (i % 7 === 0) rows.push([iso(OLD + i * 1000 + 1), "verdict_applied", 5, { i }]);
      }
      seedEvents(r.store, rows);
      const original = liveEvents(r.store);
      const archivable = original.filter((e) => e.kind === "pingpong_decision_failed");
      // The crash hits the SECOND batch.
      let hits = 0;
      const res = await r
        .mover({
          batchRows: 500,
          fault: (p) => {
            if (p === point && ++hits === 2) throw new Error(`crash ${point}`);
          },
        })
        .run();
      expect(res.outcome).toBe("failed");
      expect(res.error).toBe(`crash ${point}`);

      // No loss: every original id is live, archived, or both — never neither.
      const live = new Map(liveEvents(r.store).map((e) => [e.id, e]));
      const arch = new Map(archived(SEPT(r), "events").map((e) => [e.id, e]));
      for (const e of original)
        expect(live.has(e.id) || arch.has(e.id), `id ${String(e.id)}`).toBe(true);
      // Distinct ids across both places = the original count, and whatever sits
      // in both is the interrupted batch only (§9.2: "both, never neither").
      const both = [...arch.keys()].filter((id) => live.has(id));
      expect(live.size + arch.size - both.length).toBe(original.length);
      if (point === "after_live_commit") expect(both).toEqual([]);
      else expect(both.length).toBeGreaterThan(0);
      // An archived row is byte-identical to its original.
      const byId = new Map(original.map((e) => [e.id, e]));
      for (const [id, e] of arch) expect(e).toEqual(byId.get(id));

      // The restart: a fresh archive connection and mover converge.
      await r.reopen();
      const rerun = await r.mover().run();
      expect(rerun.outcome).toBe("caught_up");
      const liveAfter = liveEvents(r.store);
      const archAfter = archived(SEPT(r), "events");
      expect(liveAfter.length + archAfter.length).toBe(original.length); // exact: no duplicate
      expect(archAfter).toEqual(archivable); // no loss, ids and bytes preserved
      expect(liveAfter).toEqual(original.filter((e) => e.kind === "verdict_applied"));
      // The rollup and the running total each count every row exactly once.
      const n = (
        r.store.db.prepare("SELECT SUM(n) AS n FROM archived_event_counts").get() as { n: number }
      ).n;
      expect(n).toBe(archivable.length);
      expect(Number(mark(r.store, fileRowsMark(monthFile("2026-09", 1), "events")))).toBe(
        archivable.length,
      );
    });
  }
});

describe("a locked archive month (acceptance 4)", () => {
  it("fails the batch fast — no wait, no throw, nothing deleted — and a later run moves it", async () => {
    const r = await make();
    seedEvents(r.store, [
      [iso(OLD), "webhook_event"],
      [iso(OLD + 1000), "webhook_event"],
    ]);
    const conn = await r.adb.target("2026-09"); // the month's file exists
    expect(conn.file).toBe("state-2026-09.sqlite");
    const other = new Database(SEPT(r), { timeout: 0 });
    other.exec("BEGIN IMMEDIATE"); // an analyst holds the write lock
    try {
      const before = liveEvents(r.store);
      const t0 = Date.now();
      const res = await r.mover().run();
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(res).toMatchObject({ outcome: "skipped", skipped_reason: "archive_busy" });
      expect(res.error).toMatch(/locked/);
      expect(liveEvents(r.store)).toEqual(before);
      expect(mark(r.store, "events.last_id")).toBeUndefined();
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(await r.mover().run()).toMatchObject({ outcome: "caught_up", events: { moved: 2 } });
  });

  it("a refusal confined to one table (its month locked) lets the other table move", async () => {
    const r = await make();
    seedEvents(r.store, [[iso(OLD), "webhook_event"]]); // 2026-09
    seedDeliveries(r.store, [
      ["old", iso(T0 - 20 * DAY)], // 2026-10
      ["newest", iso(T0 - DAY)],
    ]);
    await r.adb.target("2026-09");
    const other = new Database(SEPT(r), { timeout: 0 });
    other.exec("BEGIN IMMEDIATE");
    try {
      const res = await r.mover().run();
      expect(res).toMatchObject({
        outcome: "skipped",
        skipped_reason: "archive_busy",
        events: { moved: 0 },
        deliveries: { moved: 1, caught_up: true },
      });
      expect(res.skips).toEqual([
        expect.objectContaining({
          table: "events",
          reason: "archive_busy",
          file: monthFile("2026-09", 1),
        }),
      ]);
      expect(liveDeliveries(r.store).map((d) => d.guid)).toEqual(["newest"]);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });

  it("the archiver's tick is not failed by it: it is skipped and reported in status.db", async () => {
    const r = await make();
    seedEvents(r.store, [[iso(OLD), "webhook_event"]]);
    await r.adb.target("2026-09");
    r.adb.close();
    const other = new Database(SEPT(r), { timeout: 0 });
    other.exec("BEGIN IMMEDIATE");
    const logs: string[] = [];
    const a = new Archiver({
      store: r.store,
      cfg: { ...ARCHIVE_DEFAULTS, mode: "on" },
      root: r.root,
      sessionsRoot: join(r.root, "state", "pi-sessions"),
      firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      plan: async () => fakePlan(),
      now: () => new Date(T0),
      sleep: async () => {},
      schedule: () => () => {},
      log: (m) => logs.push(m),
    });
    try {
      const tick = await a.tick();
      expect(tick.state).toBe("idle");
      expect(a.status()).toMatchObject({
        state: "idle",
        last_error: null,
        db: { outcome: "skipped", skipped_reason: "archive_busy", events_moved: 0 },
      });
      expect(logs.some((l) => /db batch SKIPPED \(archive_busy\)/.test(l))).toBe(true);
      expect(liveEvents(r.store).filter((e) => e.kind === "webhook_event")).toHaveLength(1);
    } finally {
      other.exec("ROLLBACK");
      other.close();
      a.stop();
    }
  });
});

describe("every batch is its own bounded span (acceptance 5)", () => {
  /** How many real event-loop turns ran while `fn` did, and at which turn
   * each batch ended (the deleted receipt scan test's counter). */
  async function counting<T>(
    fn: (turn: () => number) => Promise<T>,
  ): Promise<{ out: T; turns: number }> {
    let turns = 0;
    let on = true;
    const tick = (): void => {
      turns++;
      if (on) setImmediate(tick);
    };
    setImmediate(tick);
    try {
      const out = await fn(() => turns);
      return { out, turns };
    } finally {
      on = false;
    }
  }

  it(
    "a 20,000-row move yields at least once per batch, and no synchronous span covers two batches",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = await make();
      const rows: Array<[string, string, number | null, unknown]> = [];
      for (let i = 0; i < 20_000; i++)
        rows.push([iso(OLD + i * 10), "webhook_event", null, { guid: `g${i}` }]);
      seedEvents(r.store, rows);
      const batches: Array<BatchReport & { turn: number }> = [];
      // The order of batches and pauses: one BATCH_PAUSE_MS pause between
      // any two batches, none after the last.
      const seq: string[] = [];
      const { turns } = await counting(async (turn) => {
        for (let runs = 0; runs < 20; runs++) {
          const res = await r
            .mover({
              onBatch: (b) => {
                batches.push({ ...b, turn: turn() });
                seq.push("batch");
              },
              sleep: async (ms) => {
                seq.push(`sleep ${ms}`);
              },
            })
            .run();
          if (res.outcome === "caught_up") return;
          expect(res.outcome).toBe("budget");
        }
        throw new Error("never caught up");
      });
      expect(seq).toEqual(
        batches.flatMap((_b, i) => (i === 0 ? ["batch"] : [`sleep ${BATCH_PAUSE_MS}`, "batch"])),
      );
      expect(liveEvents(r.store)).toHaveLength(0);
      expect(archived(SEPT(r), "events")).toHaveLength(20_000);
      expect(batches.reduce((n, b) => n + b.moved, 0)).toBe(20_000);
      expect(batches.length).toBeGreaterThanOrEqual(20_000 / MAX_BATCH_ROWS);
      // At least one real turn per batch…
      expect(turns).toBeGreaterThanOrEqual(batches.length);
      // …and between any two batches: no synchronous span reaches across.
      for (let i = 1; i < batches.length; i++)
        expect(batches[i]!.turn, `batch ${i}`).toBeGreaterThan(batches[i - 1]!.turn);
    },
  );

  it(
    "a long run of rows with nothing to move still yields between windows — never one span",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = await make();
      const rows: Array<[string, string, number | null, unknown]> = [];
      for (let i = 0; i < 20_000; i++) rows.push([iso(OLD + i * 10), "verdict_applied", 1, { i }]);
      seedEvents(r.store, rows);
      const { out, turns } = await counting(() => r.mover().run());
      expect(out).toMatchObject({ outcome: "caught_up", events: { moved: 0, examined: 20_000 } });
      // At least one real turn per window: ≥ 10 windows at the 2000-row cap.
      expect(turns).toBeGreaterThanOrEqual(20_000 / MAX_BATCH_ROWS);
      expect(liveEvents(r.store)).toHaveLength(20_000);
    },
  );

  it("a span over 25 ms halves the batch (floor 100); spans well under it grow it (cap 2000)", async () => {
    const r = await make();
    const rows: Array<[string, string, number | null, unknown]> = [];
    for (let i = 0; i < 3000; i++) rows.push([iso(OLD + i * 10), "recheck_noop", null, null]);
    seedEvents(r.store, rows);
    // A fake clock: every synchronous call measures 30 ms.
    let t = 0;
    const slow: number[] = [];
    const res = await r
      .mover({ clock: () => (t += 30), onBatch: (b) => slow.push(b.next_batch_rows) })
      .run();
    expect(slow.slice(0, 4)).toEqual([250, 125, MIN_BATCH_ROWS, MIN_BATCH_ROWS]);
    // ~5 calls of 30 ms a batch: the 2 s synchronous budget ends the run.
    expect(res.outcome).toBe("budget");
    expect(res.sync_ms).toBeGreaterThanOrEqual(DB_SYNC_BUDGET_MS);
    // The result says WHICH budget stopped the run.
    expect(res.error).toBe("synchronous budget spent");
    expect(res.max_span_ms).toBe(30);
    // A run the budget cut never records its frontier: rows older than the
    // cut-off are still live and unexamined, so no month may seal on it.
    expect(mark(r.store, "events.caught_up_to")).toBeUndefined();
    expect(mark(r.store, "deliveries.caught_up_to")).toBeUndefined();
    expect(Number(mark(r.store, "events.last_id"))).toBe(res.events.examined);

    // A fast clock (1 ms a call) grows it back by half each batch, to the cap.
    let u = 0;
    const fast: number[] = [];
    const r2 = await make();
    seedEvents(r2.store, rows);
    await r2.mover({ clock: () => (u += 1), onBatch: (b) => fast.push(b.next_batch_rows) }).run();
    expect(fast.slice(0, 4)).toEqual([750, 1125, 1688, MAX_BATCH_ROWS]);
  });

  it("a hold or a stop between batches ends the run — nothing half-done", async () => {
    const r = await make();
    const rows: Array<[string, string, number | null, unknown]> = [];
    for (let i = 0; i < 1500; i++) rows.push([iso(OLD + i * 10), "ci_completed", null, null]);
    seedEvents(r.store, rows);
    let held: string | null = null;
    const res = await r
      .mover({
        hold: () => held,
        onBatch: () => {
          held = "draining";
        },
      })
      .run();
    expect(res).toMatchObject({ outcome: "held", events: { moved: 500, batches: 1 } });
    // The settled watermark was kept on the way out — the frontier was not.
    expect(Number(mark(r.store, "events.last_id"))).toBe(500);
    expect(mark(r.store, "events.caught_up_to")).toBeUndefined();
    const ac = new AbortController();
    const res2 = await r.mover({ signal: ac.signal, onBatch: () => ac.abort() }).run();
    expect(res2).toMatchObject({ outcome: "aborted", events: { moved: 500 } });
    expect(liveEvents(r.store).length + archived(SEPT(r), "events").length).toBe(1500);
  });

  it("the disk is re-read before every batch: no room ends the run held", async () => {
    const r = await make();
    const rows: Array<[string, string, number | null, unknown]> = [];
    for (let i = 0; i < 1500; i++) rows.push([iso(OLD + i * 10), "ci_completed", null, null]);
    seedEvents(r.store, rows);
    let room: string | null = null;
    let asked = 0;
    const res = await r
      .mover({
        room: async () => {
          asked += 1;
          return room;
        },
        onBatch: () => {
          room = "disk_low";
        },
      })
      .run();
    expect(res).toMatchObject({ outcome: "held", events: { moved: 500, batches: 1 } });
    expect(asked).toBe(2);
    // The settled watermark was kept on the way out, as for any hold.
    expect(Number(mark(r.store, "events.last_id"))).toBe(500);
    expect(liveEvents(r.store).length + archived(SEPT(r), "events").length).toBe(1500);
  });

  it("a stop between the read-back and the live delete deletes nothing", async () => {
    const r = await make();
    seedEvents(r.store, [
      [iso(OLD), "webhook_event"],
      [iso(OLD + 1), "webhook_event"],
    ]);
    const ac = new AbortController();
    const res = await r
      .mover({
        signal: ac.signal,
        fault: (p) => {
          if (p === "after_verify") ac.abort();
        },
      })
      .run();
    expect(res.outcome).toBe("aborted");
    expect(liveEvents(r.store)).toHaveLength(2);
    expect(archived(SEPT(r), "events")).toHaveLength(2); // copied, not yet deleted
    expect(mark(r.store, "events.last_id")).toBeUndefined();
    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM archived_event_counts").get()).toEqual({
      n: 0,
    });
  });

  it("a live delete that does not remove exactly the rows copied rolls back (live_changed)", async () => {
    const r = await make();
    seedEvents(r.store, [
      [iso(OLD), "webhook_event"],
      [iso(OLD + 1), "webhook_event"],
      [iso(OLD + 2), "webhook_event"],
    ]);
    const res = await r
      .mover({
        fault: (p) => {
          // Another writer removes one of the batch's rows after it was copied.
          if (p === "after_fsync") r.store.db.prepare("DELETE FROM events WHERE id = 2").run();
        },
      })
      .run();
    expect(res).toMatchObject({ outcome: "skipped", skipped_reason: "live_changed" });
    expect(res.error).toMatch(/removed 2 row\(s\), not the 3 copied — rolled back/);
    expect(liveEvents(r.store).map((e) => e.id)).toEqual([1, 3]);
    expect(mark(r.store, "events.last_id")).toBeUndefined();
    expect(mark(r.store, fileRowsMark(monthFile("2026-09", 1), "events"))).toBeUndefined();
    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM archived_event_counts").get()).toEqual({
      n: 0,
    });
  });

  it("a failed fsync of the archive WAL is the durability barrier: nothing live is deleted", async () => {
    const r = await make();
    seedEvents(r.store, [[iso(OLD), "webhook_event"]]);
    seedDeliveries(r.store, [
      ["old", iso(T0 - 30 * DAY)],
      ["newest", iso(T0 - DAY)],
    ]);
    const before = { e: liveEvents(r.store), d: liveDeliveries(r.store) };
    const sync = vi
      .spyOn(ArchiveConn.prototype, "syncWal")
      .mockRejectedValue(new Error("EIO: i/o error, fsync"));
    try {
      const res = await r.mover().run();
      expect(res).toMatchObject({ outcome: "skipped", skipped_reason: "wal_sync_failed" });
      expect(res.error).toMatch(/fsync of the WAL failed: EIO/);
      // Not confined to one table: the run stops (deliveries are not tried).
      expect(res.skips.map((x) => x.table)).toEqual(["events"]);
      expect(liveEvents(r.store)).toEqual(before.e);
      expect(liveDeliveries(r.store)).toEqual(before.d);
      expect(mark(r.store, "events.last_id")).toBeUndefined();
    } finally {
      sync.mockRestore();
    }
  });

  it("a column the live table gained after the month's file was made is added to it — never a wedge, never a lost value", async () => {
    const r = await make();
    seedEvents(r.store, [[iso(OLD), "webhook_event", 1, { a: 1 }]]);
    const mover = r.mover();
    expect((await mover.run()).events.moved).toBe(1);
    // A migration, in this process: the same mover and the same open file.
    r.store.db.exec("ALTER TABLE events ADD COLUMN note TEXT NOT NULL DEFAULT 'none'");
    r.store.db
      .prepare(
        "INSERT INTO events (ts, kind, pr, payload, note) VALUES (?, 'webhook_event', 2, NULL, 'kept')",
      )
      .run(iso(OLD + 1));
    const res = await mover.run();
    expect(res).toMatchObject({ outcome: "caught_up", events: { moved: 1 } });
    const db = new Database(SEPT(r), { readonly: true });
    try {
      expect(db.prepare("SELECT id, note FROM events ORDER BY id").all()).toEqual([
        { id: 1, note: "none" },
        { id: 2, note: "kept" },
      ]);
    } finally {
      db.close();
    }
  });

  it("after a checkpoint the WAL restarts small: one checkpoint, not one per later batch", async () => {
    const r = await make();
    const rows: Array<[string, string, number | null, unknown]> = [];
    for (let i = 0; i < 500; i++)
      rows.push([iso(OLD + i * 10), "webhook_event", null, { pad: "x".repeat(4000) }]);
    for (let i = 500; i < 4500; i++) rows.push([iso(OLD + i * 10), "webhook_event", null, null]);
    seedEvents(r.store, rows);
    const threshold = 1024 * 1024;
    const syncDb = vi.spyOn(ArchiveConn.prototype, "syncDb");
    try {
      const res = await r.mover({ checkpointWalBytes: threshold }).run();
      expect(res).toMatchObject({ outcome: "caught_up", events: { moved: 4500 } });
      expect(res.events.batches).toBeGreaterThan(2);
      // One fsync when the file was made, one after the single checkpoint.
      expect(syncDb).toHaveBeenCalledTimes(2);
      expect(statSync(`${SEPT(r)}-wal`).size).toBeLessThan(threshold);
    } finally {
      syncDb.mockRestore();
    }
  });

  it("past the WAL threshold a PASSIVE checkpoint copies the pages into the file", async () => {
    const r = await make();
    const rows: Array<[string, string, number | null, unknown]> = [];
    for (let i = 0; i < 600; i++)
      rows.push([iso(OLD + i * 10), "webhook_event", null, { pad: "x".repeat(200) }]);
    seedEvents(r.store, rows);
    await r.mover({ checkpointWalBytes: Number.POSITIVE_INFINITY }).run();
    const noCheckpoint = statSync(SEPT(r)).size;
    const r2 = await make();
    seedEvents(r2.store, rows);
    await r2.mover({ checkpointWalBytes: 1 }).run();
    expect(statSync(join(r2.dir, monthFile("2026-09", 1))).size).toBeGreaterThan(noCheckpoint);
  });

  it("a row read back different from live is a verify failure: nothing deleted, the run skipped — the deliveries still move", async () => {
    const r = await make();
    seedEvents(r.store, [[iso(OLD), "webhook_event", 1, { real: true }]]);
    seedDeliveries(r.store, [
      ["old", iso(T0 - 30 * DAY)],
      ["newest", iso(T0 - DAY)],
    ]);
    const conn = await r.adb.target("2026-09");
    conn.db.exec(
      `${ddl(r.store.db, "events")}; INSERT INTO events (id, ts, kind, pr, payload) VALUES (1, '${iso(OLD)}', 'webhook_event', 1, '{"forged":true}')`,
    );
    conn.refreshTables();
    const res = await r.mover().run();
    expect(res).toMatchObject({
      outcome: "skipped",
      skipped_reason: "verify_mismatch",
      verify_mismatches: 1,
      deliveries: { moved: 1 },
    });
    expect(res.skips).toEqual([
      expect.objectContaining({
        table: "events",
        reason: "verify_mismatch",
        file: monthFile("2026-09", 1),
      }),
    ]);
    expect(liveEvents(r.store)).toHaveLength(1);
    expect(liveDeliveries(r.store).map((d) => d.guid)).toEqual(["newest"]);
  });
});

describe("deliveries (acceptance 6)", () => {
  it("rows older than after_days move; a guid received within 3 days still dedupes", async () => {
    const r = await make();
    seedDeliveries(r.store, [
      ["old-1", iso(T0 - 30 * DAY)],
      ["old-2", iso(T0 - 20 * DAY)],
      ["mid-1", iso(T0 - 10 * DAY)],
      ["recent-1", iso(T0 - 2 * DAY)],
    ]);
    const before = liveDeliveries(r.store);
    const res = await r.mover().run();
    expect(res).toMatchObject({ outcome: "caught_up", deliveries: { moved: 2, caught_up: true } });
    expect(liveDeliveries(r.store).map((d) => d.guid)).toEqual(["mid-1", "recent-1"]);
    // Moved with their rowids into their month (2026-09: both), same DDL.
    expect(archived(SEPT(r), "deliveries")).toEqual(before.slice(0, 1));
    expect(archived(join(r.dir, monthFile("2026-10", 1)), "deliveries")).toEqual(
      before.slice(1, 2),
    );
    const db = new Database(SEPT(r), { timeout: 0 });
    try {
      expect(ddl(db, "deliveries")).toBe(ddl(r.store.db, "deliveries"));
    } finally {
      db.close();
    }
    expect(Number(mark(r.store, "deliveries.archived_rows"))).toBe(2);
    // GitHub redelivers only within 3 days: a recent guid is still a duplicate…
    expect(r.store.recordDelivery("recent-1", "pull_request", "opened")).toBe(false);
    expect(r.store.recordDelivery("mid-1", "pull_request", "opened")).toBe(false);
    // …and nothing GitHub can redeliver was moved.
    expect(
      liveDeliveries(r.store).every((d) => Date.parse(d.received_at as string) >= T0 - 14 * DAY),
    ).toBe(true);
  });

  it("the delivery with the highest rowid never moves, however old — SQLite would reuse its rowid", async () => {
    const r = await make();
    seedDeliveries(r.store, [
      ["a", iso(T0 - 30 * DAY)],
      ["b", iso(T0 - 29 * DAY)],
      ["c", iso(T0 - 28 * DAY)],
    ]);
    const res = await r.mover().run();
    expect(res.deliveries).toMatchObject({ moved: 2, caught_up: true });
    expect(liveDeliveries(r.store).map((d) => d.guid)).toEqual(["c"]);
    // The next delivery takes a rowid past every archived one.
    r.store.recordDelivery("d", "pull_request", "opened");
    const rows = liveDeliveries(r.store);
    expect(Number(rows[rows.length - 1]!.rid)).toBe(4);
  });
});

describe("plan mode moves nothing (acceptance 9)", () => {
  it("a plan tick leaves every row live and creates no archive/db", async () => {
    const r = await make();
    seedEvents(r.store, [
      [iso(OLD), "webhook_event"],
      [iso(OLD + 1), "pingpong_decision_failed"],
    ]);
    seedDeliveries(r.store, [
      ["old", iso(T0 - 30 * DAY)],
      ["new", iso(T0 - DAY)],
    ]);
    r.adb.close();
    const { rmSync } = await import("node:fs");
    rmSync(r.dir, { recursive: true, force: true });
    const before = { e: liveEvents(r.store), d: liveDeliveries(r.store) };
    const a = new Archiver({
      store: r.store,
      cfg: { ...ARCHIVE_DEFAULTS, mode: "plan" },
      root: r.root,
      sessionsRoot: join(r.root, "state", "pi-sessions"),
      firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      plan: async () => fakePlan(),
      now: () => new Date(T0),
      schedule: () => () => {},
    });
    expect((await a.tick()).state).toBe("plan");
    expect(a.status().db).toBeNull();
    expect(liveEvents(r.store)).toEqual(before.e);
    expect(liveDeliveries(r.store)).toEqual(before.d);
    expect(existsSync(r.dir)).toBe(false);
    expect(r.store.db.prepare("SELECT COUNT(*) AS n FROM archive_marks").get()).toEqual({ n: 0 });
  });
});

describe("the archiver's DB phase, end to end", () => {
  it("an idle tick at the same outcome logs nothing: no 'db' line a minute forever", async () => {
    const r = await make();
    r.adb.close();
    const logs: string[] = [];
    const a = new Archiver({
      store: r.store,
      cfg: { ...ARCHIVE_DEFAULTS, mode: "on" },
      root: r.root,
      sessionsRoot: join(r.root, "state", "pi-sessions"),
      firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      plan: async () => fakePlan(),
      now: () => new Date(T0),
      sleep: async () => {},
      schedule: () => () => {},
      log: (m) => logs.push(m),
    });
    try {
      await a.tick();
      await a.tick();
      await a.tick();
      expect(logs.filter((l) => l.startsWith("archive: db —"))).toHaveLength(1);
      seedEvents(r.store, [[iso(OLD), "webhook_event"]]);
      await a.tick();
      // work done always logs, whatever the shape
      expect(logs.filter((l) => l.startsWith("archive: db —"))).toHaveLength(2);
    } finally {
      a.stop();
    }
  });

  it("mode on: moves, logs one archive_pass, reports status.db and the totals, and the backlog falls", async () => {
    const r = await make();
    seedEvents(r.store, [
      [iso(OLD), "webhook_event"],
      [iso(OLD + 1), "ci_completed"],
      [iso(OLD + 2), "verdict_applied"],
    ]);
    seedDeliveries(r.store, [
      ["old", iso(T0 - 30 * DAY)],
      ["new", iso(T0 - DAY)],
    ]);
    r.adb.close();
    const a = new Archiver({
      store: r.store,
      cfg: { ...ARCHIVE_DEFAULTS, mode: "on" },
      root: r.root,
      sessionsRoot: join(r.root, "state", "pi-sessions"),
      firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      plan: async () => fakePlan({ event_rows: 2, delivery_rows: 1 }),
      now: () => new Date(T0),
      sleep: async () => {},
      schedule: () => () => {},
    });
    try {
      expect((await a.tick()).state).toBe("idle");
      const s = a.status();
      expect(s.db).toMatchObject({
        outcome: "caught_up",
        skipped_reason: null,
        events_moved: 2,
        deliveries_moved: 1,
        months_open: 1,
        months_sealed: 0,
      });
      expect(s.totals).toMatchObject({ event_rows: 2, delivery_rows: 1 });
      expect(s.verify_failures_24h).toBe(0);
      expect(typeof s.freelist_pages).toBe("number");
      const passes = r.store.db
        .prepare("SELECT payload FROM events WHERE kind = 'archive_pass'")
        .all() as Array<{ payload: string }>;
      expect(passes).toHaveLength(1);
      expect(JSON.parse(passes[0]!.payload)).toMatchObject({
        events_moved: 2,
        deliveries_moved: 1,
      });
      // The plan ran after the DB phase in this tick, so its backlog is fresh;
      // a stale one would be reduced by what moved since.
      expect(s.backlog).toMatchObject({ event_rows: 2, delivery_rows: 1 });
    } finally {
      a.stop();
    }
  });

  it("a verify failure raises the quiet archive_verify_failed anomaly and counts in verify_failures_24h", async () => {
    const r = await make();
    seedEvents(r.store, [[iso(OLD), "webhook_event", 1, { real: true }]]);
    const conn = await r.adb.target("2026-09");
    conn.db.exec(
      `${ddl(r.store.db, "events")}; INSERT INTO events (id, ts, kind, pr, payload) VALUES (1, 'x', 'webhook_event', 1, NULL)`,
    );
    r.adb.close();
    const a = new Archiver({
      store: r.store,
      cfg: { ...ARCHIVE_DEFAULTS, mode: "on" },
      root: r.root,
      sessionsRoot: join(r.root, "state", "pi-sessions"),
      firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      plan: async () => fakePlan(),
      now: () => new Date(T0),
      sleep: async () => {},
      schedule: () => () => {},
    });
    try {
      await a.tick();
      expect(r.store.anomalies().map((x) => x.kind)).toEqual(["archive_verify_failed"]);
      expect(a.status()).toMatchObject({
        verify_failures_24h: 1,
        db: { outcome: "skipped", skipped_reason: "verify_mismatch" },
      });
      expect(liveEvents(r.store).filter((e: Row) => e.kind === "webhook_event")).toHaveLength(1);
      // The same incident on the next tick: logged, not raised again.
      await a.tick();
      expect(r.store.anomalies().map((x) => x.kind)).toEqual(["archive_verify_failed"]);
    } finally {
      a.stop();
    }
  });

  it("verify_failures_24h reads only the last 24 h of daemon-wide anomalies, down the index", async () => {
    const r = await make();
    const anomaly = (
      ts: number,
      kind: string,
      pr: number | null = null,
    ): [string, string, number | null, unknown] => [
      iso(ts),
      "anomaly",
      pr,
      { kind, round_no: null, detail: "x" },
    ];
    seedEvents(r.store, [
      anomaly(T0 - 3 * DAY, "archive_verify_failed"), // older than 24 h
      anomaly(T0 - 2 * 3_600_000, "archive_verify_failed"),
      anomaly(T0 - 3_600_000, "something_else"),
      anomaly(T0 - 60_000, "archive_verify_failed", 7), // a PR's: not the archiver's
      anomaly(T0 - 30_000, "archive_verify_failed"),
    ]);
    const a = new Archiver({
      store: r.store,
      cfg: { ...ARCHIVE_DEFAULTS, mode: "plan" },
      root: r.root,
      sessionsRoot: join(r.root, "state", "pi-sessions"),
      firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
      now: () => new Date(T0),
      schedule: () => () => {},
    });
    expect(a.status().verify_failures_24h).toBe(2);
    const plan = (
      r.store.db.prepare(`EXPLAIN QUERY PLAN ${VERIFY_FAILURES_SQL}`).all() as Array<{
        detail: string;
      }>
    ).map((x) => x.detail);
    expect(plan.join(" | ")).toMatch(
      /USING (COVERING )?INDEX events_kind_pr \(kind=\? AND pr=\?\)/,
    );
    expect(plan.join(" | ")).not.toMatch(/TEMP B-TREE/);
  });

  it("an unreadable archive/db manifest fails the tick loudly and moves nothing", async () => {
    const r = await make();
    seedEvents(r.store, [[iso(OLD), "webhook_event"]]);
    r.adb.close();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(r.dir, "manifest.json"), "{ not json");
    const a = new Archiver({
      store: r.store,
      cfg: { ...ARCHIVE_DEFAULTS, mode: "on" },
      root: r.root,
      sessionsRoot: join(r.root, "state", "pi-sessions"),
      firstHealthyReconcileAt: () => new Date(T0 - 3_600_000),
      statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      plan: async () => fakePlan(),
      now: () => new Date(T0),
      schedule: () => () => {},
    });
    try {
      expect((await a.tick()).state).toBe("failed");
      expect(a.status().last_error).toMatch(/manifest\.json is not JSON/);
      // The seeded row stays live (nothing moved); the only other row is the
      // quiet archive_verify_failed anomaly the unreadable manifest raises.
      const rows = liveEvents(r.store);
      expect(rows.filter((e) => e.kind === "webhook_event")).toHaveLength(1);
      const anomalies = rows.filter((e) => e.kind === "anomaly");
      expect(anomalies).toHaveLength(1);
      expect(JSON.parse(String(anomalies[0]?.payload)).kind).toBe("archive_verify_failed");
      expect(rows).toHaveLength(2);
    } finally {
      a.stop();
    }
  });

  it("ArchiveDb adopts a month file the manifest does not list (a crash before its entry was written)", async () => {
    const r = await make();
    const stray = new Database(join(r.dir, monthFile("2026-07", 1)));
    stray.close();
    const adb = new ArchiveDb(r.dir, { now: () => new Date(T0) });
    await adb.open();
    try {
      expect(adb.files().map((f) => [f.file, f.state])).toEqual([["state-2026-07.sqlite", "open"]]);
    } finally {
      adb.close();
    }
  });
});

function fakePlan(backlog: { event_rows?: number; delivery_rows?: number } = {}): ArchivePlan {
  const tally = { files: 0, bytes: 0 };
  return {
    computed_at: new Date(T0).toISOString(),
    took_ms: 1,
    after_days: 14,
    events_after_days: 35,
    files_cutoff: iso(T0 - 14 * DAY),
    registry: { prs: 0, open: 0, closed: 0, waiting: 0, eligible: 0, held: 0, archived: 0 },
    candidates: [],
    empty: [],
    held: [],
    orphans: [],
    artifacts: {
      transcripts: tally,
      round_prompts: tally,
      session_commands: tally,
      findings: tally,
      posting_receipts: tally,
      round_files: tally,
      session_files: tally,
      inject_done: tally,
      stale_injects: tally,
      verdicts: tally,
      live_logs: tally,
      lens_sessions: tally,
    },
    ledger_snapshots: tally,
    legacy_copies: tally,
    events: { rows: 0, cutoff: "", from_id: 0, examined: 0, windows: 0, by_kind: {} },
    deliveries: { rows: 0, cutoff: "", from_id: 0, examined: 0, windows: 0 },
    backlog: {
      prs: 0,
      bytes: 0,
      event_rows: backlog.event_rows ?? 0,
      delivery_rows: backlog.delivery_rows ?? 0,
    },
    births_observed: true,
    workers: "answered",
    same_device: true,
    max_sync_span_ms: 1,
  };
}
