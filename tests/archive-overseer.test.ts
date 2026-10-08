// the stores that belong to no PR (docs/archiving.md §5, §7.5):
//
//   (4) The current overseer file is never archived; non-current files are
//       (into archive/overseer/transcripts/, named by their own file names);
//       two rotations on the same date no longer overwrite each other.
//
// Plus the overseer's legacy archive/overseer/<date>/session.jsonl copies:
// removed only as a verified exact or byte-prefix duplicate of the
// transcript their meta.json names, kept waiting while that transcript is
// live, gzipped and kept when they match nothing — ledger.md and meta.json
// never touched. And pi's global store: day-old JSONLs into archive/pi-global/,
// anything younger or not a JSONL left, emptied dirs removed, the store kept.
// Unknown is never "none": an unreadable overseer birth moves nothing. A
// verify failure keeps the source; a crash between an entry and its unlink
// converges with no second gzip. Plan mode moves none of it.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { archivePolicy, type Archiver, type ArchiverDeps } from "../src/archive/archiver.js";
import { computePlan } from "../src/archive/plan.js";
import { SpanMeter } from "../src/archive/prfiles.js";
import { renderArchiveReport } from "../src/archive/report.js";
import { archiveRow } from "../src/archive/rows.js";
import {
  STORE_SHARD_ENTRIES,
  StoreWriter,
  readStoreShards,
  type StorePassDeps,
} from "../src/archive/storepass.js";
import { ARCHIVE_DEFAULTS } from "../src/config.js";
import {
  DAY,
  T0,
  filesUnder,
  line,
  onArchiver,
  prFixture,
  put,
  sessionRig,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const HOUR = 3_600_000;

const open: PrFixture[] = [];
const archivers: Archiver[] = [];
afterEach(() => {
  for (const a of archivers.splice(0)) a.stop();
  for (const f of open.splice(0)) f.close();
});

/** A sandbox root whose PR is too recently closed to move (only the stores
 * have work). */
function root(): PrFixture {
  const f = prFixture({ closedDaysAgo: 1 });
  open.push(f);
  return f;
}

const BORN = T0 - HOUR;
const OV = "state/pi-sessions/overseer";

function archiver(
  f: PrFixture,
  cfg: Parameters<typeof onArchiver>[1] = {},
  extra: Partial<ArchiverDeps> = {},
): Archiver {
  const a = onArchiver(f, cfg, { overseerBornAt: () => new Date(BORN), ...extra });
  archivers.push(a);
  return a;
}

const gz = (f: PrFixture, rel: string): Buffer => gunzipSync(readFileSync(join(f.root, rel)));
const manifest = (f: PrFixture, store: string) =>
  JSON.parse(readFileSync(join(f.root, "archive", store, "manifest.json"), "utf8")) as {
    subject: string;
    passes: Array<Record<string, unknown>>;
    entries: Array<Record<string, unknown> & { kind: string }>;
  };
const mark = (f: PrFixture, name: string): unknown =>
  (
    f.store.db.prepare("SELECT value FROM archive_marks WHERE name = ?").get(name) as
      { value: unknown } | undefined
  )?.value;

describe("the overseer store (acceptance 4)", () => {
  it(
    "the CURRENT file is never archived; every non-current one is, by its own name",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const old1 = put(
        f.root,
        `${OV}/2026-10-10T09-00-00_a.jsonl`,
        line("a").repeat(300),
        BORN - 3 * DAY,
      );
      const old2 = put(
        f.root,
        `${OV}/2026-10-20T09-00-00_b.jsonl`,
        line("b").repeat(200),
        BORN - 2 * HOUR,
      );
      const nested = put(f.root, `${OV}/sub/2026-10-21T10-00-00_c.jsonl`, line("c"), BORN - 90_000);
      // Written within the slack before the birth: may be the current one.
      const slack = put(f.root, `${OV}/2026-10-21T10-59-40_d.jsonl`, line("d"), BORN - 20_000);
      const current = put(
        f.root,
        `${OV}/2026-10-21T11-00-00_e.jsonl`,
        line("e"),
        BORN + 5 * 60_000,
      );
      const bytes = new Map(
        [old1, old2, nested, slack, current].map((p) => [p, readFileSync(p)] as const),
      );
      const a = archiver(f);
      expect((await a.tick()).state).toBe("idle");

      for (const [p, rel] of [
        [old1, "2026-10-10T09-00-00_a.jsonl"],
        [old2, "2026-10-20T09-00-00_b.jsonl"],
        [nested, "sub/2026-10-21T10-00-00_c.jsonl"],
      ] as const) {
        expect(existsSync(p), p).toBe(false);
        const archived = join("archive/overseer/transcripts", `${rel}.gz`);
        expect(gz(f, archived).equals(bytes.get(p)!), rel).toBe(true);
        // The original mtime rides on the gzip.
        expect(statSync(join(f.root, archived)).mtimeMs).toBe(
          rel.includes("_a")
            ? BORN - 3 * DAY
            : rel.includes("_b")
              ? BORN - 2 * HOUR
              : BORN - 90_000,
        );
      }
      for (const p of [slack, current]) expect(readFileSync(p).equals(bytes.get(p)!)).toBe(true);
      const m = manifest(f, "overseer");
      expect(m.subject).toBe("overseer");
      const entries = m.entries.filter((e) => e.kind === "transcript");
      expect(entries.map((e) => e.source).sort()).toEqual(
        [old1, old2, nested].map((p) => p.slice(f.root.length + 1)).sort(),
      );
      expect(entries.every((e) => typeof e.source_removed_at === "string")).toBe(true);
      expect(a.status().stores?.overseer).toMatchObject({
        outcome: "done",
        archived: 3,
        removed: 3,
        kept_live: 2,
        verify_failures: 0,
      });
      // One archive_pass event for the store.
      const passes = f.store.db
        .prepare("SELECT payload FROM events WHERE kind = 'archive_pass'")
        .all() as Array<{ payload: string }>;
      expect(passes.map((p) => JSON.parse(p.payload).phase)).toContain("overseer");
    },
  );

  it("the NEWEST file never leaves, even when every file predates the birth", async () => {
    const f = root();
    const a1 = put(f.root, `${OV}/x1.jsonl`, line("1"), BORN - 3 * DAY);
    const a2 = put(f.root, `${OV}/x2.jsonl`, line("2"), BORN - 2 * DAY);
    const a = archiver(f, {}, { overseerBornAt: () => new Date(T0 + 10 * DAY) });
    await a.tick();
    expect(existsSync(a1)).toBe(false);
    expect(existsSync(a2)).toBe(true);
    expect(a.status().stores?.overseer).toMatchObject({ archived: 1, kept_live: 1 });
  });

  it("an unreadable birth is UNKNOWN: nothing moves", async () => {
    const f = root();
    const old = put(f.root, `${OV}/old.jsonl`, line("o"), BORN - 3 * DAY);
    put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
    for (const born of [() => null, () => new Date("garbage")]) {
      const a = archiver(f, {}, { overseerBornAt: born });
      await a.tick();
      expect(existsSync(old)).toBe(true);
      expect(a.status().stores?.overseer).toMatchObject({
        outcome: "held",
        reason: "birth_unknown",
      });
      expect(existsSync(join(f.root, "archive", "overseer"))).toBe(false);
      a.stop();
    }
  });

  it(
    "two rotations on the same date no longer overwrite each other — both runs kept, by name",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const rig = sessionRig(f);
      writeFileSync(join(f.root, "prompts", "overseer-system.md"), "You are the overseer.\n");
      const at = (iso: string): void => {
        f.clock.ms = Date.parse(iso);
      };
      at("2026-10-21T09:00:00Z");
      await rig.m.ensureOverseerSession();
      const a = put(f.root, `${OV}/a.jsonl`, line("run a"), Date.parse("2026-10-21T09:30:00Z"));
      at("2026-10-21T10:00:00Z");
      expect(await rig.m.rotateOverseer()).toBe("2026-10-21");
      const b = put(f.root, `${OV}/b.jsonl`, line("run b"), Date.parse("2026-10-21T11:00:00Z"));
      at("2026-10-21T12:00:00Z");
      expect(await rig.m.rotateOverseer()).toBe("2026-10-21-2");
      const c = put(f.root, `${OV}/c.jsonl`, line("run c"), Date.parse("2026-10-21T12:30:00Z"));
      at("2026-10-21T13:00:00Z");
      const ar = onArchiver(f, {}, { overseerBornAt: () => rig.m.bornAt("overseer") ?? null });
      archivers.push(ar);
      await ar.tick();
      // Both earlier runs are archived under their own names; the current
      // one stays; each rotation's record keeps its own meta.json.
      expect(gz(f, "archive/overseer/transcripts/a.jsonl.gz").toString()).toBe(line("run a"));
      expect(gz(f, "archive/overseer/transcripts/b.jsonl.gz").toString()).toBe(line("run b"));
      expect(existsSync(a) || existsSync(b)).toBe(false);
      expect(existsSync(c)).toBe(true);
      const meta = (d: string) =>
        JSON.parse(readFileSync(join(f.root, "archive", "overseer", d, "meta.json"), "utf8"));
      expect(meta("2026-10-21").session_file).toBe(a);
      expect(meta("2026-10-21-2").session_file).toBe(b);
      for (const d of ["2026-10-21", "2026-10-21-2"])
        expect(existsSync(join(f.root, "archive", "overseer", d, "session.jsonl"))).toBe(false);
    },
  );
});

