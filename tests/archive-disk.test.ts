// The disk guard (docs/archiving.md §7.7, acceptance 8). Before
// each file, statfs on both mounts: the archive mount needs the file's size
// plus `disk_headroom_gb`, the state mount the headroom. Short of it, NO file
// is started (`held_reason: disk_low`) and the `archive_disk_low` WAKE fires
// once per incident (again only every 6 h while it lasts) — an incident ends
// only at a reading with room for what raised it. A mount short of the
// headroom holds the tick; one file too large for the archive mount holds
// only its PR, and the next PR goes on. A failed statfs is `disk_unknown` — a
// hold, never a guess, and not a wake.
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANOMALY_REPEAT_MS, PLAN_REFRESH_MS } from "../src/archive/archiver.js";
import { archiveRow } from "../src/archive/rows.js";
import { anomalySeverity, wakeKinds } from "../src/anomalies.js";
import {
  DAY,
  T0,
  filesUnder,
  onArchiver,
  prFixture,
  put,
  type PrFixture,
} from "./helpers/archive-pr.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const GB = 1024 ** 3;
const HEADROOM = 2 * GB; // ARCHIVE_DEFAULTS.disk_headroom_gb

const open: PrFixture[] = [];
afterEach(() => {
  for (const f of open.splice(0)) f.close();
});
const fixture = (): PrFixture => {
  const f = prFixture();
  open.push(f);
  return f;
};

const diskWakes = (f: PrFixture): number =>
  f.store.anomalies().filter((x) => x.kind === "archive_disk_low").length;
const untouched = (f: PrFixture): void => {
  for (const rel of [...f.transcripts, ...f.small])
    expect(existsSync(join(f.root, rel)), rel).toBe(true);
  expect(
    filesUnder(join(f.root, "archive", `pr-${f.pr}`)).filter((p) => /\.gz|partial/.test(p)),
  ).toEqual([]);
};

