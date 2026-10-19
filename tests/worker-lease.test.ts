// [P8.5] The worker lease: what a lease may and may not be trusted to kill.
// A fake /proc stands in for the machine, so "another container" and "the pid was
// reused" are cases, not hopes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LeaseHeld,
  WorkerLeases,
  judgeLease,
  killLease,
  parseStat,
  realProc,
  type ProcView,
  type WorkerLease,
} from "../src/workerlease.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wl-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BOOT = "boot-1/box-a";

const lease = (over: Partial<WorkerLease> = {}): WorkerLease => ({
  v: 1,
  owner_token: "tok",
  command_id: "c1",
  session: "pr-7",
  pr: 7,
  generation: 1,
  pid: 500,
  pgid: 500,
  start_time: "1000",
  boot_id: BOOT,
  command: "botworker --command c1 --mode round",
  created_at: "2026-10-19T00:00:00.000Z",
  ...over,
});

/** A machine of `procs` (pid -> start, pgid), answering for `boot`. */
function machine(
  procs: Record<number, { start: string; pgid: number }>,
  boot = BOOT,
): ProcView & { gone(pid: number): void } {
  const table = new Map(Object.entries(procs).map(([pid, p]) => [Number(pid), p]));
  return {
    identity: (pid) => table.get(pid),
    members: (pgid) =>
      [...table].filter(([, p]) => p.pgid === pgid).map(([pid, p]) => ({ pid, start: p.start })),
    bootId: () => boot,
    gone: (pid) => void table.delete(pid),
  };
}

describe("[P8.5] parseStat", () => {
  it("reads the start time and group past a command name with spaces and parens", () => {
    const raw = "812 (node (worker) x) S 1 812 812 0 -1 4194560 100 0 0 0 5 1 0 0 20 0 11 0 987654 1 2";
    expect(parseStat(raw)).toEqual({ state: "S", pgid: 812, start: "987654" });
  });

  it("reads the real /proc of this process", () => {
    const me = realProc.identity(process.pid)!;
    expect(me.start).toMatch(/^\d+$/);
    expect(me.pgid).toBeGreaterThan(0);
    expect(realProc.bootId()).toMatch(/\/./);
  });

  it("is undefined for a line that is not a stat", () => {
    expect(parseStat("nonsense")).toBeUndefined();
    expect(parseStat("1 (x) S 1")).toBeUndefined();
  });
});

describe("[P8.5] judgeLease: a signal is sent only to what the lease really names", () => {
  it("names the group when the leader has the recorded start time, group and boot", () => {
    const m = machine({ 500: { start: "1000", pgid: 500 } });
    expect(judgeLease(lease(), m)).toEqual({ kind: "group", pgid: 500 });
  });

  it("names nothing when the pid now has another start time (the pid was reused)", () => {
    const m = machine({ 500: { start: "2000", pgid: 500 } });
    expect(judgeLease(lease(), m).kind).toBe("foreign");
  });

  it("names nothing when the lease was written in another boot or container", () => {
    const m = machine({ 500: { start: "1000", pgid: 500 } }, "boot-1/box-b");
    expect(judgeLease(lease(), m)).toMatchObject({ kind: "foreign" });
    const rebooted = machine({ 500: { start: "1000", pgid: 500 } }, "boot-2/box-a");
    expect(judgeLease(lease(), rebooted).kind).toBe("foreign");
  });

  it("names nothing when the pid is no longer the leader of the recorded group", () => {
    const m = machine({ 500: { start: "1000", pgid: 3 } });
    expect(judgeLease(lease(), m).kind).toBe("foreign");
  });

  it("is dead with the leader gone and nobody in the group", () => {
    expect(judgeLease(lease(), machine({})).kind).toBe("dead");
  });

  it("names the tool children a dead leader left, and not an older process in a reused group number", () => {
    const m = machine({
      501: { start: "1100", pgid: 500 }, // started after the leader: its child
      502: { start: "900", pgid: 500 }, // older than the leader: not its child
    });
    expect(judgeLease(lease(), m)).toEqual({ kind: "members", pids: [501] });
  });

  it("is unstarted while the lease has no process", () => {
    expect(judgeLease(lease({ pid: null, pgid: null, start_time: null }), machine({})).kind).toBe(
      "unstarted",
    );
  });
});

