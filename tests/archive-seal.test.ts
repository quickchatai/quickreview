// Sealing an archive month (docs/archiving.md §9.5): only once
// both cut-offs and both movers' frontiers are past the month's end plus a
// day and both watermarks have reached the file's last id; the gzip round
// trip is verified (length and sha256) before the SQLite file is unlinked; the
// manifest's row counts are what the decompressed file holds; crash recovery
// finishes or undoes a seal a crash interrupted.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Archiver } from "../src/archive/archiver.js";
import {
  ArchiveDb,
  ArchiveFileMissing,
  ManifestUnreadable,
  monthFile,
  readDbManifest,
  sealEdgeMs,
} from "../src/archive/archivedb.js";
import { fileRowsMark } from "../src/archive/dbmove.js";
import type { ArchivePlan } from "../src/archive/plan.js";
import {
  recoverSeals,
  sealBlocker,
  sealDue,
  sealFile,
  type SealDeps,
} from "../src/archive/seal.js";
import { ARCHIVE_DEFAULTS } from "../src/config.js";
import {
  DAY,
  T0,
  iso,
  liveEvents,
  mark,
  rig,
  seedDeliveries,
  seedEvents,
  type Rig,
} from "./helpers/archive-rows.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.close();
});

const AUG = monthFile("2026-08", 1);
const SEP = monthFile("2026-09", 1);

/** August and September rows of both tables, seeded (not moved). */
function seedAugSep(r: Rig): void {
  const ev: Array<[string, string, number | null, unknown]> = [];
  for (let i = 0; i < 1300; i++)
    ev.push([
      iso(Date.parse("2026-08-05T00:00:00Z") + i * 60_000),
      "pingpong_decision_failed",
      9,
      { i },
    ]);
  for (let i = 0; i < 40; i++)
    ev.push([iso(Date.parse("2026-09-05T00:00:00Z") + i * 60_000), "webhook_event", null, { i }]);
  seedEvents(r.store, ev);
  seedDeliveries(r.store, [
    ["aug-1", "2026-08-20T00:00:00.000Z"],
    ["aug-2", "2026-08-21T00:00:00.000Z"],
    ["sep-1", "2026-09-20T00:00:00.000Z"],
    ["recent", iso(T0 - DAY)],
  ]);
}

/** August and September rows of both tables, moved. At T0 (2026-10-21) the
 * events cut-off is 2026-09-16 — past August's edge (2026-09-02), short of
 * September's (2026-10-02). */
async function moved(): Promise<Rig> {
  const r = await rig();
  rigs.push(r);
  seedAugSep(r);
  const res = await r.mover().run();
  expect(res.outcome).toBe("caught_up");
  return r;
}

