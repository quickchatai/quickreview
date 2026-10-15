// A command file's writer racing the watcher's read: the plain
// open(O_TRUNC) → write a session's write tool performs lands its write
// between the watcher's fstat of the descriptor and its read. The bytes read
// are the whole command; the version the fstat saw is the empty file's. The
// watcher must neither record that stale version (the operator ledger) nor
// take it for a replacement and run the command again (a session dir).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandWatcher, type CommandDeps, type OperatorSeal } from "../src/commands.js";
import { StateStore } from "../src/state.js";

/** The path whose next descriptor read gets the writer's bytes first. */
const race = vi.hoisted(() => ({ path: null as string | null, bytes: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((target: unknown, ...rest: unknown[]) => {
    if (typeof target === "number" && race.path !== null) {
      // The writer's write lands now — after the fstat, before the read.
      const path = race.path;
      race.path = null;
      real.writeFileSync(path, race.bytes);
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(target, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

let root: string;
let store: StateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-cmd-race-"));
  mkdirSync(join(root, "commands"), { recursive: true });
  store = new StateStore(":memory:");
});
afterEach(() => {
  race.path = null;
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** Until the watcher's own work queue is empty — every command it queued has
 * run — rather than a count of ticks. */
async function drained(w: CommandWatcher): Promise<void> {
  const q = () => (w as unknown as { queue: Promise<void> }).queue;
  for (let p = q(); ; p = q()) {
    await p;
    if (p === q()) return;
  }
}

describe("a write that lands between the watcher's fstat and its read", () => {
  it("session dir: the command runs once and is archived — never mistaken for a replacement", async () => {
    const dir = join(root, "commands");
    const file = join(dir, "r1.json");
    writeFileSync(file, ""); // the writer's O_TRUNC create, before its write
    const rerunRound = vi.fn(async () => ({ ok: true, redispatched: true }));
    const w = new CommandWatcher({
      dir,
      deps: { rerunRound } as unknown as CommandDeps,
      store,
      parseAttempts: 3,
      parseRetryMs: 1,
    });
    race.path = file;
    race.bytes = JSON.stringify({ command: "rerun-round", pr: 7 });
    await w.sweep();
    await drained(w);
    w.stop();
    // MUTATION: in finish, decide "replaced" by the version taken before the
    // read rather than by the bytes — the command is re-queued and runs twice.
    expect(rerunRound).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dir, "processed", "r1.json"), "utf8"))).toEqual({
      command: "rerun-round",
      pr: 7,
    });
  });

  it("operator dir: the ledger records the version that ran, so the next sweep does not run it again", async () => {
    const dir = join(root, "commands", "operator");
    mkdirSync(dir);
    const file = join(dir, "o1.json");
    writeFileSync(file, "");
    const issuers: string[] = [];
    const deps = {
      drain: (_on: boolean, issuer: string) => {
        issuers.push(issuer);
        return { ok: true, draining: true, issuer, running_rounds: 0 };
      },
    } as unknown as CommandDeps;
    const sealed: OperatorSeal = {
      euid: 1001,
      gids: [1001],
      stat: (p) =>
        p.endsWith(".json")
          ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
          : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
    };
    const w = new CommandWatcher({
      dir,
      operator: sealed,
      deps,
      store,
      sweepIntervalMs: 0,
      parseAttempts: 3,
      parseRetryMs: 1,
    });
    race.path = file;
    race.bytes = JSON.stringify({ command: "drain", on: true });
    await w.sweep();
    expect(issuers).toEqual(["operator"]);
    // MUTATION: ledger the pre-read version — this sweep runs it again.
    await w.sweep();
    w.stop();
    expect(issuers).toEqual(["operator"]);
  });
});