describe("the overseer's legacy rotation copies (§7.5)", () => {
  it(
    "exact and prefix duplicates are removed, a live one waits, an unmatched one is kept as a gzip",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const o1 = put(f.root, `${OV}/o1.jsonl`, line("one").repeat(50), BORN - 3 * DAY);
      const o2 = put(f.root, `${OV}/o2.jsonl`, line("two").repeat(50), BORN - 2 * DAY);
      const cur = put(f.root, `${OV}/cur.jsonl`, line("now").repeat(5), BORN + 60_000);
      const rec = (d: string, copy: string | Buffer, sessionFile: string | null): string => {
        put(f.root, `archive/overseer/${d}/ledger.md`, `ledger ${d}\n`);
        put(
          f.root,
          `archive/overseer/${d}/meta.json`,
          JSON.stringify({
            session: "overseer",
            archived_at: `${d}T10:00:00.000Z`,
            session_file: sessionFile,
          }),
        );
        return put(f.root, `archive/overseer/${d}/session.jsonl`, copy);
      };
      const exact = rec("2026-10-01", readFileSync(o1), o1);
      // A byte-prefix, named by another container's path (matched by name).
      const prefix = rec(
        "2026-10-02",
        readFileSync(o2).subarray(0, 400),
        "/opt/quickreview/state/pi-sessions/overseer/o2.jsonl",
      );
      const waits = rec("2026-10-03", readFileSync(cur), cur);
      const lone = rec("2026-10-04", "matches nothing at all\n", join(f.root, OV, "gone.jsonl"));
      const a = archiver(f);
      await a.tick();

      expect(existsSync(exact)).toBe(false);
      expect(existsSync(prefix)).toBe(false);
      expect(existsSync(waits)).toBe(true); // its transcript is still live
      expect(existsSync(lone)).toBe(false);
      const m = manifest(f, "overseer");
      const dups = m.entries.filter((e) => e.kind === "duplicate_removed");
      expect(
        dups
          .map((d) => [d.path, d.match, d.duplicate_of])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      ).toEqual([
        ["2026-10-01/session.jsonl", "exact", "transcripts/o1.jsonl.gz"],
        ["2026-10-02/session.jsonl", "prefix", "transcripts/o2.jsonl.gz"],
      ]);
      // The unmatched copy is KEPT, gzipped under the protocol.
      const legacy = m.entries.find((e) => e.kind === "transcript" && e.legacy === true)!;
      expect(legacy.archive).toBe("transcripts/session-at-close-20261004T100000Z.jsonl.gz");
      expect(gz(f, `archive/overseer/${legacy.archive as string}`).toString()).toBe(
        "matches nothing at all\n",
      );
      // ledger.md and meta.json are never touched.
      for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) {
        expect(readFileSync(join(f.root, "archive", "overseer", d, "ledger.md"), "utf8")).toBe(
          `ledger ${d}\n`,
        );
        expect(existsSync(join(f.root, "archive", "overseer", d, "meta.json"))).toBe(true);
      }
      expect(Number(mark(f, "duplicates.removed"))).toBe(2);
      expect(a.status().stores?.overseer).toMatchObject({
        duplicates_removed: 2,
        outcome: "partial",
        reason: "legacy_copy_waits",
      });
    },
  );

  it("a copy that matches its named transcript neither whole nor as a prefix is never removed as a duplicate", async () => {
    const f = root();
    const o1 = put(f.root, `${OV}/o1.jsonl`, line("one").repeat(50), BORN - 3 * DAY);
    put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
    put(f.root, `archive/overseer/2026-10-01/meta.json`, JSON.stringify({ session_file: o1 }));
    const differs = put(f.root, `archive/overseer/2026-10-01/session.jsonl`, "edited by hand\n");
    const a = archiver(f);
    await a.tick();
    const m = manifest(f, "overseer");
    expect(m.entries.filter((e) => e.kind === "duplicate_removed")).toEqual([]);
    // Kept, as its own gzip, before the plain copy went.
    const kept = m.entries.find((e) => e.legacy === true)!;
    expect(gz(f, `archive/overseer/${kept.archive as string}`).toString()).toBe("edited by hand\n");
    expect(existsSync(differs)).toBe(false);
  });
});