function deps(r: Rig, over: Partial<SealDeps> = {}): SealDeps {
  return {
    store: r.store,
    adb: r.adb,
    now: () => new Date(T0),
    eventsAfterDays: 35,
    afterDays: 14,
    gzipLevel: 6,
    maxBytesPerS: 1e12,
    ...over,
  };
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const partialsIn = (dir: string): string[] =>
  readdirSync(dir).filter((n) => n.endsWith(".partial"));
const partials = (r: Rig): string[] => partialsIn(r.dir);

describe("when a month may be sealed", () => {
  const base = {
    month: "2026-08",
    nowMs: T0,
    eventsAfterDays: 35,
    afterDays: 14,
    caughtUp: { events: T0 - 35 * DAY, deliveries: T0 - 14 * DAY },
    watermarks: { events: 100, deliveries: 10 },
    fileMaxIds: { events: 100, deliveries: 10 },
  };

  it("only after both cut-offs, both frontiers and both watermarks pass its end", () => {
    expect(sealBlocker(base)).toBeNull();
    const edge = sealEdgeMs("2026-08");
    expect(new Date(edge).toISOString()).toBe("2026-09-02T00:00:00.000Z");
    // The events cut-off not yet past the edge (now too early).
    expect(sealBlocker({ ...base, nowMs: edge + 35 * DAY })).toMatch(/events cut-off/);
    expect(sealBlocker({ ...base, nowMs: edge + 35 * DAY + 1 })).toBeNull();
    // A deliveries cut-off of 40 days would not have passed it.
    expect(sealBlocker({ ...base, afterDays: 50 })).toMatch(/deliveries cut-off/);
    // A mover that never caught up, or caught up only before the edge.
    expect(sealBlocker({ ...base, caughtUp: { ...base.caughtUp, events: null } })).toMatch(
      /events mover/,
    );
    expect(sealBlocker({ ...base, caughtUp: { ...base.caughtUp, deliveries: edge } })).toMatch(
      /deliveries mover/,
    );
    // A watermark short of the file's last id.
    expect(sealBlocker({ ...base, watermarks: { events: 99, deliveries: 10 } })).toMatch(
      /events watermark/,
    );
    expect(sealBlocker({ ...base, watermarks: { events: 100, deliveries: 9 } })).toMatch(
      /deliveries watermark/,
    );
    // A table the file does not hold sets no watermark condition.
    expect(
      sealBlocker({
        ...base,
        fileMaxIds: { events: 100 },
        watermarks: { events: 100, deliveries: 0 },
      }),
    ).toBeNull();
  });

  it("on real files: August is due, September is not; a mover not caught up holds August too", async () => {
    const r = await moved();
    const sealedNothing = async (): Promise<void> => {
      const out = await sealDue(deps(r), 5);
      expect(out).toEqual([]);
      expect(existsSync(join(r.dir, AUG))).toBe(true);
    };
    // The deliveries mover's frontier is gone: nothing seals.
    const saved = mark(r.store, "deliveries.caught_up_to");
    r.store.db.prepare("DELETE FROM archive_marks WHERE name = 'deliveries.caught_up_to'").run();
    await sealedNothing();
    r.store.db
      .prepare("INSERT INTO archive_marks (name, value) VALUES ('deliveries.caught_up_to', ?)")
      .run(saved);
    // The events watermark below August's last id: nothing seals.
    const wm = mark(r.store, "events.last_id");
    r.store.db.prepare("UPDATE archive_marks SET value = 5 WHERE name = 'events.last_id'").run();
    await sealedNothing();
    r.store.db.prepare("UPDATE archive_marks SET value = ? WHERE name = 'events.last_id'").run(wm);
    // A hold (re-read before each file) starts nothing.
    expect(await sealDue(deps(r, { hold: () => "draining" }), 5)).toEqual([]);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
    // Everything in place: August seals, September stays open.
    const out = await sealDue(deps(r), 5);
    expect(out.map((x) => [x.file, x.outcome])).toEqual([[AUG, "sealed"]]);
    expect(r.adb.files().map((f) => [f.file, f.state])).toEqual([
      [AUG, "sealed"],
      [SEP, "open"],
    ]);
  });
});

describe("sealing and the disk", () => {
  it("no room for a month's gzip: nothing gzipped, the file kept open, sealing stops", async () => {
    const r = await moved();
    const asked: number[] = [];
    const out = await sealDue(
      deps(r, {
        roomFor: async (bytes) => {
          asked.push(bytes);
          return "disk_low";
        },
      }),
      5,
    );
    expect(out.map((x) => [x.file, x.outcome, x.detail])).toEqual([[AUG, "held", "disk_low"]]);
    // Asked for the file's own size, the one it would gzip.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(0);
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
    expect(partials(r)).toEqual([]);
    expect(r.adb.files().find((f) => f.file === AUG)?.state).toBe("open");
    // With room, the same month seals.
    const again = await sealDue(deps(r, { roomFor: async () => null }), 5);
    expect(again.map((x) => [x.file, x.outcome])).toEqual([[AUG, "sealed"]]);
  });
});

describe("sealing a month", () => {
  it(
    "gzip, verified round trip, manifest, then unlink — the .gz decompresses to the manifest's rows",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = await moved();
      const before = readFileSync(join(r.dir, AUG)); // (the WAL may still hold pages)
      expect(before.length).toBeGreaterThan(0);
      const res = await sealFile(deps(r), r.adb.entry(AUG)!);
      expect(res.outcome).toBe("sealed");
      expect(existsSync(join(r.dir, AUG))).toBe(false);
      expect(existsSync(join(r.dir, `${AUG}-wal`))).toBe(false);
      expect(readdirSync(r.dir).filter((n) => n.endsWith(".partial"))).toEqual([]);

      const manifest = await readDbManifest(r.dir);
      const entry = manifest.files.find((f) => f.file === AUG)!;
      expect(entry).toMatchObject({
        state: "sealed",
        gz_file: `${AUG}.gz`,
        tables: {
          events: {
            rows: 1300,
            first_id: 1,
            last_id: 1300,
            first_ts: "2026-08-05T00:00:00.000Z",
          },
          deliveries: {
            rows: 2,
            first_ts: "2026-08-20T00:00:00.000Z",
            last_ts: "2026-08-21T00:00:00.000Z",
          },
        },
      });
      expect(typeof entry.sealed_at).toBe("string");
      // Decompress with node zlib, open with better-sqlite3: the manifest's counts.
      const raw = gunzipSync(readFileSync(join(r.dir, `${AUG}.gz`)));
      expect(raw.length).toBe(entry.bytes);
      expect(sha(raw)).toBe(entry.sha256);
      expect(readFileSync(join(r.dir, `${AUG}.gz`)).length).toBe(entry.gz_bytes);
      const copy = join(r.root, "restored.sqlite");
      writeFileSync(copy, raw);
      const db = new Database(copy, { readonly: true });
      try {
        for (const [t, v] of Object.entries(entry.tables!))
          expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(
            v.rows,
          );
        expect(
          db.prepare("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind").all() as unknown[],
        ).toEqual([{ kind: "pingpong_decision_failed", n: 1300 }]);
      } finally {
        db.close();
      }
      // September is untouched, and a later move of an August row (a clock
      // step) goes to a NEW file, never into the sealed one.
      expect(r.adb.entry(SEP)?.state).toBe("open");
      const next = await r.adb.target("2026-08");
      expect(next.file).toBe("state-2026-08-2.sqlite");
    },
  );

  it("a gzip that does not reproduce the file: the .sqlite is kept, no .gz, the manifest still open", async () => {
    const r = await moved();
    const res = await sealFile(
      deps(r, {
        beforeVerify: async (partial) => {
          const b = readFileSync(partial);
          const mid = Math.floor(b.length / 2);
          b[mid] = b[mid]! ^ 0xff; // one flipped byte in the middle
          writeFileSync(partial, b);
        },
      }),
      r.adb.entry(AUG)!,
    );
    expect(res.outcome).toBe("verify_failed");
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
    expect(readdirSync(r.dir).filter((n) => n.endsWith(".partial"))).toEqual([]);
    expect((await readDbManifest(r.dir)).files.find((f) => f.file === AUG)?.state).toBe("open");
    // The rows are all still there, and an honest seal then succeeds.
    expect((await sealFile(deps(r), r.adb.entry(AUG)!)).outcome).toBe("sealed");
  });

  it("a gzip of DIFFERENT bytes that decompresses cleanly is still refused (length and sha256 compared)", async () => {
    const r = await moved();
    const res = await sealFile(
      deps(r, {
        beforeVerify: async (partial) => {
          // A valid gzip of the file with one byte flipped: same length, other sha256.
          const raw = readFileSync(join(r.dir, AUG));
          raw[raw.length - 10] = raw[raw.length - 10]! ^ 0xff;
          writeFileSync(partial, gzipSync(raw));
        },
      }),
      r.adb.entry(AUG)!,
    );
    expect(res.outcome).toBe("verify_failed");
    expect(res.detail).toMatch(/decompressed to \d+ byte\(s\)/);
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
    expect(partials(r)).toEqual([]);
    expect(r.adb.entry(AUG)?.state).toBe("open");
  });

  it("a file whose identity changed while it was compressed is kept: outcome changed, no .gz", async () => {
    const r = await moved();
    const res = await sealFile(
      deps(r, {
        beforeVerify: async () => {
          utimesSync(join(r.dir, AUG), new Date(1000), new Date(1000));
        },
      }),
      r.adb.entry(AUG)!,
    );
    expect(res.outcome).toBe("changed");
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
    expect(partials(r)).toEqual([]);
    expect(r.adb.entry(AUG)?.state).toBe("open");
  });

  it("the manifest is written BEFORE the unlink: a failed manifest write keeps the .sqlite, memory stays open, recovery finishes it", async () => {
    const r = await moved();
    // A directory where the manifest's temporary file goes: the write fails.
    const blocker = join(r.dir, "manifest.json.partial");
    mkdirSync(blocker);
    await expect(sealFile(deps(r), r.adb.entry(AUG)!)).rejects.toThrow();
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(true);
    // Memory is what the disk says: still open (the patch is swapped in only
    // once it is written).
    expect(r.adb.entry(AUG)?.state).toBe("open");
    expect((await readDbManifest(r.dir)).files.find((f) => f.file === AUG)?.state).toBe("open");
    rmSync(blocker, { recursive: true });
    const rec = await recoverSeals({ adb: r.adb, maxBytesPerS: 1e12, now: () => new Date(T0) });
    expect(rec.notes).toEqual([expect.stringContaining(`finished sealing ${AUG}`)]);
    expect(rec.problems).toEqual([]);
    expect(existsSync(join(r.dir, AUG))).toBe(false);
    expect(r.adb.entry(AUG)?.state).toBe("sealed");
  });

  it("a .gz already beside the open file is never replaced: conflict, everything kept", async () => {
    const r = await moved();
    const there = gzipSync(Buffer.from("an earlier gzip nobody accounted for"));
    writeFileSync(join(r.dir, `${AUG}.gz`), there);
    let gzipped = false;
    const res = await sealFile(
      deps(r, {
        beforeVerify: async () => {
          gzipped = true;
        },
      }),
      r.adb.entry(AUG)!,
    );
    expect(res.outcome).toBe("conflict");
    // Refused up front: the month was never compressed for nothing.
    expect(gzipped).toBe(false);
    expect(res.detail).toMatch(/already on disk beside an open entry/);
    expect(readFileSync(join(r.dir, `${AUG}.gz`))).toEqual(there);
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(r.adb.entry(AUG)?.state).toBe("open");
  });

  it("a .gz that appears while the month is compressed is never replaced either", async () => {
    const r = await moved();
    const there = Buffer.from("appeared meanwhile");
    const res = await sealFile(
      deps(r, {
        beforeVerify: async () => {
          writeFileSync(join(r.dir, `${AUG}.gz`), there);
        },
      }),
      r.adb.entry(AUG)!,
    );
    expect(res.outcome).toBe("conflict");
    expect(readFileSync(join(r.dir, `${AUG}.gz`))).toEqual(there);
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(partials(r)).toEqual([]);
    expect(r.adb.entry(AUG)?.state).toBe("open");
  });

  it("a listed open file that vanished is held — never recreated empty, its .gz never replaced", async () => {
    const r = await moved();
    // The month's real gzip sits on disk; the .sqlite is gone; the entry is open.
    r.adb.close();
    const gz = gzipSync(readFileSync(join(r.dir, AUG)));
    writeFileSync(join(r.dir, `${AUG}.gz`), gz);
    for (const n of [AUG, `${AUG}-wal`, `${AUG}-shm`]) rmSync(join(r.dir, n), { force: true });
    const adb = await r.reopen();
    expect(adb.entry(AUG)?.state).toBe("open");
    const out = await sealDue(deps(r), 5);
    expect(out.find((x) => x.file === AUG)).toMatchObject({ outcome: "missing" });
    expect(existsSync(join(r.dir, AUG))).toBe(false); // never recreated
    expect(readFileSync(join(r.dir, `${AUG}.gz`))).toEqual(gz); // never replaced
    // The mover holds the month too: it never writes a row into a new empty file.
    await expect(adb.target("2026-08")).rejects.toBeInstanceOf(ArchiveFileMissing);
    expect(existsSync(join(r.dir, AUG))).toBe(false);
    // Recovery reports it and touches nothing.
    const rec = await recoverSeals({ adb, maxBytesPerS: 1e12, now: () => new Date(T0) });
    expect(rec.problems).toEqual([expect.objectContaining({ file: AUG, code: "gz_without_file" })]);
    expect(readFileSync(join(r.dir, `${AUG}.gz`))).toEqual(gz);
  });

  it("a table the running totals count but the file does not hold is a mismatch, never a pass", async () => {
    const r = await rig();
    rigs.push(r);
    seedEvents(r.store, [
      [iso(Date.parse("2026-08-05T00:00:00Z")), "webhook_event"],
      [iso(Date.parse("2026-08-06T00:00:00Z")), "webhook_event"],
    ]);
    expect((await r.mover().run()).outcome).toBe("caught_up");
    expect(r.adb.connection(AUG).hasTable("deliveries")).toBe(false);
    r.store.db
      .prepare("INSERT INTO archive_marks (name, value) VALUES (?, 3)")
      .run(fileRowsMark(AUG, "deliveries"));
    const res = await sealFile(deps(r), r.adb.entry(AUG)!);
    expect(res).toMatchObject({ outcome: "count_mismatch" });
    expect(res.detail).toMatch(
      /deliveries: the file has no such table, the live running total says 3/,
    );
    expect(existsSync(join(r.dir, AUG))).toBe(true);
  });

  it("a row count that differs from the live running total refuses the seal", async () => {
    const r = await moved();
    r.store.db
      .prepare("UPDATE archive_marks SET value = value + 1 WHERE name = ?")
      .run(fileRowsMark(AUG, "events"));
    const res = await sealFile(deps(r), r.adb.entry(AUG)!);
    expect(res).toMatchObject({ outcome: "count_mismatch" });
    expect(res.detail).toMatch(
      /events: the file holds 1300 row\(s\), the live running total says 1301/,
    );
    expect(existsSync(join(r.dir, AUG))).toBe(true);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
  });

  it("an analyst reading the month makes the TRUNCATE checkpoint busy: no seal, nothing removed", async () => {
    const r = await moved();
    const other = new Database(join(r.dir, AUG), { timeout: 0 });
    other.exec("BEGIN");
    other.prepare("SELECT COUNT(*) FROM events").get(); // holds a read snapshot
    try {
      const res = await sealFile(deps(r), r.adb.entry(AUG)!);
      expect(["busy", "attached"]).toContain(res.outcome);
      expect(existsSync(join(r.dir, AUG))).toBe(true);
      expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
    } finally {
      other.exec("COMMIT");
      other.close();
    }
  });
});

