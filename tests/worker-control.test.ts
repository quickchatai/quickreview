// [P8.12] The pieces of the operator's controls that need no process:
//   - the control wire shapes (src/ipc/control.ts) and their bounds;
//   - the worker's control handler (src/botcontrol.ts) over a fake session: what it
//     acks as queued, handled and refused, and when it stops taking steers;
//   - the daemon's `operatorControl` adapter (src/workercontrol.ts);
//   - status.json's per-PR `runtime` (src/workerruntime.ts, buildStatusSnapshot);
//   - the JSONL rotation behind restart-session (src/sessionjsonl.ts).
// The processes (a faux worker, a fake worker, SIGKILL) are in botworker.test.ts and
// worker-supervisor.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerControls, type WorkerControlsDeps } from "../src/botcontrol.js";
import { CONTROL_COMMANDS, CONTROL_TEXT_MAX as OPERATOR_TEXT_MAX } from "../src/commands.js";
import type { ControlCommand } from "../src/commands.js";
import type { Delivery, RuntimeSession, SessionStats } from "../src/engine/port.js";
import {
  CONTROL_KINDS,
  CONTROL_TEXT_MAX,
  parseControl,
  parseControlAck,
  type ControlAck,
} from "../src/ipc/control.js";
import { decodeMessage, IpcError } from "../src/ipc/protocol.js";
import { PR_RUNTIMES, StateStore, buildStatusSnapshot } from "../src/state.js";
import { newestSessionFile, restoreRotatedFiles, rotateSessionFiles } from "../src/sessionjsonl.js";
import { workerOperatorControl } from "../src/workercontrol.js";
import { runtimeOfPr } from "../src/workerruntime.js";
import type { ControlResult } from "../src/workersupervisor.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "qcr-worker-control-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("[P8.12] the control wire", () => {
  it("names the three controls, with the operator command's text bound", () => {
    expect([...CONTROL_KINDS]).toEqual(["steer", "follow_up", "abort"]);
    expect(CONTROL_TEXT_MAX).toBe(OPERATOR_TEXT_MAX);
  });

  it("reads a steer, a follow-up and an abort", () => {
    expect(parseControl("steer", { id: "a-1", text: "look here" })).toEqual({
      kind: "steer",
      id: "a-1",
      text: "look here",
    });
    expect(parseControl("follow_up", { id: "a-2", text: "then this" })).toMatchObject({
      kind: "follow_up",
    });
    expect(parseControl("abort", { id: "a-3", text: "ignored" })).toEqual({
      kind: "abort",
      id: "a-3",
    });
  });

  it("refuses what it cannot trust", () => {
    const bad: Array<[string, unknown]> = [
      ["unknown", { id: "a" }],
      ["steer", null],
      ["steer", []],
      ["steer", { text: "x" }],
      ["steer", { id: "has space", text: "x" }],
      ["steer", { id: "a" }],
      ["steer", { id: "a", text: "  " }],
      ["follow_up", { id: "a", text: "x".repeat(CONTROL_TEXT_MAX + 1) }],
    ];
    for (const [kind, body] of bad)
      expect(() => parseControl(kind, body), `${kind} ${JSON.stringify(body)}`).toThrow(IpcError);
  });

  it("reads an ack, and cuts a long reason", () => {
    expect(parseControlAck({ id: "a", ack: "queued" })).toEqual({ id: "a", ack: "queued" });
    expect(
      parseControlAck({ id: "a", ack: "refused", reason: "x".repeat(500) }).reason,
    ).toHaveLength(300);
    for (const body of [
      null,
      {},
      { id: "a" },
      { id: "a", ack: "maybe" },
      { id: "!", ack: "queued" },
    ])
      expect(() => parseControlAck(body)).toThrow(IpcError);
  });

  it("travels in the protocol's control message as it always has", () => {
    const line = JSON.stringify({ v: "1.0", type: "control", kind: "abort", body: { id: "a" } });
    expect(decodeMessage(line)).toMatchObject({
      type: "control",
      kind: "abort",
      body: { id: "a" },
    });
  });
});