describe("verify, crash and plan mode", () => {
  it("a copy that does not verify keeps its source; the next pass archives it", async () => {
    const f = root();
    const old = put(f.root, `${OV}/old.jsonl`, line("o").repeat(100), BORN - 3 * DAY);
    put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
    let corrupt = true;
    const a = archiver(
      f,
      {},
      {
        step: (name, info) => {
          if (corrupt && name === "partial_written" && String(info.src).endsWith("old.jsonl")) {
            writeFileSync(String(info.partial), "not what was read");
          }
        },
      },
    );
    await a.tick();
    expect(existsSync(old)).toBe(true);
    expect(a.status().stores?.overseer).toMatchObject({ verify_failures: 1, outcome: "partial" });
    const anomalies = f.store.db
      .prepare(
        "SELECT 1 FROM events WHERE kind = 'anomaly' AND json_extract(payload, '$.kind') = 'archive_verify_failed'",
      )
      .all();
    expect(anomalies).toHaveLength(1);
    corrupt = false;
    await a.tick();
    expect(existsSync(old)).toBe(false);
    expect(
      filesUnder(f.root, join(f.root, "archive", "overseer")).filter((p) => p.endsWith(".partial")),
    ).toEqual([]);
  });

  it(
    "a crash between the entry and the unlink converges: unlink only, no second gzip",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const old = put(f.root, `${OV}/old.jsonl`, line("o").repeat(100), BORN - 3 * DAY);
      put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
      let crash = true;
      const a = archiver(
        f,
        {},
        {
          step: (name) => {
            if (crash && name === "manifest_appended") throw new Error("crash");
          },
        },
      );
      await a.tick();
      expect(existsSync(old)).toBe(true);
      expect(a.status().stores?.overseer).toMatchObject({ outcome: "failed" });
      crash = false;
      await a.tick();
      expect(existsSync(old)).toBe(false);
      const m = manifest(f, "overseer");
      expect(m.entries.filter((e) => e.kind === "transcript")).toHaveLength(1);
      expect(filesUnder(f.root, join(f.root, "archive", "overseer"))).toEqual([
        "archive/overseer/manifest.json",
        "archive/overseer/transcripts/old.jsonl.gz",
      ]);
    },
  );

  it("plan mode moves none of it", async () => {
    const f = root();
    const old = put(f.root, `${OV}/old.jsonl`, line("o"), BORN - 3 * DAY);
    put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
    const store = join(f.root, "pihome", "sessions");
    const pi = put(f.root, "pihome/sessions/x/old.jsonl", line("p"), T0 - 3 * DAY);
    const a = archiver(f, { mode: "plan" }, { piGlobalDir: store });
    await a.tick();
    expect(existsSync(old) && existsSync(pi)).toBe(true);
    expect(a.status().stores).toEqual({ overseer: null, pi_global: null });
  });
});

