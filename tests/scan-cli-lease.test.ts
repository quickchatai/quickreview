// The scan driver lease (src/setup/scanlease.ts) as two ScanRunners over one
// state home see it — the companion and a `qcr scan start` driver, or two
// drivers: the one that drives holds the lease; the other reads its run as
// running (not interrupted), refuses to start a second run, and leaves the
// run's stop request to the holder. A lease no longer renewed lapses, and the
// run reads as interrupted again.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRIVER_DIR,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  fileLease,
  liveLease,
} from "../src/setup/scanlease.js";
import { watchTuiRequests } from "../extensions/setup-scan.js";
import type { ScanRunner } from "../src/setup/scanrun.js";
import { SCAN_STOP_FILE } from "../src/setup/scanreport.js";
import { scanRig } from "./helpers/scan-cli-rig.js";

const OLD = new Date("2026-01-01T00:00:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-lease-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function startHanging() {
  const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
  const a = scanRig({ dir, hang: (s) => s.unit === "lib", holder: "driver-a", clock });
  const b = scanRig({ dir, holder: "driver-b", clock });
  const p = await a.scan.preview();
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await a.scan.start({ key: p.preview.key });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { a, b, run: r.run };
}

describe("the scan driver lease", () => {
  it("another runner reads the held run as running and refuses a second start", async () => {
    const { a, b, run } = await startHanging();
    expect(b.scan.status().run).toMatchObject({ id: run.id, display: "running" });
    expect(b.scan.status().active).toBe(false);
    const p = await b.scan.preview();
    expect(p).toMatchObject({ ok: false });
    expect(p.ok ? "" : p.errors.join(" ")).toMatch(
      new RegExp(`scan ${run.id} is running in another process`),
    );
    a.scan.stop();
    await a.scan.idle();
  });

  it("a stop request for the held run is left to its holder, which answers it", async () => {
    const { a, b, run } = await startHanging();
    writeFileSync(
      join(a.home, SCAN_STOP_FILE),
      JSON.stringify({ id: "req-1", run: run.id, at: "t", by: "cli" }),
    );
    expect(b.scan.consumeStopRequest()).toBeNull();
    expect(a.scan.consumeStopRequest()).toMatchObject({ request: "req-1", ok: true });
    await a.scan.idle();
    expect(a.scan.status().run!.state).toBe("stopped");
  });

  it("the lease is given up when the run ends, so the next start is free", async () => {
    const { a, b } = await startHanging();
    a.scan.stop();
    await a.scan.idle();
    expect(a.lease.other()).toBeNull();
    expect(b.lease.other()).toBeNull();
    const p = await b.scan.preview();
    if (!p.ok) throw new Error("preview");
    expect((await b.scan.start({ key: p.preview.key })).ok).toBe(true);
    await b.scan.idle();
  });

  it("a lease its holder stopped renewing lapses: the run reads as interrupted", async () => {
    const { a, b, run } = await startHanging();
    b.advance(LEASE_TTL_MS + 1);
    expect(b.scan.status().run).toMatchObject({ id: run.id, display: "interrupted" });
    a.scan.stop();
    await a.scan.idle();
  });

  it("an unreadable lease file is no lease", async () => {
    const rig = scanRig({ dir });
    mkdirSync(join(rig.home, DRIVER_DIR), { recursive: true });
    writeFileSync(join(rig.home, DRIVER_DIR, "1.json"), "{not json");
    // Older than the lease's life: no one is still writing it.
    utimesSync(join(rig.home, DRIVER_DIR, "1.json"), OLD, OLD);
    expect(rig.lease.other()).toBeNull();
    const p = await rig.scan.preview();
    if (!p.ok) throw new Error("preview");
    expect((await rig.scan.start({ key: p.preview.key })).ok).toBe(true);
    await rig.scan.idle();
  });

  it("of two claims racing for one generation exactly one wins", () => {
    const home = join(dir, "state");
    const now = () => new Date("2026-09-29T10:00:00Z");
    const a = fileLease(home, { clock: now, holder: "a" });
    // B reads the lease (none), then A claims before B creates its own.
    let aWon: boolean | null = null;
    const b = fileLease(home, {
      clock: now,
      holder: "b",
      beforeCreate: () => {
        aWon ??= a.claim(null);
      },
    });
    const bWon = b.claim(null);
    expect(aWon).toBe(true);
    expect(bWon).toBe(false);
    expect(b.other()).toMatchObject({ holder: "a" });
    expect(a.other()).toBeNull();
    expect(liveLease(home, now())).toMatchObject({ holder: "a" });
  });

  it("a lapsed lease is taken over by a new generation, and its old holder can no longer renew it", () => {
    const home = join(dir, "state");
    let t = Date.parse("2026-09-29T10:00:00Z");
    const clock = () => new Date(t);
    const a = fileLease(home, { clock, holder: "a" });
    const b = fileLease(home, { clock, holder: "b" });
    expect(a.claim("run-1")).toBe(true);
    expect(b.claim(null)).toBe(false);
    t += LEASE_TTL_MS + 1;
    expect(b.claim(null)).toBe(true);
    expect(a.renew("run-1")).toBe(false);
    expect(a.other()).toMatchObject({ holder: "b" });
  });

  it("a start refused after planning gives the lease up", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const a = scanRig({ dir, holder: "driver-a", clock });
    const b = scanRig({ dir, holder: "driver-b", clock });
    const r = await a.scan.start({ key: "stale" });
    expect(r.ok).toBe(false);
    expect(b.lease.other()).toBeNull();
  });

  it("the driving runner renews its lease, so a long run never lapses", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { a, b, run } = await startHanging();
      for (let i = 0; i < 4; i++) {
        b.advance(LEASE_RENEW_MS * 2);
        await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
      }
      // 40s after the start: only a renewal keeps it live.
      expect(b.scan.status().run).toMatchObject({ id: run.id, display: "running" });
      a.scan.stop();
      await a.scan.idle();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a driver that lost its lease stops its run and writes no more to the run record", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { a, b, run } = await startHanging();
      const reconciled = vi.spyOn(
        a.scan as unknown as { reconcile: (...args: unknown[]) => void },
        "reconcile",
      );
      // A is suspended past the TTL; B takes the lease over and starts.
      b.advance(LEASE_TTL_MS + 1);
      const p = await b.scan.preview();
      if (!p.ok) throw new Error("preview");
      const started = await b.scan.start({ key: p.preview.key });
      expect(started.ok).toBe(true);
      // A wakes: its next renewal finds the lease lost.
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
      await a.scan.idle();
      await b.scan.idle();
      const current = b.scan.status().run!;
      expect(current.id).not.toBe(run.id);
      expect(current.state).toBe("complete");
      expect(a.logs.some((l) => /driver lease was lost/.test(l))).toBe(true);
      // The fenced run settles nothing: no reconcile, no ticket close.
      expect(reconciled).not.toHaveBeenCalled();
      expect(a.closeFixedCalls()).toBe(0);
      expect(b.closeFixedCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a start whose lease lapsed while it planned is refused, and runs nothing", async () => {
    const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
    const b = scanRig({ dir, holder: "driver-b", clock });
    let tookOver: boolean | null = null;
    const a = scanRig({
      dir,
      holder: "driver-a",
      clock,
      // Planning outlasts the TTL (a blocked event loop renews nothing), and
      // B takes the lapsed lease over meanwhile.
      duringPlan: () => {
        if (tookOver !== null) return;
        clock.t += LEASE_TTL_MS + 1;
        tookOver = b.lease.claim(null);
      },
    });
    const p = await b.scan.preview();
    if (!p.ok) throw new Error("preview");
    const r = await a.scan.start({ key: p.preview.key });
    expect(tookOver).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.errors.join(" ")).toMatch(/lease/);
    expect(a.scan.status().run).toBeNull();
    expect(b.lease.other()).toBeNull();
  });
});