/** A session whose deliveries a test scripts. */
class FakeSession implements Partial<RuntimeSession> {
  busy = false;
  steered: string[] = [];
  steerOptions: unknown[] = [];
  followed: string[] = [];
  /** What the next steer/followUp answers; omitted: queued while busy, else handled. */
  answer: (() => Promise<Delivery>) | undefined;
  stats(): SessionStats {
    return { turns: 0, busy: this.busy, spentUsd: 0, last: null };
  }
  private delivery(): Promise<Delivery> {
    if (this.answer) return this.answer();
    return Promise.resolve(
      this.busy
        ? { status: "queued" }
        : { status: "handled", result: { code: 0, timedOut: false, streamError: null } },
    );
  }
  steer(text: string, options?: unknown): Promise<Delivery> {
    this.steered.push(text);
    this.steerOptions.push(options);
    return this.delivery();
  }
  followUp(text: string): Promise<Delivery> {
    this.followed.push(text);
    return this.delivery();
  }
}

function controls(session: FakeSession | undefined, over: Partial<WorkerControlsDeps> = {}) {
  const acks: ControlAck[] = [];
  const logs: string[] = [];
  let aborted = 0;
  const c = new WorkerControls({
    session: () => session as unknown as RuntimeSession | undefined,
    limits: () => ({ timeoutMs: 1000 }),
    abort: async () => void aborted++,
    ack: async (a) => void acks.push(a),
    log: (l) => void logs.push(l),
    ackWaitMs: 40,
    ...over,
  });
  return { c, acks, logs, aborted: () => aborted };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

describe("[P8.12] the worker's control handler", () => {
  it("acks a steer into a busy session queued, and counts it", async () => {
    const s = new FakeSession();
    s.busy = true;
    const { c, acks } = controls(s);
    c.receive("steer", { id: "c1", text: "go left" });
    await c.flush();
    expect(s.steered).toEqual(["go left"]);
    expect(acks).toEqual([{ id: "c1", ack: "queued" }]);
    expect(c.counts).toEqual({ steer: 1, follow_up: 0, abort: 0 });
  });

  it("hands a steer the round's remaining limits, as a follow-up gets them", async () => {
    const s = new FakeSession();
    const { c } = controls(s);
    c.receive("steer", { id: "c1", text: "go left" });
    await c.flush();
    expect(s.steerOptions).toEqual([{ timeoutMs: 1000 }]);
  });

  it("acks a follow-up on an idle session handled: the host acted", async () => {
    const s = new FakeSession();
    const { c, acks } = controls(s);
    c.receive("follow_up", { id: "c1", text: "and then" });
    await c.flush();
    expect(s.followed).toEqual(["and then"]);
    expect(acks).toEqual([{ id: "c1", ack: "handled" }]);
  });

  it("acks handled when the idle session is still running the turn it started", async () => {
    const s = new FakeSession();
    let finish = (): void => {};
    s.answer = () =>
      new Promise<Delivery>((resolve) => {
        finish = () =>
          resolve({ status: "handled", result: { code: 0, timedOut: false, streamError: null } });
      });
    const { c, acks } = controls(s);
    c.receive("steer", { id: "c1", text: "now" });
    await c.flush();
    // Not blocked on the whole turn: the ack came while it ran.
    expect(acks).toEqual([{ id: "c1", ack: "handled" }]);
    // The turn is the round's: drain waits for it.
    let drained = false;
    void c.drain().then(() => (drained = true));
    await settled();
    expect(drained).toBe(false);
    finish();
    await settled();
    expect(drained).toBe(true);
  });

  it("refuses what the session cannot deliver, with its reason", async () => {
    const s = new FakeSession();
    s.answer = async () => ({ status: "unsupported", reason: "no steer here" });
    const { c, acks } = controls(s);
    c.receive("steer", { id: "c1", text: "x" });
    await c.flush();
    expect(acks).toEqual([{ id: "c1", ack: "refused", reason: "no steer here" }]);
    expect(c.counts.steer).toBe(0);
    s.answer = async () => {
      throw new Error("session disposed");
    };
    c.receive("follow_up", { id: "c2", text: "x" });
    await c.flush();
    expect(acks[1]).toEqual({ id: "c2", ack: "refused", reason: "session disposed" });
  });

  it("refuses before the session is open", async () => {
    const { c, acks } = controls(undefined);
    c.receive("steer", { id: "c1", text: "x" });
    await c.flush();
    expect(acks).toEqual([{ id: "c1", ack: "refused", reason: "the session is not open yet" }]);
  });

  it("stops taking steers and follow-ups once the round is closing, but still takes an abort", async () => {
    const s = new FakeSession();
    const { c, acks, aborted } = controls(s);
    await c.drainAndClose();
    c.receive("steer", { id: "c1", text: "late" });
    c.receive("follow_up", { id: "c2", text: "late" });
    await c.flush();
    expect(acks.map((a) => [a.ack, a.reason])).toEqual([
      ["refused", "the round is ending"],
      ["refused", "the round is ending"],
    ]);
    expect(s.steered).toEqual([]);
    c.receive("abort", { id: "c3" });
    await c.flush();
    expect(aborted()).toBe(1);
    expect(acks[2]).toEqual({ id: "c3", ack: "handled" });
  });

  it("acks an abort only after the worker has stopped", async () => {
    const s = new FakeSession();
    let stopped = false;
    let stop = (): void => {};
    const { c, acks } = controls(s, {
      abort: () => new Promise<void>((resolve) => (stop = () => ((stopped = true), resolve()))),
    });
    c.receive("abort", { id: "c1" });
    await settled();
    expect(acks).toEqual([]);
    stop();
    await c.flush();
    expect(stopped).toBe(true);
    expect(acks).toEqual([{ id: "c1", ack: "handled" }]);
  });

  it("waits for a queued turn to finish before it drains", async () => {
    const s = new FakeSession();
    s.busy = true;
    const { c } = controls(s);
    c.receive("follow_up", { id: "c1", text: "behind the run" });
    await c.flush();
    let drained = false;
    void c.drainAndClose().then(() => (drained = true));
    await settled();
    expect(drained).toBe(false);
    s.busy = false;
    await settled();
    expect(drained).toBe(true);
  });

  it("logs a control it cannot read, and acks it refused only when it carries an id", async () => {
    const { c, acks, logs } = controls(new FakeSession());
    c.receive("steer", "not an object");
    c.receive("nope", { id: "c1" });
    c.receive("steer", { id: "c2" });
    await c.flush();
    expect(logs.length).toBe(3);
    // The one with no id at all cannot be answered; the others are named back.
    expect(acks.map((a) => [a.id, a.ack])).toEqual([
      ["c1", "refused"],
      ["c2", "refused"],
    ]);
    expect(acks[1]!.reason).toMatch(/text/);
  });

  it("survives an ack that cannot be sent", async () => {
    const { c, logs } = controls(new FakeSession(), {
      ack: async () => {
        throw new Error("the connection closed");
      },
    });
    c.receive("steer", { id: "c1", text: "x" });
    await expect(c.flush()).resolves.toBeUndefined();
    expect(logs.join("\n")).toMatch(/not sent/);
  });
});

describe("[P8.12] the daemon's operatorControl adapter", () => {
  const calls: unknown[][] = [];
  const supervisor = {
    control: async (...a: unknown[]): Promise<ControlResult> => (
      calls.push(["control", ...a]),
      { ok: true, ack: "queued", command_id: "cmd-1" }
    ),
    abortRound: async (...a: unknown[]): Promise<ControlResult> => (
      calls.push(["abortRound", ...a]),
      { ok: true, ack: "handled", command_id: "cmd-1", killed: true }
    ),
  };
  const handler = workerOperatorControl({ supervisor });

  it("routes steer, follow-up and abort-round, and reports the ack in the result file", async () => {
    calls.length = 0;
    expect(await handler({ command: "steer", pr: 5, text: "a" }, "f1")).toEqual({
      ok: true,
      ack: "queued",
      command_id: "cmd-1",
    });
    await handler({ command: "follow-up", pr: 5, text: "b" }, "f2");
    expect(await handler({ command: "abort-round", pr: 5 }, "f3")).toEqual({
      ok: true,
      ack: "handled",
      command_id: "cmd-1",
      killed: true,
    });
    expect(calls).toEqual([
      ["control", 5, "steer", "a"],
      ["control", 5, "follow_up", "b"],
      ["abortRound", 5],
    ]);
  });

  it("passes a refusal through with its reason", async () => {
    const refusing = workerOperatorControl({
      supervisor: {
        ...supervisor,
        control: async () => ({ ok: false, reason: "no worker is running for #5" }),
      },
    });
    expect(await refusing({ command: "steer", pr: 5, text: "a" }, "f")).toEqual({
      ok: false,
      reason: "no worker is running for #5",
    });
  });

  it("refuses the other verbs unless a daemon serves them", async () => {
    for (const command of ["message", "takeover", "release", "debug-round"] as const) {
      const c = (
        command === "message" ? { command, pr: 5, text: "hi" } : { command, pr: 5 }
      ) as ControlCommand;
      expect(await handler(c, "f")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("not served by the worker host"),
      });
    }
    const served = workerOperatorControl({ supervisor, other: () => ({ ok: true, other: 1 }) });
    expect(await served({ command: "release", pr: 5 }, "f")).toEqual({ ok: true, other: 1 });
  });

  it("covers every control verb the schema has", () => {
    expect([...CONTROL_COMMANDS].sort()).toEqual(
      ["abort-round", "debug-round", "follow-up", "message", "release", "steer", "takeover"].sort(),
    );
  });
});