describe("pi's global session store", () => {
  it(
    "day-old JSONLs leave for archive/pi-global/; younger ones and other files stay; emptied dirs go, the store stays",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const storeDir = join(f.root, "pihome", ".pi", "agent", "sessions");
      const old = put(
        f.root,
        "pihome/.pi/agent/sessions/--cwd--/old.jsonl",
        line("old").repeat(40),
        T0 - 2 * DAY,
      );
      const young = put(
        f.root,
        "pihome/.pi/agent/sessions/--cwd--/young.jsonl",
        line("y"),
        T0 - HOUR,
      );
      const other = put(
        f.root,
        "pihome/.pi/agent/sessions/--cwd--/notes.txt",
        "keep\n",
        T0 - 9 * DAY,
      );
      const lonely = put(
        f.root,
        "pihome/.pi/agent/sessions/gone-dir/old2.jsonl",
        line("o2"),
        T0 - 3 * DAY,
      );
      const bytes = new Map([old, lonely].map((p) => [p, readFileSync(p)] as const));
      const a = archiver(f, {}, { piGlobalDir: storeDir, overseerBornAt: undefined });
      await a.tick();
      expect(existsSync(old)).toBe(false);
      expect(existsSync(lonely)).toBe(false);
      expect(gz(f, "archive/pi-global/--cwd--/old.jsonl.gz").equals(bytes.get(old)!)).toBe(true);
      expect(gz(f, "archive/pi-global/gone-dir/old2.jsonl.gz").equals(bytes.get(lonely)!)).toBe(
        true,
      );
      expect(existsSync(young) && existsSync(other)).toBe(true);
      expect(existsSync(join(storeDir, "gone-dir"))).toBe(false);
      expect(existsSync(storeDir)).toBe(true);
      const m = manifest(f, "pi-global");
      expect(m.subject).toBe("pi-global");
      // Sources are relative to the store (it lives on another volume).
      expect(
        m.entries
          .filter((e) => e.kind === "transcript")
          .map((e) => e.source)
          .sort(),
      ).toEqual(["--cwd--/old.jsonl", "gone-dir/old2.jsonl"]);
      expect(a.status().stores).toMatchObject({
        overseer: null,
        pi_global: { outcome: "done", archived: 2, removed: 2, kept_live: 1 },
      });
      expect(sha(readFileSync(young))).toBe(sha(line("y")));
    },
  );

  it("an absent store is nothing to move", async () => {
    const f = root();
    const a = archiver(
      f,
      {},
      { piGlobalDir: join(f.root, "no-such-home"), overseerBornAt: undefined },
    );
    await a.tick();
    expect(a.status().stores?.pi_global).toMatchObject({ outcome: "none", archived: 0 });
  });
});

