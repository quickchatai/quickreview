// The checklist lock (src/onboard/checklistlock.ts): one writer of the setup
// checklist at a time, between the home's switches and a host's verbs. It
// never waits; a holder whose process is gone is taken over, and so is one
// left by another boot of the machine or by another process under the same
// pid; and a verb hands it to the detached walk it starts, with no moment in
// between when it names a dead process.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireChecklistLock,
  adoptChecklistLock,
  checklistLockHolder,
  checklistLockPath,
  lockHolderWords,
  LOCK_HOLDERS,
  machineBootId,
  processStartTime,
  withChecklistLock,
  type LockOptions,
  type LockRecord,
} from "../src/onboard/checklistlock.js";

let stateDir: string;
let alive: Set<number>;

beforeEach(() => {
  stateDir = join(mkdtempSync(join(tmpdir(), "qcr-lock-")), "state");
  alive = new Set([10, 20, 30]);
});
afterEach(() => rmSync(join(stateDir, ".."), { recursive: true, force: true }));

const as = (pid: number) => ({ pid, alive: (p: number) => alive.has(p) });
const onDisk = (): LockRecord =>
  JSON.parse(readFileSync(checklistLockPath(stateDir), "utf8")) as LockRecord;

describe("taking the lock", () => {
  // MUTATION: return { ok: true } from acquireChecklistLock when the file
  // exists and its process lives — this fails.
  it("one holder at a time: a second taker is told who holds it, and waits for nothing", () => {
    const first = acquireChecklistLock(stateDir, "setup", as(10));
    expect(first.ok).toBe(true);
    expect(onDisk()).toMatchObject({ holder: "setup", pid: 10 });
    const second = acquireChecklistLock(stateDir, "home", as(20));
    expect(second).toMatchObject({ ok: false, held: { holder: "setup", pid: 10 } });
    // the same process asking again is not let in either
    expect(acquireChecklistLock(stateDir, "proof", as(10)).ok).toBe(false);
    expect(checklistLockHolder(stateDir, { alive: (p) => alive.has(p) })?.holder).toBe("setup");
  });

  it("is free again once released", () => {
    const first = acquireChecklistLock(stateDir, "setup", as(10));
    if (!first.ok) throw new Error("not taken");
    first.lock.release();
    expect(existsSync(checklistLockPath(stateDir))).toBe(false);
    expect(acquireChecklistLock(stateDir, "home", as(20)).ok).toBe(true);
  });

  // MUTATION: drop the liveness check (treat every record as held) — this fails.
  it("a lock whose process is gone is taken over", () => {
    expect(acquireChecklistLock(stateDir, "setup", as(10)).ok).toBe(true);
    alive.delete(10);
    expect(checklistLockHolder(stateDir, { alive: (p) => alive.has(p) })).toBeNull();
    const next = acquireChecklistLock(stateDir, "go_live", as(20));
    expect(next.ok).toBe(true);
    expect(onDisk()).toMatchObject({ holder: "go_live", pid: 20 });
  });

  // MUTATION: unlink the file in release() without reading whose it is — this fails.
  it("a release never removes a lock someone else took over", () => {
    const first = acquireChecklistLock(stateDir, "setup", as(10));
    if (!first.ok) throw new Error("not taken");
    alive.delete(10);
    expect(acquireChecklistLock(stateDir, "home", as(20)).ok).toBe(true);
    first.lock.release();
    expect(onDisk()).toMatchObject({ holder: "home", pid: 20 });
  });

  it("a lock file being written is held; one left unreadable is stale", () => {
    const path = checklistLockPath(stateDir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "{");
    expect(acquireChecklistLock(stateDir, "home", as(20)).ok).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(acquireChecklistLock(stateDir, "home", as(20)).ok).toBe(true);
    expect(onDisk()).toMatchObject({ holder: "home", pid: 20 });
  });

  it("where no lock file can be created nothing is excluded, and that is said", () => {
    const file = join(stateDir, "..", "a-file");
    writeFileSync(file, "");
    const got = acquireChecklistLock(join(file, "state"), "home", as(10));
    expect(got).toMatchObject({ ok: true, lock: { exclusive: false } });
    if (got.ok) got.lock.release();
  });
});