describe("seal crash recovery", () => {
  it("finishes a seal interrupted after the rename, deletes a stray partial, removes a .gz that does not match", async () => {
    const r = await moved();
    // Make the August seal look interrupted: the .gz renamed into place, the
    // manifest not yet updated, the .sqlite not yet removed.
    r.adb.closeFile(AUG);
    const aside = join(r.root, "aug.copy");
    // Close every connection so the WAL is folded into the file first.
    r.adb.close();
    copyFileSync(join(r.dir, AUG), aside);
    writeFileSync(join(r.dir, `${AUG}.gz`), gzipSync(readFileSync(aside)));
    writeFileSync(join(r.dir, `${SEP}.gz.partial`), "half a gzip");
    // September gets a .gz that is NOT its bytes.
    writeFileSync(join(r.dir, `${SEP}.gz`), gzipSync(Buffer.from("something else")));
    const adb = await r.reopen();
    const { notes, problems } = await recoverSeals({
      adb,
      maxBytesPerS: 1e12,
      now: () => new Date(T0),
    });
    expect(problems).toEqual([]);
    expect(notes).toEqual(
      expect.arrayContaining([
        `deleted the stray ${SEP}.gz.partial`,
        expect.stringContaining(`finished sealing ${AUG}`),
        expect.stringContaining(`removed ${SEP}.gz`),
      ]),
    );
    expect(existsSync(join(r.dir, AUG))).toBe(false);
    expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(true);
    expect(existsSync(join(r.dir, SEP))).toBe(true);
    expect(existsSync(join(r.dir, `${SEP}.gz`))).toBe(false);
    const m = await readDbManifest(r.dir);
    expect(m.files.map((f) => [f.file, f.state])).toEqual([
      [AUG, "sealed"],
      [SEP, "open"],
    ]);
    expect(m.files[0]!.sha256).toBe(sha(readFileSync(aside)));
    // A recovered seal records what a normal one does, counted from the file.
    expect(m.files[0]!.tables).toMatchObject({ events: { rows: 1300 }, deliveries: { rows: 2 } });
  });

  it("a .gz of the same LENGTH but other bytes does not reproduce the file: it is removed, the .sqlite kept", async () => {
    const r = await moved();
    r.adb.close();
    const raw = readFileSync(join(r.dir, SEP));
    raw[raw.length - 10] = raw[raw.length - 10]! ^ 0xff;
    writeFileSync(join(r.dir, `${SEP}.gz`), gzipSync(raw));
    const adb = await r.reopen();
    const { notes } = await recoverSeals({ adb, maxBytesPerS: 1e12, now: () => new Date(T0) });
    expect(notes).toEqual([expect.stringContaining(`removed ${SEP}.gz`)]);
    expect(existsSync(join(r.dir, SEP))).toBe(true);
    expect(existsSync(join(r.dir, `${SEP}.gz`))).toBe(false);
    expect(adb.entry(SEP)?.state).toBe("open");
  });

  it("a .gz cut short by the crash does not decompress: removed, the .sqlite kept", async () => {
    const r = await moved();
    r.adb.close();
    const gz = gzipSync(readFileSync(join(r.dir, SEP)));
    writeFileSync(join(r.dir, `${SEP}.gz`), gz.subarray(0, Math.floor(gz.length / 2)));
    const adb = await r.reopen();
    const { notes, problems } = await recoverSeals({
      adb,
      maxBytesPerS: 1e12,
      now: () => new Date(T0),
    });
    expect(problems).toEqual([]);
    expect(notes).toEqual([expect.stringContaining(`removed ${SEP}.gz`)]);
    expect(existsSync(join(r.dir, SEP))).toBe(true);
    expect(existsSync(join(r.dir, `${SEP}.gz`))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a .gz that cannot be READ is not called a mismatch: left as found, reported",
    async () => {
      const r = await moved();
      r.adb.close();
      const gzPath = join(r.dir, `${SEP}.gz`);
      writeFileSync(gzPath, gzipSync(readFileSync(join(r.dir, SEP))));
      chmodSync(gzPath, 0o000);
      try {
        const adb = await r.reopen();
        const { problems } = await recoverSeals({
          adb,
          maxBytesPerS: 1e12,
          now: () => new Date(T0),
        });
        expect(problems).toEqual([expect.objectContaining({ file: SEP, code: "gz_unreadable" })]);
        expect(existsSync(gzPath)).toBe(true);
        expect(existsSync(join(r.dir, SEP))).toBe(true);
        expect(adb.entry(SEP)?.state).toBe("open");
      } finally {
        chmodSync(gzPath, 0o644);
      }
    },
  );

  it("a SEALED month whose .sqlite outlived the crash: removed once it is a verified duplicate, kept when it is not", async () => {
    for (const tamper of [false, true]) {
      const r = await moved();
      expect((await sealFile(deps(r), r.adb.entry(AUG)!)).outcome).toBe("sealed");
      // The crash between the manifest write and the unlink, re-created: the
      // sealed bytes back on disk (or, tampered, other bytes of that length).
      const raw = gunzipSync(readFileSync(join(r.dir, `${AUG}.gz`)));
      if (tamper) raw[100] = raw[100]! ^ 0xff;
      writeFileSync(join(r.dir, AUG), raw);
      writeFileSync(join(r.dir, `${AUG}-shm`), Buffer.alloc(0));
      r.adb.close();
      const adb = await r.reopen();
      expect(adb.entry(AUG)?.state).toBe("sealed"); // listed, so never adopted as open
      const rec = await recoverSeals({ adb, maxBytesPerS: 1e12, now: () => new Date(T0) });
      if (tamper) {
        expect(rec.problems).toEqual([
          expect.objectContaining({ file: AUG, code: "sealed_file_differs" }),
        ]);
        expect(existsSync(join(r.dir, AUG))).toBe(true);
      } else {
        expect(rec.problems).toEqual([]);
        expect(rec.notes).toEqual([
          expect.stringContaining(`removed ${AUG}, ${AUG}-shm: verified duplicates`),
        ]);
        expect(existsSync(join(r.dir, AUG))).toBe(false);
        expect(existsSync(join(r.dir, `${AUG}-shm`))).toBe(false);
      }
      expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(true);
    }
  });

  /** A sealed AUG with its .sqlite back beside the .gz (the crash between
   * the manifest write and the unlink), the archive db reopened. */
  async function sealedWithLeftover(): Promise<{ r: Rig; adb: ArchiveDb }> {
    const r = await moved();
    expect((await sealFile(deps(r), r.adb.entry(AUG)!)).outcome).toBe("sealed");
    writeFileSync(join(r.dir, AUG), gunzipSync(readFileSync(join(r.dir, `${AUG}.gz`))));
    r.adb.close();
    return { r, adb: await r.reopen() };
  }

  it("a stop while a SEALED month's .gz is verified is a stop, never a verify problem", async () => {
    const { r, adb } = await sealedWithLeftover();
    const ac = new AbortController();
    ac.abort();
    const log: string[] = [];
    await expect(
      recoverSeals({
        adb,
        maxBytesPerS: 1e12,
        signal: ac.signal,
        now: () => new Date(T0),
        log: (s) => log.push(s),
      }),
    ).rejects.toThrow();
    expect(log.filter((l) => l.includes("does not reproduce"))).toEqual([]);
    expect(existsSync(join(r.dir, AUG))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a SEALED month's .gz that cannot be read: the problem names the read error, everything left as found",
    async () => {
      const { r, adb } = await sealedWithLeftover();
      const gzPath = join(r.dir, `${AUG}.gz`);
      chmodSync(gzPath, 0o000);
      try {
        const rec = await recoverSeals({ adb, maxBytesPerS: 1e12, now: () => new Date(T0) });
        expect(rec.problems).toEqual([
          expect.objectContaining({
            file: AUG,
            code: "sealed_gz_unverified",
            detail: expect.stringContaining("EACCES"),
          }),
        ]);
        expect(existsSync(join(r.dir, AUG))).toBe(true);
      } finally {
        chmodSync(gzPath, 0o644);
      }
    },
  );
});

describe("the manifest", () => {
  it("is written atomically (no .partial left) and an unreadable one is refused, never guessed", async () => {
    const r = await moved();
    expect(readdirSync(r.dir).filter((n) => n.startsWith("manifest"))).toEqual(["manifest.json"]);
    writeFileSync(join(r.dir, "manifest.json"), JSON.stringify({ format: 2, files: [] }));
    const adb = new ArchiveDb(r.dir, { now: () => new Date(T0) });
    await expect(adb.open()).rejects.toThrow(/no format-1 file list/);
  });

  it("a sealed .gz it does not list — or no manifest at all beside one — is unknown, never 'no files'", async () => {
    const r = await moved();
    expect((await sealFile(deps(r), r.adb.entry(AUG)!)).outcome).toBe("sealed");
    r.adb.close();
    const manifest = readFileSync(join(r.dir, "manifest.json"));
    // Absent: the sealed month would otherwise be re-created at seq 1 and its
    // .gz replaced by the next seal.
    rmSync(join(r.dir, "manifest.json"));
    const a = new ArchiveDb(r.dir, { now: () => new Date(T0) });
    await expect(a.open()).rejects.toBeInstanceOf(ManifestUnreadable);
    await expect(a.open()).rejects.toThrow(/does not list state-2026-08\.sqlite/);
    // Present but without the entry: the same.
    const m = JSON.parse(manifest.toString()) as { files: Array<{ file: string }> };
    writeFileSync(
      join(r.dir, "manifest.json"),
      JSON.stringify({ format: 1, files: m.files.filter((f) => f.file !== AUG) }),
    );
    const b = new ArchiveDb(r.dir, { now: () => new Date(T0) });
    await expect(b.open()).rejects.toBeInstanceOf(ManifestUnreadable);
  });

  it("an entry without a positive integer seq is unreadable, never a NaN file name", async () => {
    const r = await moved();
    r.adb.close();
    const m = JSON.parse(readFileSync(join(r.dir, "manifest.json"), "utf8")) as {
      files: Array<Record<string, unknown>>;
    };
    for (const seq of [undefined, 0, 1.5, "2"]) {
      const files = m.files.map((f) => ({ ...f }));
      if (seq === undefined) delete files[0]!.seq;
      else files[0]!.seq = seq;
      writeFileSync(join(r.dir, "manifest.json"), JSON.stringify({ format: 1, files }));
      await expect(readDbManifest(r.dir), String(seq)).rejects.toBeInstanceOf(ManifestUnreadable);
    }
  });

  it("a new file takes a seq no name on disk has used (a stray -wal included)", async () => {
    const r = await rig();
    rigs.push(r);
    writeFileSync(join(r.dir, `${monthFile("2026-07", 1)}-wal`), "stale");
    const conn = await r.adb.target("2026-07");
    expect(conn.file).toBe(monthFile("2026-07", 2));
    expect(readFileSync(join(r.dir, `${monthFile("2026-07", 1)}-wal`), "utf8")).toBe("stale");
  });
});

describe("sealing through the archiver (mode on)", () => {
  const archiver = (
    r: Rig,
    over: Partial<ConstructorParameters<typeof Archiver>[0]> = {},
  ): Archiver =>
    new Archiver({
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
      ...over,
    });

  it("a tick seals the due month: one archive_month_sealed event, months_sealed 1", async () => {
    const r = await moved();
    r.adb.close();
    const a = archiver(r);
    try {
      expect((await a.tick()).state).toBe("idle");
      expect(existsSync(join(r.dir, AUG))).toBe(false);
      expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(true);
      const sealed = liveEvents(r.store).filter((e) => e.kind === "archive_month_sealed");
      expect(sealed).toHaveLength(1);
      expect(JSON.parse(sealed[0]!.payload as string)).toMatchObject({
        file: AUG,
        gz_file: `${AUG}.gz`,
      });
      expect(a.status().db).toMatchObject({ months_sealed: 1, months_open: 1 });
      expect(r.store.anomalies()).toEqual([]);
    } finally {
      a.stop();
    }
  });

  it("a count that does not verify: ONE quiet anomaly per incident, the .sqlite kept, nothing sealed", async () => {
    const r = await moved();
    r.adb.close();
    r.store.db
      .prepare("UPDATE archive_marks SET value = value + 1 WHERE name = ?")
      .run(fileRowsMark(AUG, "events"));
    let now = T0;
    const a = archiver(r, { now: () => new Date(now) });
    try {
      await a.tick();
      now += 60_000;
      await a.tick(); // the same incident: logged, not raised again
      expect(r.store.anomalies().map((x) => x.kind)).toEqual(["archive_verify_failed"]);
      expect(r.store.anomalies()[0]!.detail).toMatch(/count_mismatch/);
      expect(existsSync(join(r.dir, AUG))).toBe(true);
      expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
      expect(a.status()).toMatchObject({ verify_failures_24h: 1, db: { months_sealed: 0 } });
      now += 6 * 3_600_000; // past the repeat window: raised again
      await a.tick();
      expect(r.store.anomalies().map((x) => x.kind)).toHaveLength(2);
    } finally {
      a.stop();
    }
  });

  it("retries a quiet anomaly whose first persistence failed without waiting six hours", async () => {
    const r = await moved();
    r.adb.close();
    r.store.db
      .prepare("UPDATE archive_marks SET value = value + 1 WHERE name = ?")
      .run(fileRowsMark(AUG, "events"));
    const log = vi.spyOn(r.store, "logAnomaly").mockImplementationOnce(() => {
      throw new Error("temporary anomaly write failure");
    });
    const a = archiver(r);
    try {
      await a.tick();
      expect(r.store.anomalies()).toEqual([]);
      await a.tick();
      expect(r.store.anomalies().map((x) => x.kind)).toEqual(["archive_verify_failed"]);
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
      a.stop();
    }
  });

  it("seal recovery runs on the first tick only — and again after a seal that failed partway", async () => {
    const r = await moved();
    r.adb.close();
    const stray = join(r.dir, `${SEP}.gz.partial`);
    const a = archiver(r);
    // The first seal fails at its manifest write (the .gz is placed by then).
    const write = vi
      .spyOn(ArchiveDb.prototype, "updateEntry")
      .mockRejectedValueOnce(new Error("the manifest write failed"));
    try {
      const recovered = async (): Promise<boolean> => {
        writeFileSync(stray, "half");
        await a.tick();
        return !existsSync(stray);
      };
      // Tick 1: recovery removes the stray; the seal then fails at the manifest.
      expect(await recovered()).toBe(true);
      expect(a.status()).toMatchObject({
        state: "failed",
        last_error: expect.stringMatching(/the manifest write failed/),
      });
      expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(true);
      expect(existsSync(join(r.dir, AUG))).toBe(true);
      // Tick 2: recovery runs again (the seal failed) and finishes the seal.
      expect(await recovered()).toBe(true);
      expect(existsSync(join(r.dir, AUG))).toBe(false);
      expect((await readDbManifest(r.dir)).files.find((f) => f.file === AUG)?.state).toBe("sealed");
      // Tick 3: nothing failed since — recovery does not run.
      expect(await recovered()).toBe(false);
    } finally {
      write.mockRestore();
      a.stop();
    }
  });

  it("a hold that comes up during the DB phase ends the tick held: nothing sealed, no plan", async () => {
    const r = await rig();
    rigs.push(r);
    seedAugSep(r);
    r.adb.close();
    let plans = 0;
    const a = archiver(r, {
      // The pause after the first batch: an operator drains.
      sleep: async () => {
        r.store.engageDrain({ issuer: "operator", expires_at: null });
      },
      plan: async () => {
        plans += 1;
        return fakePlan();
      },
    });
    try {
      const t = await a.tick();
      expect(t).toMatchObject({ state: "held", held_reason: "draining" });
      expect(a.status()).toMatchObject({
        state: "held",
        held_reason: "draining",
        db: { outcome: "held", events_moved: 500 },
      });
      expect(plans).toBe(0);
      expect(readdirSync(r.dir).filter((n) => n.endsWith(".gz"))).toEqual([]);
    } finally {
      a.stop();
    }
  });

  it("the disk is re-read between DB batches: no reading ends the tick held, nothing planned or sealed", async () => {
    const r = await rig();
    rigs.push(r);
    seedAugSep(r);
    r.adb.close();
    const manifest = join(r.dir, "manifest.json");
    expect(existsSync(manifest)).toBe(false);
    let plans = 0;
    const a = archiver(r, {
      // statfs answers until the first batch has written the archive's manifest.
      statfs: async () => {
        if (existsSync(manifest)) throw new Error("EIO");
        return { bavail: 1e12, bsize: 1 };
      },
      plan: async () => {
        plans += 1;
        return fakePlan();
      },
    });
    try {
      expect(await a.tick()).toMatchObject({
        state: "held",
        held_reason: "disk_unknown",
        planned: false,
      });
      expect(a.status().db).toMatchObject({ outcome: "held", events_moved: 500 });
      expect(plans).toBe(0);
      expect(readdirSync(r.dir).filter((n) => n.endsWith(".gz"))).toEqual([]);
    } finally {
      a.stop();
    }
  });

  it("no room on the archive mount for a month's gzip: the month waits, the tick goes on, ONE wake", async () => {
    const r = await moved();
    r.adb.close();
    const headroom = ARCHIVE_DEFAULTS.disk_headroom_gb * 1024 ** 3;
    let now = T0;
    const logs: string[] = [];
    const a = archiver(r, {
      // The headroom and a few bytes: never room for a month's file.
      statfs: async () => ({ bavail: headroom + 10, bsize: 1 }),
      now: () => new Date(now),
      log: (m) => logs.push(m),
    });
    try {
      expect(await a.tick()).toMatchObject({ state: "idle", held_reason: null });
      now += 60_000;
      expect((await a.tick()).state).toBe("idle");
      expect(existsSync(join(r.dir, AUG))).toBe(true);
      expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
      expect(partialsIn(r.dir)).toEqual([]);
      expect((await readDbManifest(r.dir)).files.find((f) => f.file === AUG)?.state).toBe("open");
      expect(r.store.anomalies().map((x) => x.kind)).toEqual(["archive_disk_low"]);
      expect(logs.filter((l) => l.includes(`${AUG} not sealed (held)`))).toHaveLength(1);
    } finally {
      a.stop();
    }
  });

  it("a hold before sealing, or a spent tick budget, starts no seal", async () => {
    // Held: the load reads stalled once the DB phase is done.
    const r = await moved();
    r.adb.close();
    let stalled = false;
    const a = archiver(r, {
      load: () => (stalled ? ({ event_loop: { state: "stalled" } } as never) : undefined),
      plan: async () => {
        stalled = true;
        return fakePlan();
      },
    });
    try {
      // The plan was computed before the hold came up: the tick says so.
      expect(await a.tick()).toMatchObject({
        state: "held",
        held_reason: "loop_stalled",
        planned: true,
      });
      expect(existsSync(join(r.dir, `${AUG}.gz`))).toBe(false);
    } finally {
      a.stop();
    }
    // The tick budget (1 s) spent by the time sealing would start.
    const r2 = await moved();
    r2.adb.close();
    let clock = T0;
    const logs: string[] = [];
    const b = archiver(r2, {
      cfg: { ...ARCHIVE_DEFAULTS, mode: "on", tick_budget_s: 1 },
      now: () => new Date((clock += 400)),
      log: (m) => logs.push(m),
    });
    try {
      expect((await b.tick()).state).toBe("idle");
      expect(existsSync(join(r2.dir, AUG))).toBe(true);
      expect(existsSync(join(r2.dir, `${AUG}.gz`))).toBe(false);
      expect(logs.some((l) => /sealing waits for the next tick/.test(l))).toBe(true);
    } finally {
      b.stop();
    }
  });
});

function fakePlan(): ArchivePlan {
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
    },
    ledger_snapshots: tally,
    legacy_copies: tally,
    events: { rows: 0, cutoff: "", from_id: 0, examined: 0, windows: 0, by_kind: {} },
    deliveries: { rows: 0, cutoff: "", from_id: 0, examined: 0, windows: 0 },
    backlog: { prs: 0, bytes: 0, event_rows: 0, delivery_rows: 0 },
    births_observed: true,
    tmux: "answered",
    same_device: true,
    max_sync_span_ms: 1,
  };
}