describe("the plan measures the stores (§13: before anyone flips to `on`)", () => {
  it("what is there and what a pass would move — movable UNKNOWN when the birth is not visible", async () => {
    const f = root();
    put(f.root, `${OV}/old.jsonl`, "x".repeat(100), BORN - 3 * DAY);
    put(f.root, `${OV}/cur.jsonl`, "y".repeat(10), BORN + 60_000);
    put(f.root, `archive/overseer/2026-10-01/session.jsonl`, "z".repeat(7));
    const storeDir = join(f.root, "pihome", "sessions");
    put(f.root, "pihome/sessions/a/old.jsonl", "p".repeat(40), T0 - 2 * DAY);
    put(f.root, "pihome/sessions/a/new.jsonl", "q".repeat(5), T0 - HOUR);
    const a = archiver(f, { mode: "plan" }, { piGlobalDir: storeDir });
    await a.tick();
    expect(a.lastPlan()?.stores).toEqual({
      overseer: {
        state: "measured",
        files: 2,
        bytes: 110,
        movable_files: 1,
        movable_bytes: 100,
        legacy_copies: 1,
        legacy_bytes: 7,
      },
      pi_global: {
        state: "measured",
        files: 2,
        bytes: 45,
        movable_files: 1,
        movable_bytes: 40,
        legacy_copies: 0,
        legacy_bytes: 0,
      },
    });
    // A CLI plan cannot see the birth: the overseer's movable count is
    // UNKNOWN, never a guessed number; no store dir, no pi-global tally.
    const cli = await computePlan({
      store: f.store,
      root: f.root,
      sessionsRoot: join(f.root, "state", "pi-sessions"),
      now: () => new Date(f.clock.ms),
      afterDays: 14,
      eventsAfterDays: 35,
      liveSessions: async () => [],
    });
    expect(cli.stores?.overseer).toMatchObject({
      files: 2,
      movable_files: null,
      movable_bytes: null,
    });
    expect(cli.stores?.pi_global).toBeNull();
    const text = renderArchiveReport({
      block: undefined,
      statusNote: "x",
      ledger: { by_state: {}, archived_event_rows: 0, marks: {} },
      policy: archivePolicy(ARCHIVE_DEFAULTS),
      plan: cli,
    });
    expect(text).toContain("overseer store: 2 file(s), 110 B live — movable UNKNOWN");
    expect(text).toContain("legacy rotation copies to check: 1, 7 B");
    expect(text).toContain("pi-global store: not measured");
    // Nothing moved: plan mode.
    expect(filesUnder(f.root, join(f.root, OV))).toHaveLength(2);
  });
});

// ---- S4 review: the store manifest, the re-checks and the stops -----------

const GIB = 1024 ** 3;
const anomaliesOf = (f: PrFixture, kind: string): unknown[] =>
  f.store.db
    .prepare("SELECT 1 FROM events WHERE kind = 'anomaly' AND json_extract(payload, '$.kind') = ?")
    .all(kind);
const turns = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
/** A store entry whose source left long ago (stamped), for a full shard. */
const pastEntry = (i: number) => ({
  pass: "20261001T000000Z",
  kind: "transcript",
  source: `d/f${i}.jsonl`,
  archive: `d/f${i}.jsonl.gz`,
  bytes: 1,
  mtime_ms: 1,
  dev: 1,
  ino: i + 1,
  sha256: "a".repeat(64),
  gz_bytes: 1,
  verified_at: "2026-10-01T00:00:00.000Z",
  source_removed_at: "2026-10-01T00:00:00.000Z",
});
const fullShard = (subject: string) =>
  `${JSON.stringify(
    {
      format: 1,
      subject,
      passes: [
        {
          id: "20261001T000000Z",
          kind: "archive",
          started_at: "2026-10-01T00:00:00.000Z",
          finished_at: "2026-10-01T00:00:00.000Z",
        },
      ],
      entries: Array.from({ length: STORE_SHARD_ENTRIES }, (_, i) => pastEntry(i)),
    },
    null,
    1,
  )}\n`;

