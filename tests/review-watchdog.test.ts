// The external watchdog. A synchronous loop freezes the event loop, so the
// in-process budget's timers and the driver's signal handlers never run; the
// watchdog (src/reviewdetach.ts runWatchdog) reads the driver's heartbeat from
// outside and kills the group once deadline + grace has passed with a stale beat.
import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchDetached,
  runWatchdog,
  WATCHDOG_EXIT_CODE,
  type WatchdogDeps,
  watchdogCommand,
} from "../src/reviewdetach.js";
import { HEARTBEAT_FILE, readBeat, type Beat } from "@quickchatai/pi-quickreview/src/heartbeat.js";
import { sdkStubArgs, writeSdkDriverStub } from "./helpers/sdk-driver-stub.js";
import { waitFor } from "./helpers/wait-for.js";

const tmp = mkdtempSync(join(tmpdir(), "review-watchdog-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A run dir inside a registry home, with the lock the run holds. */
function runDir(): { home: string; dir: string; lock: string } {
  const home = join(tmp, `home${n++}`);
  const dir = join(home, "runs", "run1");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, "locks"), { recursive: true });
  return { home, dir, lock: "" };
}

const writeBeat = (dir: string, b: Partial<Beat>): void =>
  writeFileSync(
    join(dir, HEARTBEAT_FILE),
    JSON.stringify({ seq: 1, at: 0, pid: 1, deadline_at: null, pgids: [], ...b }),
  );

/** A fake clock: sleeping advances it. */
function fake(over: Partial<WatchdogDeps> = {}): {
  deps: WatchdogDeps;
  clock: { t: number };
  killed: Array<{ pgid: number; sig: string }>;
  alive: Set<number>;
} {
  const clock = { t: 1_000_000 };
  const killed: Array<{ pgid: number; sig: string }> = [];
  const alive = new Set<number>([77]);
  return {
    clock,
    killed,
    alive,
    deps: {
      now: () => clock.t,
      sleep: async (ms) => {
        clock.t += ms;
      },
      alive: (p) => alive.has(p),
      kill: (pgid, sig) => {
        killed.push({ pgid, sig });
        alive.delete(pgid);
      },
      pollMs: 1_000,
      graceMs: 30_000,
      staleMs: 10_000,
      ...over,
    },
  };
}

