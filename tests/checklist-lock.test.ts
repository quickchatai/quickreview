// The checklist lock (src/onboard/checklistlock.ts): one writer of the setup
// checklist at a time, between the home's switches and a host's verbs. It
// never waits; a holder whose process is gone is taken over; and a verb hands
// it to the detached walk it starts, with no moment in between when it names
// a dead process.
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
  withChecklistLock,
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