describe("a store's manifest is sharded: no write grows with its history (S4 review)", () => {
  it(
    "a full shard is never rewritten — the next entries start manifest-2.json; names and the index span the shards; the work is measured",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const storeDir = join(f.root, "pihome", "sessions");
      const dir = join(f.root, "archive", "pi-global");
      put(f.root, "archive/pi-global/manifest.json", fullShard("pi-global"));
      const first = readFileSync(join(dir, "manifest.json"));
      // The same source as shard 1's first entry (a later version): its name
      // is referenced there, so it is archived under the next one.
      const again = put(f.root, "pihome/sessions/d/f0.jsonl", line("again"), T0 - 2 * DAY);
      const a = archiver(f, {}, { piGlobalDir: storeDir, overseerBornAt: undefined });
      await a.tick();
      expect(existsSync(again)).toBe(false);
      expect(gz(f, "archive/pi-global/d/f0.jsonl.v2.gz").toString()).toBe(line("again"));
      // Shard 1 untouched, byte for byte; the entry and the pass in shard 2.
      expect(readFileSync(join(dir, "manifest.json")).equals(first)).toBe(true);
      const second = JSON.parse(readFileSync(join(dir, "manifest-2.json"), "utf8")) as {
        subject: string;
        passes: Array<{ id: string; finished_at?: string }>;
        entries: Array<Record<string, unknown>>;
      };
      expect(second.subject).toBe("pi-global");
      expect(second.entries).toEqual([
        expect.objectContaining({
          kind: "transcript",
          source: "d/f0.jsonl",
          archive: "d/f0.jsonl.v2.gz",
          source_removed_at: expect.any(String),
        }),
      ]);
      expect(second.passes).toHaveLength(1);
      expect(typeof second.passes[0]!.finished_at).toBe("string");
      // A second pass appends to shard 2 (room left); shard 1 still as it was.
      const later = put(f.root, "pihome/sessions/d/g.jsonl", line("g"), T0 - 2 * DAY);
      await a.tick();
      expect(existsSync(later)).toBe(false);
      expect(readFileSync(join(dir, "manifest.json")).equals(first)).toBe(true);
      const shards = await readStoreShards(dir);
      expect(shards.map((s) => s.name)).toEqual(["manifest.json", "manifest-2.json"]);
      expect(shards.map((s) => s.m.entries.length)).toEqual([STORE_SHARD_ENTRIES, 2]);

      // The writer's synchronous spans (the parse, the index, each write's
      // copy, check and stringify) are measured.
      const meter = new SpanMeter();
      const deps: StorePassDeps = {
        dir,
        subject: "pi-global",
        now: () => new Date(f.clock.ms),
        level: 6,
        bytesPerS: 200 * 1024 * 1024,
        signal: new AbortController().signal,
        diskFor: async () => null,
        stopReason: () => null,
        verifyFailed: () => {},
        log: () => {},
        liveOf: (source) => join(storeDir, source),
        meter,
      };
      const w = (await StoreWriter.open(deps))!;
      expect(w.records().get("d/f0.jsonl")?.archive).toBe("d/f0.jsonl.v2.gz");
      expect(w.records().get("d/f499.jsonl")?.archive).toBe("d/f499.jsonl.gz");
      expect(meter.max).toBeGreaterThan(0);
    },
  );

  it("a shard missing from the run is an unreadable record: the store is held, nothing moves, nothing is overwritten", async () => {
    const f = root();
    const storeDir = join(f.root, "pihome", "sessions");
    put(f.root, "archive/pi-global/manifest.json", fullShard("pi-global"));
    put(f.root, "archive/pi-global/manifest-3.json", fullShard("pi-global"));
    const lone = readFileSync(join(f.root, "archive/pi-global/manifest-3.json"));
    const old = put(f.root, "pihome/sessions/x/old.jsonl", line("o"), T0 - 2 * DAY);
    const a = archiver(f, {}, { piGlobalDir: storeDir, overseerBornAt: undefined });
    await a.tick();
    expect(existsSync(old)).toBe(true);
    expect(a.status().stores?.pi_global).toMatchObject({
      outcome: "held",
      reason: "manifest_unreadable",
    });
    expect(anomaliesOf(f, "archive_verify_failed")).toHaveLength(1);
    expect(readFileSync(join(f.root, "archive/pi-global/manifest-3.json")).equals(lone)).toBe(true);
    expect(existsSync(join(f.root, "archive/pi-global/manifest-2.json"))).toBe(false);
    // The first shard gone too: never read as "no manifest".
    unlinkSync(join(f.root, "archive/pi-global/manifest.json"));
    await expect(readStoreShards(join(f.root, "archive/pi-global"))).rejects.toThrow(
      /manifest\.json is missing/,
    );
  });
});