describe("[P8.5] killLease", () => {
  it("sends TERM, waits, and sends KILL to a group that ignores it", async () => {
    const m = machine({ 500: { start: "1000", pgid: 500 } });
    const sent: Array<[number, string]> = [];
    let clock = 0;
    const out = await killLease(lease(), {
      proc: m,
      graceMs: 100,
      pollMs: 30,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      signal: (t, s) => {
        sent.push([t, s]);
        if (s === "SIGKILL") m.gone(500);
        return "sent";
      },
    });
    expect(sent).toEqual([
      [-500, "SIGTERM"],
      [-500, "SIGKILL"],
    ]);
    expect(out).toMatchObject({ verdict: "group", killed: true, survivors: false });
  });

  it("leaves a group that obeys the TERM alone after it", async () => {
    const m = machine({ 500: { start: "1000", pgid: 500 } });
    const sent: string[] = [];
    const out = await killLease(lease(), {
      proc: m,
      graceMs: 100,
      pollMs: 10,
      sleep: async () => {},
      signal: (_t, s) => {
        sent.push(s);
        m.gone(500);
        return "sent";
      },
    });
    expect(sent).toEqual(["SIGTERM"]);
    expect(out.killed).toBe(false);
  });

  it("does not shoot a pid that was reused during the grace", async () => {
    const m = machine({ 500: { start: "1000", pgid: 500 } });
    const sent: string[] = [];
    let clock = 0;
    const out = await killLease(lease(), {
      proc: m,
      graceMs: 100,
      pollMs: 60,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        // The worker died and a stranger took its pid inside the grace.
        m.gone(500);
        (m as unknown as { identity: ProcView["identity"] }).identity = (pid) =>
          pid === 500 ? { start: "5000", pgid: 500 } : undefined;
      },
      signal: (_t, s) => {
        sent.push(s);
        return "sent";
      },
    });
    expect(sent).toEqual(["SIGTERM"]);
    expect(out).toMatchObject({ killed: false, survivors: false });
  });

  it("sends nothing for a foreign, dead or unstarted lease", async () => {
    for (const [l, m] of [
      [lease(), machine({ 500: { start: "9", pgid: 500 } })],
      [lease(), machine({})],
      [lease({ pid: null, pgid: null, start_time: null }), machine({})],
    ] as const) {
      const sent: string[] = [];
      await killLease(l, {
        proc: m,
        graceMs: 10,
        signal: (_t, s) => (sent.push(s), "sent"),
      });
      expect(sent).toEqual([]);
    }
  });

  it("reports a refused signal (a tool-uid process) and the survivors", async () => {
    const m = machine({ 500: { start: "1000", pgid: 500 } });
    const out = await killLease(lease(), {
      proc: m,
      graceMs: 0,
      pollMs: 1,
      sleep: async () => {},
      signal: () => "denied",
    });
    expect(out).toMatchObject({ denied: [500], survivors: true, killed: true });
  });
});

describe("[P8.5] the lease file", () => {
  it("is created whole, once, 0600, and a second create is refused", () => {
    const leases = new WorkerLeases(join(dir, "workers"));
    leases.create(lease());
    expect(() => leases.create(lease({ owner_token: "other" }))).toThrow(LeaseHeld);
    expect(leases.read("pr-7")).toEqual(lease());
    expect(leases.list().map((e) => e.session)).toEqual(["pr-7"]);
  });

  it("is updated and removed only by the token that owns it", () => {
    const leases = new WorkerLeases(join(dir, "workers"));
    leases.create(lease({ pid: null, pgid: null, start_time: null }));
    expect(leases.update("pr-7", "stale-token", { pid: 1 })).toBe(false);
    expect(leases.update("pr-7", "tok", { pid: 500, pgid: 500, start_time: "1000" })).toBe(true);
    expect(leases.read("pr-7")).toMatchObject({ pid: 500, owner_token: "tok" });
    expect(leases.remove("pr-7", "stale-token")).toBe(false);
    expect(leases.read("pr-7")).toBeDefined();
    expect(leases.remove("pr-7", "tok")).toBe(true);
    expect(leases.read("pr-7")).toBeUndefined();
    expect(leases.update("pr-7", "tok", { pid: 2 })).toBe(false);
  });

  it("reads a damaged file as null, so the boot can clear it", () => {
    const leases = new WorkerLeases(join(dir, "workers"));
    writeFileSync(join(dir, "workers", "pr-8.lease.json"), "{not json");
    writeFileSync(join(dir, "workers", "pr-9.lease.json"), JSON.stringify({ ...lease(), v: 2 }));
    expect(leases.read("pr-8")).toBeNull();
    expect(leases.read("pr-9")).toBeNull();
    expect(leases.list().map((e) => [e.session, e.lease])).toEqual([
      ["pr-8", null],
      ["pr-9", null],
    ]);
  });

  it("holds no capability: the file names what was started and nothing secret", () => {
    const leases = new WorkerLeases(join(dir, "workers"));
    leases.create(lease());
    const text = readFileSync(join(dir, "workers", "pr-7.lease.json"), "utf8");
    expect(Object.keys(JSON.parse(text))).not.toContain("capability");
    expect(Object.keys(JSON.parse(text))).toEqual(
      expect.arrayContaining([
        "owner_token",
        "pid",
        "pgid",
        "start_time",
        "boot_id",
        "generation",
        "command",
      ]),
    );
  });

  it("refuses a session name that is a path", () => {
    const leases = new WorkerLeases(join(dir, "workers"));
    expect(() => leases.read("../etc")).toThrow(/not a session name/);
  });
});