describe("[P8.12] status.json carries runtime per PR", () => {
  const workers = [
    { pr: 1, mode: "round" as const },
    { pr: 2, mode: "answer" as const },
  ];

  it("is worker, answer, debug, takeover or idle", () => {
    const lease = (pr: number) => (pr === 3 ? "debug" : pr === 4 ? "takeover" : null);
    const of = (pr: number) => runtimeOfPr(pr, { workers: () => workers, lease });
    expect([1, 2, 3, 4, 5].map(of)).toEqual(["worker", "answer", "debug", "takeover", "idle"]);
    for (const r of [1, 2, 3, 4, 5].map(of)) expect(PR_RUNTIMES).toContain(r);
  });

  it("a lease outranks a stale worker record", () => {
    expect(runtimeOfPr(1, { workers: () => workers, lease: () => "takeover" })).toBe("takeover");
  });

  it("is written into the snapshot for every PR, and absent when no reader is given", () => {
    const store = new StateStore(":memory:");
    for (const n of [1, 2, 3])
      store.upsertPr({
        number: n,
        state: "tracked",
        head_sha: "a".repeat(40),
        title: `PR ${n}`,
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
    const withRuntime = buildStatusSnapshot(
      store,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (pr) => runtimeOfPr(pr, { workers: () => workers }),
    );
    expect(Object.fromEntries(withRuntime.prs.map((p) => [p.number, p.runtime]))).toEqual({
      1: "worker",
      2: "answer",
      3: "idle",
    });
    const without = buildStatusSnapshot(store, true);
    expect(without.prs.every((p) => !("runtime" in p))).toBe(true);
    store.close();
  });
});

describe("[P8.12] rotating a PR's JSONLs", () => {
  function sessionDir(): string {
    const dir = join(tmp(), "pr-9");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "2026_a.jsonl"), '{"type":"session","id":"a"}\n');
    writeFileSync(join(dir, "nested", "2026_b.jsonl"), '{"type":"session","id":"b"}\n');
    writeFileSync(join(dir, "notes.txt"), "keep");
    return dir;
  }

  it("moves every JSONL aside so the next worker births, and keeps them openable", () => {
    const dir = sessionDir();
    expect(newestSessionFile(dir)).toBeDefined();
    const moves = rotateSessionFiles(dir, "20261019T120000Z");
    expect(moves).toHaveLength(2);
    expect(newestSessionFile(dir)).toBeUndefined();
    for (const m of moves) {
      expect(m.to).toMatch(/\.jsonl\.rotated-20261019T120000Z$/);
      expect(existsSync(m.to)).toBe(true);
      expect(existsSync(m.from)).toBe(false);
    }
    expect(readFileSync(moves[0]!.to, "utf8")).toContain('"type":"session"');
    expect(readdirSync(dir)).toContain("notes.txt");
  });

  it("never overwrites an earlier rotation with the same stamp", () => {
    const dir = sessionDir();
    const first = rotateSessionFiles(dir, "S");
    writeFileSync(join(dir, "2026_a.jsonl"), "second life\n");
    const second = rotateSessionFiles(dir, "S");
    expect(second[0]!.to).not.toBe(first[0]!.to);
    expect(readFileSync(second[0]!.to, "utf8")).toBe("second life\n");
    expect(readFileSync(first.find((m) => m.from === second[0]!.from)!.to, "utf8")).toContain(
      "session",
    );
  });

  it("is undone file by file, and leaves a name something else took", () => {
    const dir = sessionDir();
    utimesSync(join(dir, "2026_a.jsonl"), 1, 1);
    const moves = rotateSessionFiles(dir, "S");
    writeFileSync(moves[0]!.from, "a new session took the name");
    restoreRotatedFiles(moves);
    expect(readFileSync(moves[0]!.from, "utf8")).toBe("a new session took the name");
    expect(existsSync(moves[0]!.to)).toBe(true);
    expect(existsSync(moves[1]!.from)).toBe(true);
  });

  it("an absent session dir rotates nothing", () => {
    expect(rotateSessionFiles(join(tmp(), "none"), "S")).toEqual([]);
  });
});