describe("the identity re-check before every store unlink (S4 review)", () => {
  it(
    "pi's global store: a file appended to after it was hashed is never unlinked — the next pass archives the new version",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const storeDir = join(f.root, "pihome", "sessions");
      const before = line("old").repeat(30);
      const old = put(f.root, "pihome/sessions/--cwd--/old.jsonl", before, T0 - 2 * DAY);
      let late = true;
      const a = archiver(
        f,
        {},
        {
          piGlobalDir: storeDir,
          overseerBornAt: undefined,
          step: (name, info) => {
            if (late && name === "manifest_appended" && info.store === "pi-global") {
              late = false;
              appendFileSync(old, line("late"));
              const t = (T0 - 2 * DAY + 5_000) / 1000; // still a day old
              utimesSync(old, t, t);
            }
          },
        },
      );
      await a.tick();
      // The appended bytes exist live; the archive holds only what was hashed.
      expect(readFileSync(old, "utf8")).toBe(before + line("late"));
      expect(gz(f, "archive/pi-global/--cwd--/old.jsonl.gz").toString()).toBe(before);
      expect(a.status().stores?.pi_global).toMatchObject({
        outcome: "partial",
        reason: "incomplete",
        archived: 1,
        removed: 0,
      });
      await a.tick();
      expect(existsSync(old)).toBe(false);
      expect(gz(f, "archive/pi-global/--cwd--/old.jsonl.v2.gz").toString()).toBe(
        before + line("late"),
      );
      expect(a.status().stores?.pi_global).toMatchObject({ outcome: "done", removed: 1 });
    },
  );

  it(
    "the overseer store: the same — a non-current file written after it was hashed stays live",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const before = line("o").repeat(30);
      const old = put(f.root, `${OV}/old.jsonl`, before, BORN - 3 * DAY);
      put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
      let late = true;
      const a = archiver(
        f,
        {},
        {
          step: (name, info) => {
            if (late && name === "manifest_appended" && info.store === "overseer") {
              late = false;
              appendFileSync(old, line("late"));
              const t = (BORN - 3 * DAY + 5_000) / 1000;
              utimesSync(old, t, t);
            }
          },
        },
      );
      await a.tick();
      expect(readFileSync(old, "utf8")).toBe(before + line("late"));
      expect(gz(f, "archive/overseer/transcripts/old.jsonl.gz").toString()).toBe(before);
      expect(a.status().stores?.overseer).toMatchObject({
        outcome: "partial",
        reason: "incomplete",
        removed: 0,
      });
      await a.tick();
      expect(existsSync(old)).toBe(false);
      expect(gz(f, "archive/overseer/transcripts/old.jsonl.v2.gz").toString()).toBe(
        before + line("late"),
      );
    },
  );

  it(
    "a legacy copy changed between its comparison and its removal is kept — no duplicate_removed entry",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const o1 = put(f.root, `${OV}/o1.jsonl`, line("one").repeat(50), BORN - 3 * DAY);
      put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
      put(f.root, "archive/overseer/2026-10-01/meta.json", JSON.stringify({ session_file: o1 }));
      const copy = put(f.root, "archive/overseer/2026-10-01/session.jsonl", readFileSync(o1));
      const a = archiver(
        f,
        {},
        {
          step: (name, info) => {
            // After the copy was compared (and found equal), before its removal.
            if (name === "unlinked" && info.path === o1) appendFileSync(copy, "edited\n");
          },
        },
      );
      await a.tick();
      expect(existsSync(o1)).toBe(false);
      expect(existsSync(copy)).toBe(true);
      expect(readFileSync(copy, "utf8")).toBe(line("one").repeat(50) + "edited\n");
      const m = manifest(f, "overseer");
      expect(m.entries.filter((e) => e.kind === "duplicate_removed")).toEqual([]);
      expect(a.status().stores?.overseer).toMatchObject({
        outcome: "partial",
        reason: "incomplete",
        duplicates_removed: 0,
      });
      expect(mark(f, "duplicates.removed")).toBeUndefined();
    },
  );

  it(
    "the overseer's birth is re-read before the unlinks: one gone unknown keeps every file live, the next pass unlinks only",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const old = put(f.root, `${OV}/old.jsonl`, line("o").repeat(40), BORN - 3 * DAY);
      put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
      let birth: Date | null = new Date(BORN);
      const a = archiver(
        f,
        {},
        {
          overseerBornAt: () => birth,
          step: (name, info) => {
            if (name === "manifest_appended" && info.store === "overseer") birth = null;
          },
        },
      );
      await a.tick();
      expect(existsSync(old)).toBe(true);
      expect(a.status().stores?.overseer).toMatchObject({
        outcome: "partial",
        reason: "birth_unknown",
        archived: 1,
        removed: 0,
      });
      const entry = manifest(f, "overseer").entries.find((e) => e.kind === "transcript")!;
      expect(entry.source_removed_at).toBeUndefined();
      birth = new Date(BORN);
      await a.tick();
      expect(existsSync(old)).toBe(false);
      // Unlink only: no second gzip, one entry, now stamped.
      expect(filesUnder(f.root, join(f.root, "archive", "overseer"))).toEqual([
        "archive/overseer/manifest.json",
        "archive/overseer/transcripts/old.jsonl.gz",
      ]);
      const entries = manifest(f, "overseer").entries.filter((e) => e.kind === "transcript");
      expect(entries).toHaveLength(1);
      expect(typeof entries[0]!.source_removed_at).toBe("string");
    },
  );
});