describe("runWatchdog", () => {
  it("kills the driver's group and the beat's pi groups once the deadline plus grace has passed with a stale beat", async () => {
    const { dir } = runDir();
    const f = fake();
    const deadline = f.clock.t + 60_000;
    writeBeat(dir, { at: f.clock.t, deadline_at: deadline, pgids: [501, 502] });
    const r = await runWatchdog({ dir, key: "k", pid: 77 }, f.deps);
    expect(r).toBe("killed");
    expect(f.clock.t).toBeGreaterThan(deadline + 30_000);
    expect(f.clock.t).toBeLessThanOrEqual(deadline + 30_000 + 1_000);
    expect(f.killed).toEqual([
      { pgid: 501, sig: "SIGKILL" },
      { pgid: 502, sig: "SIGKILL" },
      { pgid: 77, sig: "SIGKILL" },
    ]);
    // the end carries its time: a host shows how long the run took
    expect(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8"))).toEqual({
      code: WATCHDOG_EXIT_CODE,
      at: f.clock.t,
    });
    const out = JSON.parse(readFileSync(join(dir, "output.jsonl"), "utf8").trim());
    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/watchdog/);
  });

  it("leaves a driver that is past its deadline but still beating to its own budget", async () => {
    const { dir } = runDir();
    const f = fake();
    writeBeat(dir, { at: f.clock.t, deadline_at: f.clock.t + 1_000 });
    let polls = 0;
    const deps: WatchdogDeps = {
      ...f.deps,
      sleep: async (ms) => {
        f.clock.t += ms;
        // the driver beats on every poll, and ends on its own after a while
        writeBeat(dir, { at: f.clock.t, deadline_at: f.clock.t - 99_000 });
        if (++polls === 200) f.alive.delete(77);
      },
    };
    expect(await runWatchdog({ dir, key: "k", pid: 77 }, deps)).toBe("ended");
    expect(f.killed).toEqual([]);
  });

  it("does not act while no turn has a deadline, or before a beat exists", async () => {
    const { dir } = runDir();
    const f = fake();
    let polls = 0;
    const deps: WatchdogDeps = {
      ...f.deps,
      sleep: async (ms) => {
        f.clock.t += ms;
        if (++polls === 5) writeBeat(dir, { at: 0, deadline_at: null });
        if (polls === 100) f.alive.delete(77);
      },
    };
    expect(await runWatchdog({ dir, key: "k", pid: 77 }, deps)).toBe("ended");
    expect(f.killed).toEqual([]);
  });

  it("returns when the run records its end or is stopped, without killing", async () => {
    for (const name of ["exit.json", "stopped.json"]) {
      const { dir } = runDir();
      const f = fake();
      writeBeat(dir, { at: 0, deadline_at: 1 });
      writeFileSync(join(dir, name), "{}");
      expect(await runWatchdog({ dir, key: "k", pid: 77 }, f.deps)).toBe("ended");
      expect(f.killed).toEqual([]);
    }
  });

  it("frees the target the run held", async () => {
    const { home, dir } = runDir();
    const f = fake();
    const { createHash } = await import("node:crypto");
    const lock = join(
      home,
      "locks",
      `${createHash("sha256").update("the-key").digest("hex").slice(0, 20)}.json`,
    );
    writeFileSync(lock, "{}");
    writeBeat(dir, { at: f.clock.t, deadline_at: f.clock.t });
    expect(await runWatchdog({ dir, key: "the-key", pid: 77 }, f.deps)).toBe("killed");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("watchdogCommand", () => {
  it("names the run directory, key and pid after --watchdog", () => {
    const c = watchdogCommand(
      { dir: "/d", key: "k", pid: 9 },
      { entry: "/e/cli.js", execPath: "/n/node", execArgv: ["--x"] },
    );
    expect(c).toEqual({
      command: "/n/node",
      args: ["--x", "/e/cli.js", "review", "--watchdog", "/d", "k", "9"],
    });
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a driver stuck in a synchronous busy loop", () => {
  it("is killed by the watchdog within deadline + grace, with the pi group its beat names", async () => {
    const { dir } = runDir();
    // A stand-in pi child in its own group, which the driver's own kill would miss.
    const pi = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    pi.unref();
    const DEADLINE_MS = 800;
    const GRACE_MS = 400;
    // The stub writes the beat format of packages/pi-plugin/src/heartbeat.ts by hand (it cannot
    // import TypeScript), beats five times, then spins forever in a sync loop.
    const stub = join(dir, "stub.mjs");
    writeFileSync(
      stub,
      `import { renameSync, writeFileSync } from "node:fs";
const [, , file, deadlineAt, pgid] = process.argv;
let seq = 0;
const beat = () => {
  writeFileSync(file + ".tmp", JSON.stringify({ seq: ++seq, at: Date.now(), pid: process.pid, deadline_at: Number(deadlineAt), pgids: [Number(pgid)] }));
  renameSync(file + ".tmp", file);
};
beat();
const t = setInterval(() => { beat(); if (seq >= 5) { clearInterval(t); for (;;) {} } }, 50);
`,
    );
    const t0 = Date.now();
    const launched = launchDetached({
      command: process.execPath,
      args: [stub, join(dir, HEARTBEAT_FILE), String(t0 + DEADLINE_MS), String(pi.pid)],
      dir,
      env: process.env,
    });
    expect(launched.ok).toBe(true);
    const pid = (launched as { pid: number }).pid;
    try {
      // wait for the stub to freeze: its fifth beat is its last, the loop spins right after it
      await waitFor(
        () => (readBeat(join(dir, HEARTBEAT_FILE)) as { seq?: number } | null)?.seq === 5,
        "the stub's last beat",
      );
      const r = await runWatchdog(
        { dir, key: "k", pid },
        {
          now: Date.now,
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
          alive,
          kill: (pgid, sig) => process.kill(-pgid, sig),
          pollMs: 50,
          graceMs: GRACE_MS,
          staleMs: 300,
        },
      );
      const took = Date.now() - t0;
      expect(r).toBe("killed");
      // not before deadline + grace; and promptly after, with slack for load
      expect(took).toBeGreaterThanOrEqual(DEADLINE_MS + GRACE_MS);
      expect(took).toBeLessThan(DEADLINE_MS + GRACE_MS + 5_000);
      await waitFor(() => !alive(pid) && !alive(pi.pid!), "the killed processes to be gone");
      expect(alive(pid)).toBe(false);
      expect(alive(pi.pid!)).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")).code).toBe(
        WATCHDOG_EXIT_CODE,
      );
    } finally {
      for (const p of [pid, pi.pid!]) {
        try {
          process.kill(-p, "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  });
});

describe("an SDK driver stuck in a synchronous loop mid-turn", () => {
  it("is killed by the watchdog within deadline + grace: the turn's deadline reached the beat before the loop froze", async () => {
    const { dir } = runDir();
    const DEADLINE_MS = 1_500;
    const GRACE_MS = 500;
    const stub = writeSdkDriverStub(dir);
    const t0 = Date.now();
    const launched = launchDetached({
      command: process.execPath,
      args: [stub, ...sdkStubArgs({ dir, key: "k" }, "freeze", process.cwd(), DEADLINE_MS)],
      dir,
      env: process.env,
    });
    expect(launched.ok).toBe(true);
    const pid = (launched as { pid: number }).pid;
    try {
      // The beat names the turn's deadline once the session's turn has begun,
      // and then stops advancing: the loop is frozen, and with it every timer.
      let beat = readBeat(join(dir, HEARTBEAT_FILE));
      for (let i = 0; i < 200 && beat?.deadline_at == null; i++) {
        await new Promise((r) => setTimeout(r, 50));
        beat = readBeat(join(dir, HEARTBEAT_FILE));
      }
      expect(beat?.deadline_at).not.toBeNull();
      const r = await runWatchdog(
        { dir, key: "k", pid },
        {
          now: Date.now,
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
          alive,
          kill: (pgid, sig) => process.kill(-pgid, sig),
          pollMs: 50,
          graceMs: GRACE_MS,
          staleMs: 300,
        },
      );
      expect(r).toBe("killed");
      expect(Date.now() - beat!.deadline_at!).toBeGreaterThanOrEqual(GRACE_MS);
      expect(Date.now() - t0).toBeLessThan(DEADLINE_MS + GRACE_MS + 10_000);
      await new Promise((res) => setTimeout(res, 200));
      expect(alive(pid)).toBe(false);
      expect(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")).code).toBe(
        WATCHDOG_EXIT_CODE,
      );
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }, 30_000);
});