describe("the disk guard (acceptance 8)", () => {
  it("both kinds are deliberate wakes", () => {
    expect(wakeKinds()).toContain("archive_disk_low");
    expect(anomalySeverity("archive_disk_low")).toBe("wake");
  });

  it(
    "free space below the headroom: no file started, held disk_low, ONE wake per incident",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      let free = HEADROOM - 1;
      const a = onArchiver(f, {}, { statfs: async () => ({ bavail: free, bsize: 1 }) });
      try {
        expect(await a.tick()).toMatchObject({ state: "held", held_reason: "disk_low" });
        untouched(f);
        expect(diskWakes(f)).toBe(1);
        expect(a.status().disk).toEqual({
          archive_free: free,
          state_free: free,
          headroom: HEADROOM,
        });
        // Still low on the next ticks: the same incident, no second wake.
        f.clock.ms += 60_000;
        await a.tick();
        f.clock.ms += 60_000;
        await a.tick();
        expect(diskWakes(f)).toBe(1);
        // …until 6 h of it, when it is said again.
        f.clock.ms += ANOMALY_REPEAT_MS;
        await a.tick();
        expect(diskWakes(f)).toBe(2);
        // Room again: the incident ends and the PR is archived.
        free = 1e12;
        f.clock.ms += 60_000;
        expect((await a.tick()).state).toBe("idle");
        expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
        // Low again: a NEW incident, a new wake at once.
        free = HEADROOM - 1;
        f.clock.ms += 60_000;
        await a.tick();
        expect(diskWakes(f)).toBe(3);
      } finally {
        a.stop();
      }
    },
  );

  it(
    "a wake the store could not record holds no window: the next low reading raises it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const log = f.store.logAnomaly.bind(f.store);
      let failures = 1;
      f.store.logAnomaly = ((...args: Parameters<typeof log>) => {
        if (args[0] === "archive_disk_low" && failures-- > 0) throw new Error("SQLITE_BUSY");
        return log(...args);
      }) as typeof f.store.logAnomaly;
      const a = onArchiver(f, {}, { statfs: async () => ({ bavail: HEADROOM - 1, bsize: 1 }) });
      try {
        expect(await a.tick()).toMatchObject({ state: "held", held_reason: "disk_low" });
        expect(diskWakes(f)).toBe(0);
        f.clock.ms += 60_000;
        await a.tick();
        expect(diskWakes(f)).toBe(1);
        f.clock.ms += 60_000;
        await a.tick();
        expect(diskWakes(f)).toBe(1);
      } finally {
        a.stop();
      }
    },
  );

  it(
    "room for the headroom but not for the next file: that PR waits, the next PR goes on, and the wake fires ONCE across ticks",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      // A second closed PR, closed later (so queued after f's), whose one
      // transcript is small enough to fit.
      const small = 5501;
      const closed = T0 - 14.5 * DAY;
      f.clock.ms = closed - 60_000;
      f.store.upsertPr({
        number: small,
        state: "closed",
        head_sha: "def",
        title: "small",
        author: "a",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      f.clock.ms = closed;
      f.store.logEvent("pr_closed", small, { merged: true });
      f.clock.ms = T0;
      const smallRel = `state/pi-sessions/pr-${small}/2026-10-05T10-00-00_s.jsonl`;
      put(f.root, smallRel, "x\n", closed - DAY);
      // 100 bytes over the headroom: the tick-level check passes, every one
      // of f's transcripts is bigger than 100 bytes, the small one is not.
      let free = HEADROOM + 100;
      const a = onArchiver(f, {}, { statfs: async () => ({ bavail: free, bsize: 1 }) });
      try {
        // Not a phase-wide hold: f waits, the small PR is archived.
        expect((await a.tick()).state).toBe("idle");
        untouched(f);
        expect(existsSync(join(f.root, smallRel))).toBe(false);
        expect(archiveRow(f.store, small)?.state).toBe("archived");
        expect(diskWakes(f)).toBe(1);
        expect(a.status().files).toMatchObject({ outcome: "done", prs_archived: 1 });
        expect(a.status().held_prs!.first).toContainEqual({ pr: f.pr, reason: "disk_low" });
        // The guard was armed for f (its row is committed first); nothing left.
        expect(archiveRow(f.store, f.pr)?.state).toBe("archiving");
        // Every later tick — the tick's own headroom check passing each time,
        // and f tried again at the next plan — is the SAME incident.
        for (let i = 0; i < 3; i++) {
          f.clock.ms += 61_000;
          await a.tick();
        }
        f.clock.ms += PLAN_REFRESH_MS;
        await a.tick();
        untouched(f);
        expect(diskWakes(f)).toBe(1);
        // Room for f's files: the incident ends and f is archived.
        free = 1e12;
        f.clock.ms += PLAN_REFRESH_MS;
        expect((await a.tick()).state).toBe("idle");
        expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
        // Short of a file again later: a NEW incident, a new wake at once.
        free = HEADROOM - 1;
        f.clock.ms += 60_000;
        await a.tick();
        expect(diskWakes(f)).toBe(2);
      } finally {
        a.stop();
      }
    },
  );

  describe("BOTH mounts are measured (statfs per path)", () => {
    /** A statfs that answers `state` for the state mount, `archive` else. */
    const byMount =
      (state: number, archive: number) =>
      async (p: string): Promise<{ bavail: number; bsize: number }> => ({
        bavail: p.endsWith(`${sep}state`) ? state : archive,
        bsize: 1,
      });

    it("the STATE mount short of the headroom holds — whatever the archive mount has", async () => {
      const f = fixture();
      const a = onArchiver(f, {}, { statfs: byMount(HEADROOM - 1, 1e12) });
      try {
        expect(await a.tick()).toMatchObject({ state: "held", held_reason: "disk_low" });
        untouched(f);
        expect(diskWakes(f)).toBe(1);
        expect(a.status().disk).toEqual({
          archive_free: 1e12,
          state_free: HEADROOM - 1,
          headroom: HEADROOM,
        });
      } finally {
        a.stop();
      }
    });

    it("the ARCHIVE mount short of the headroom holds — whatever the state mount has", async () => {
      const f = fixture();
      const a = onArchiver(f, {}, { statfs: byMount(1e12, HEADROOM - 1) });
      try {
        expect(await a.tick()).toMatchObject({ state: "held", held_reason: "disk_low" });
        untouched(f);
        expect(diskWakes(f)).toBe(1);
      } finally {
        a.stop();
      }
    });

    it(
      "a file's size is asked of the ARCHIVE mount only: the state mount needs just the headroom",
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        const f = fixture();
        // The state mount 100 bytes over the headroom (less than any file),
        // the archive mount with plenty: everything moves.
        const a = onArchiver(f, {}, { statfs: byMount(HEADROOM + 100, 1e12) });
        try {
          expect((await a.tick()).state).toBe("idle");
          expect(archiveRow(f.store, f.pr)?.state).toBe("archived");
          expect(diskWakes(f)).toBe(0);
        } finally {
          a.stop();
        }
      },
    );
  });

  it(
    "a failed statfs is disk_unknown: held, nothing started — and not a wake",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const f = fixture();
      const a = onArchiver(
        f,
        {},
        {
          statfs: async () => {
            throw Object.assign(new Error("EIO"), { code: "EIO" });
          },
        },
      );
      try {
        expect(await a.tick()).toMatchObject({ state: "held", held_reason: "disk_unknown" });
        untouched(f);
        expect(diskWakes(f)).toBe(0);
        expect(a.status().disk).toBeNull();
      } finally {
        a.stop();
      }
    },
  );

  it("plan mode holds on a low disk too, but writes nothing — not even the wake", async () => {
    const f = fixture();
    const a = onArchiver(f, { mode: "plan" }, { statfs: async () => ({ bavail: 1, bsize: 1 }) });
    try {
      expect(await a.tick()).toMatchObject({ state: "held", held_reason: "disk_low" });
      expect(diskWakes(f)).toBe(0);
    } finally {
      a.stop();
    }
  });
});