describe("the stores obey every stop (S4 review)", () => {
  it(
    "one file too large for the archive mount holds only its store — the next store still runs, the wake raised once",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const big = put(f.root, `${OV}/big.jsonl`, "b".repeat(5_000), BORN - 3 * DAY);
      put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
      const storeDir = join(f.root, "pihome", "sessions");
      const small = put(f.root, "pihome/sessions/x/small.jsonl", "s".repeat(100), T0 - 2 * DAY);
      // Both mounts keep the 2 GiB headroom, with 1,000 bytes beyond it.
      const a = archiver(
        f,
        {},
        { piGlobalDir: storeDir, statfs: async () => ({ bavail: 2 * GIB + 1_000, bsize: 1 }) },
      );
      await a.tick();
      expect(existsSync(big)).toBe(true);
      expect(existsSync(join(f.root, "archive/overseer/transcripts/big.jsonl.gz"))).toBe(false);
      expect(a.status().stores?.overseer).toMatchObject({
        outcome: "partial",
        reason: "disk_low",
        archived: 0,
        removed: 0,
      });
      expect(existsSync(small)).toBe(false);
      expect(a.status().stores?.pi_global).toMatchObject({
        outcome: "done",
        archived: 1,
        removed: 1,
      });
      expect(anomaliesOf(f, "archive_disk_low")).toHaveLength(1);
    },
  );

  it(
    "a restore issued during a store pass waits for the file boundary: the file in hand gets its entry, no next file starts, nothing is unlinked",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = prFixture();
      open.push(f);
      const first = onArchiver(f);
      await first.tick();
      first.stop();
      expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
      const storeDir = join(f.root, "pihome", "sessions");
      const files = [1, 2, 3].map((i) =>
        put(f.root, `pihome/sessions/x/p${i}.jsonl`, line(`p${i}`).repeat(20), T0 - (5 - i) * DAY),
      );
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atStep = new Promise<void>((r) => (reached = r));
      let held = false;
      const a = archiver(
        f,
        {},
        {
          piGlobalDir: storeDir,
          overseerBornAt: undefined,
          step: async (name, info) => {
            const of = info.src ?? info.source ?? info.path;
            order.push(`${name}${typeof of === "string" ? `:${basename(of)}` : ""}`);
            if (!held && name === "renamed" && String(info.src).startsWith(storeDir)) {
              held = true;
              reached();
              await gate;
            }
          },
        },
      );
      const tick = a.tick();
      await atStep;
      let settled = false;
      const restore = a.operatorRestore(f.pr).then((r) => {
        order.push("restore-answered");
        settled = true;
        return r;
      });
      await turns(20);
      expect(settled).toBe(false); // it waits for the mutex…
      release();
      expect((await tick).state).toBe("idle"); // …the pass yields to it…
      expect(await restore).toMatchObject({ ok: true, done: true, outcome: "restored" });
      // …at the FILE BOUNDARY: the file in hand got its entry; no next file
      // was started; nothing was unlinked.
      const cut = order.indexOf("renamed:p1.jsonl");
      expect(cut).toBeGreaterThanOrEqual(0);
      expect(order[cut + 1]).toBe("manifest_appended:p1.jsonl");
      expect(order.filter((s) => s.startsWith("partial_written"))).toEqual([
        "partial_written:p1.jsonl",
      ]);
      expect(order.filter((s) => s.startsWith("unlinked"))).toEqual([]);
      for (const p of files) expect(existsSync(p), p).toBe(true);
      expect(a.status().stores?.pi_global).toMatchObject({
        outcome: "partial",
        reason: "restore_pending",
        archived: 1,
        removed: 0,
      });
      expect(archiveRow(f.store, f.pr)?.state).toBe("restored");
      // The next pass: the held file is unlinked only, the others archived.
      await a.tick();
      for (const p of files) expect(existsSync(p), p).toBe(false);
      expect(manifest(f, "pi-global").entries.filter((e) => e.kind === "transcript")).toHaveLength(
        3,
      );
    },
  );

  it(
    "a tick budget spent inside one store starts no other store",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = root();
      const o1 = put(f.root, `${OV}/o1.jsonl`, line("o1").repeat(20), BORN - 3 * DAY);
      put(f.root, `${OV}/cur.jsonl`, line("now"), BORN + 60_000);
      const storeDir = join(f.root, "pihome", "sessions");
      const pi = put(f.root, "pihome/sessions/x/p.jsonl", line("p"), T0 - 2 * DAY);
      const a = archiver(
        f,
        {},
        {
          piGlobalDir: storeDir,
          step: (name, info) => {
            // The budget (300 s in this rig) runs out with the overseer's file.
            if (name === "manifest_appended" && info.store === "overseer") f.clock.ms += 400_000;
          },
        },
      );
      await a.tick();
      // The file in hand finished, its verified source unlinked (a spent
      // budget never strands a copy)…
      expect(existsSync(o1)).toBe(false);
      expect(a.status().stores?.overseer).toMatchObject({ outcome: "done", archived: 1 });
      // …and pi's global store was never started.
      expect(existsSync(pi)).toBe(true);
      expect(a.status().stores?.pi_global).toBeNull();
      expect(existsSync(join(f.root, "archive", "pi-global"))).toBe(false);
    },
  );
});