describe("the lease files", () => {
  const home = () => join(dir, "state");
  const at = { t: Date.parse("2026-09-29T10:00:00Z") };
  const clock = () => new Date(at.t);
  const linkErr = (code: string) => () => {
    throw Object.assign(new Error(`${code}: link not permitted`), { code });
  };

  it("an unreadable generation still being written (fresh) blocks a claim; its errno-free reason is said", () => {
    mkdirSync(join(home(), DRIVER_DIR), { recursive: true });
    writeFileSync(join(home(), DRIVER_DIR, "1.json"), "");
    const l = fileLease(home(), { clock, holder: "a" });
    expect(l.claim(null)).toBe(false);
    expect(l.lastError).toMatch(/generation 1 is unreadable/);
  });

  it("where hard links are refused it creates the generation exclusively instead", () => {
    for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
      rmSync(home(), { recursive: true, force: true });
      const l = fileLease(home(), { clock, holder: "a", link: linkErr(code) });
      expect(l.claim("run-1")).toBe(true);
      expect(JSON.parse(readFileSync(join(home(), DRIVER_DIR, "1.json"), "utf8"))).toMatchObject({
        holder: "a",
        run: "run-1",
      });
      // The exclusive create still refuses a generation that exists: another
      // claimer creates generation 2 between B's read and its create.
      at.t += LEASE_TTL_MS + 1;
      const b = fileLease(home(), {
        clock,
        holder: "b",
        link: linkErr(code),
        beforeCreate: () =>
          writeFileSync(
            join(home(), DRIVER_DIR, "2.json"),
            JSON.stringify({
              holder: "c",
              run: null,
              pid: 1,
              host: "h",
              at: clock().toISOString(),
            }),
          ),
      });
      expect(b.claim(null)).toBe(false);
      expect(b.lastError).toMatch(/EEXIST/);
    }
  });

  it("any other failure is a failed claim that names its errno", () => {
    const l = fileLease(home(), { clock, holder: "a", link: linkErr("EACCES") });
    expect(l.claim(null)).toBe(false);
    expect(l.lastError).toMatch(/EACCES/);
    expect(readdirSync(join(home(), DRIVER_DIR)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("a claim that finds a newer generation right after its own create has lost", () => {
    const l = fileLease(home(), {
      clock,
      holder: "a",
      afterCreate: (gen) =>
        writeFileSync(
          join(home(), DRIVER_DIR, `${gen + 1}.json`),
          JSON.stringify({ holder: "b", run: null, pid: 1, host: "h", at: clock().toISOString() }),
        ),
    });
    expect(l.claim(null)).toBe(false);
    expect(l.other()).toMatchObject({ holder: "b" });
  });

  it("a claim keeps the generation before it and prunes older ones and stale temp files", () => {
    const d = join(home(), DRIVER_DIR);
    const l = fileLease(home(), { clock, holder: "a" });
    expect(l.claim(null)).toBe(true);
    l.release();
    expect(l.claim(null)).toBe(true);
    l.release();
    mkdirSync(d, { recursive: true });
    for (const n of [".claim.old.tmp", ".2.old.tmp"]) {
      writeFileSync(join(d, n), "x");
      utimesSync(join(d, n), OLD, OLD);
    }
    writeFileSync(join(d, ".claim.fresh.tmp"), "x");
    expect(l.claim(null)).toBe(true);
    expect(readdirSync(d).sort()).toEqual([".claim.fresh.tmp", "2.json", "3.json"]);
    expect(existsSync(join(d, "1.json"))).toBe(false);
  });
});

describe("the request watcher", () => {
  it("answers only stops when told stage2: false", async () => {
    vi.useFakeTimers();
    try {
      const consumeStage2Request = vi.fn(async () => null);
      const consumeStopRequest = vi.fn(() => null);
      const stop = watchTuiRequests(
        { consumeStage2Request, consumeStopRequest } as unknown as ScanRunner,
        1000,
        { stage2: false },
      );
      await vi.advanceTimersByTimeAsync(3000);
      expect(consumeStopRequest).toHaveBeenCalledTimes(3);
      expect(consumeStage2Request).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