describe("a lock left by a machine that stopped, or by a process that is gone", () => {
  // The machine, as a test moves it: its boot, and when each process started.
  let boot: string | null;
  let started: Map<number, string>;
  beforeEach(() => {
    boot = "boot-1";
    started = new Map([
      [10, "1000"],
      [20, "2000"],
      [30, "3000"],
    ]);
  });
  const on = (pid: number): LockOptions => ({
    ...as(pid),
    bootId: () => boot,
    startTime: (p) => started.get(p) ?? null,
  });
  /** What a reader of the lock is told of the machine. */
  const facts = () => ({
    alive: (p: number) => alive.has(p),
    bootId: () => boot,
    startTime: (p: number) => started.get(p) ?? null,
  });

  it("the record carries the machine's boot id and the holder's start time", () => {
    expect(acquireChecklistLock(stateDir, "setup", on(10)).ok).toBe(true);
    expect(onDisk()).toMatchObject({
      holder: "setup",
      pid: 10,
      boot_id: "boot-1",
      start_time: "1000",
    });
  });

  // MUTATION: judge a holder by its pid alone (drop the boot id comparison in
  // heldByLiving) — after a restart the lock is held for ever by whatever
  // process got the pid, and this fails.
  it("a record naming a live pid with another boot id is taken over", () => {
    expect(acquireChecklistLock(stateDir, "setup", on(10)).ok).toBe(true);
    // the machine restarts; pid 10 is some other process now, and it lives
    boot = "boot-2";
    expect(alive.has(10)).toBe(true);
    expect(checklistLockHolder(stateDir, facts())).toBeNull();
    const next = acquireChecklistLock(stateDir, "go_live", on(20));
    expect(next.ok).toBe(true);
    expect(onDisk()).toMatchObject({ holder: "go_live", pid: 20, boot_id: "boot-2" });
  });

  // MUTATION: drop the start-time comparison in heldByLiving — a pid reused
  // within one boot holds the lock, and this fails.
  it("a record whose pid is another process's now, in the same boot, is taken over", () => {
    expect(acquireChecklistLock(stateDir, "setup", on(10)).ok).toBe(true);
    started.set(10, "9999");
    expect(checklistLockHolder(stateDir, facts())).toBeNull();
    expect(acquireChecklistLock(stateDir, "home", on(20)).ok).toBe(true);
    expect(onDisk()).toMatchObject({ holder: "home", pid: 20, start_time: "2000" });
  });

  it("the same process in the same boot holds it", () => {
    expect(acquireChecklistLock(stateDir, "setup", on(10)).ok).toBe(true);
    expect(checklistLockHolder(stateDir, facts())?.holder).toBe("setup");
    expect(acquireChecklistLock(stateDir, "home", on(20))).toMatchObject({
      ok: false,
      held: { holder: "setup", pid: 10 },
    });
  });

  // Where /proc cannot be read the pid alone decides, as it always did.
  // MUTATION: treat an unreadable boot id or start time as a difference —
  // every lock on such a machine is stale at once, and this fails.
  it("where the machine cannot say, the pid alone decides", () => {
    // taken where both could be read, read where neither can
    expect(acquireChecklistLock(stateDir, "setup", on(10)).ok).toBe(true);
    boot = null;
    started.clear();
    expect(acquireChecklistLock(stateDir, "home", on(20)).ok).toBe(false);
    alive.delete(10);
    // taken where neither could be read: the record carries neither
    expect(acquireChecklistLock(stateDir, "home", on(20)).ok).toBe(true);
    expect(onDisk()).not.toHaveProperty("boot_id");
    expect(onDisk()).not.toHaveProperty("start_time");
    // and read where both can: there is nothing to compare, so the pid decides
    boot = "boot-7";
    started.set(20, "2000");
    expect(acquireChecklistLock(stateDir, "setup", on(30)).ok).toBe(false);
  });

  it("a caller that hands only its own `alive` gets no boot id and no start time", () => {
    expect(acquireChecklistLock(stateDir, "setup", as(10)).ok).toBe(true);
    expect(onDisk()).not.toHaveProperty("boot_id");
    expect(onDisk()).not.toHaveProperty("start_time");
  });

  // MUTATION: keep the verb's start time in the record handTo writes — the
  // walk's own start time differs, the walk's lock reads as stale, and this fails.
  it("a hand-over records the walk's own start time, and the walk adopts it in this boot only", () => {
    const verb = acquireChecklistLock(stateDir, "setup", on(10));
    if (!verb.ok) throw new Error("not taken");
    const token = verb.lock.record.token;
    expect(verb.lock.handTo(20)).toBe(true);
    expect(onDisk()).toMatchObject({ pid: 20, token, boot_id: "boot-1", start_time: "2000" });
    expect(checklistLockHolder(stateDir, facts())?.pid).toBe(20);
    const walker = {
      pid: 20,
      bootId: () => boot,
      startTime: (p: number) => started.get(p) ?? null,
    };
    expect(adoptChecklistLock(stateDir, token, walker)).not.toBeNull();
    // after a restart the record is nobody's: not adopted, and taken over
    boot = "boot-2";
    expect(adoptChecklistLock(stateDir, token, walker)).toBeNull();
    expect(acquireChecklistLock(stateDir, "setup", on(30)).ok).toBe(true);
  });

  it("this machine's own boot id and start times are read from /proc, or are null", () => {
    const stat = (comm: string): string =>
      `4242 (${comm}) S 1 4242 4242 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 987654 1000 200 18446744073709551615`;
    const proc = (files: Record<string, string>) => (path: string) => {
      const found = files[path];
      if (found === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return found;
    };
    expect(machineBootId(proc({ "/proc/sys/kernel/random/boot_id": "0f1e-2d3c\n" }))).toBe(
      "0f1e-2d3c",
    );
    expect(machineBootId(proc({}))).toBeNull();
    expect(processStartTime(4242, proc({ "/proc/4242/stat": stat("node") }))).toBe("987654");
    // a process name may hold spaces and brackets
    expect(processStartTime(4242, proc({ "/proc/4242/stat": stat("a (b) c") }))).toBe("987654");
    expect(processStartTime(4242, proc({}))).toBeNull();
    expect(processStartTime(4242, proc({ "/proc/4242/stat": "4242 (node) S 1" }))).toBeNull();
    expect(processStartTime(0, proc({}))).toBeNull();
    // with nothing injected a lock is taken as this process, on this machine
    const own = acquireChecklistLock(stateDir, "home");
    expect(own.ok).toBe(true);
    expect(onDisk().pid).toBe(process.pid);
    expect(checklistLockHolder(stateDir)?.holder).toBe("home");
    if (own.ok) own.lock.release();
  });
});

describe("handing the lock to a detached walk", () => {
  // MUTATION: make handTo release the lock and let the walk take a new one —
  // between the two the lock is free, and the second assertion fails.
  it("the record names the walk from the moment it is handed over, and the verb's release leaves it", () => {
    const verb = acquireChecklistLock(stateDir, "setup", as(10));
    if (!verb.ok) throw new Error("not taken");
    const token = verb.lock.record.token;
    expect(verb.lock.handTo(20)).toBe(true);
    expect(onDisk()).toMatchObject({ holder: "setup", pid: 20, token });
    verb.lock.release();
    expect(onDisk()).toMatchObject({ pid: 20 });
    // the verb's process ending frees nothing
    alive.delete(10);
    expect(acquireChecklistLock(stateDir, "home", as(30))).toMatchObject({
      ok: false,
      held: { holder: "setup", pid: 20 },
    });
  });

  // MUTATION: adopt on the pid alone, without the token — this fails.
  it("the walk adopts it by its token and its own pid, and no one else can", () => {
    const verb = acquireChecklistLock(stateDir, "go_live", as(10));
    if (!verb.ok) throw new Error("not taken");
    const token = verb.lock.record.token;
    // not handed over yet: the walk holds nothing
    expect(adoptChecklistLock(stateDir, token, { pid: 20 })).toBeNull();
    verb.lock.handTo(20);
    expect(adoptChecklistLock(stateDir, "not-the-token", { pid: 20 })).toBeNull();
    expect(adoptChecklistLock(stateDir, "", { pid: 20 })).toBeNull();
    expect(adoptChecklistLock(stateDir, token, { pid: 30 })).toBeNull();
    const walk = adoptChecklistLock(stateDir, token, { pid: 20 });
    expect(walk).not.toBeNull();
    walk!.release();
    expect(existsSync(checklistLockPath(stateDir))).toBe(false);
  });
});

describe("running under the lock", () => {
  it("runs and releases; a taken lock answers through `busy` and runs nothing", async () => {
    let ran = 0;
    const out = await withChecklistLock(
      stateDir,
      "home",
      async () => {
        ran += 1;
        expect(onDisk().holder).toBe("home");
        // a host verb arriving meanwhile is told the home holds it
        return withChecklistLock(
          stateDir,
          "setup",
          async () => "ran twice",
          (held) => `busy: ${held.holder}`,
          as(20),
        );
      },
      () => "never",
      as(10),
    );
    expect(out).toBe("busy: home");
    expect(ran).toBe(1);
    expect(existsSync(checklistLockPath(stateDir))).toBe(false);
  });

  it("releases when the work throws", async () => {
    await expect(
      withChecklistLock(
        stateDir,
        "home",
        async () => {
          throw new Error("a step threw");
        },
        () => undefined,
        as(10),
      ),
    ).rejects.toThrow(/a step threw/);
    expect(existsSync(checklistLockPath(stateDir))).toBe(false);
  });

  it("every holder has words for the person at the home", () => {
    for (const holder of LOCK_HOLDERS) expect(lockHolderWords({ holder })).toMatch(/right now$/);
    expect(lockHolderWords({ holder: "setup" })).toMatch(/your host is setting the reviewer up/);
  });
});
