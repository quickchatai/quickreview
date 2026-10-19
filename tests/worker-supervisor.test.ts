// [P8.5] The WorkerSupervisor: the daemon's end of the per-round worker (D22/D23).
//
// The worker is a FAKE node process (tests/helpers/fake-worker.mjs) that speaks
// the real IPC to a real IpcServer on a real unix socket, with the supervisor's
// own lookup, ops and event handler behind it. No pi, no model, no network. What
// only a process can show is shown with one: a busy loop is hard-killed, a group
// goes with its leader, a lease that names a stranger kills nothing.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityStore } from "../src/ipc/capability.js";
import { IpcClient } from "../src/ipc/client.js";
import { PermitBroker } from "../src/ipc/permits.js";
import { IpcServer, type OpHandler } from "../src/ipc/server.js";
import type { WorkerSpec } from "../src/ipc/workerspec.js";
import { StateStore, type SessionCommandRow } from "../src/state.js";
import { type WorkerLeases, realProc, type WorkerLease } from "../src/workerlease.js";
import {
  WorkerLaunchError,
  WorkerSupervisor,
  decideOutcome,
  staleAfterMs,
  workerProcessEnv,
  DEFAULT_WORKER_LIMITS,
  type WorkerLimits,
  type WorkerObservation,
} from "../src/workersupervisor.js";

const FAKE = resolve(import.meta.dirname, "helpers", "fake-worker.mjs");
const PR = 7;
const SESSION = `pr-${PR}`;

const alive = (pid: number): boolean => realProc.identity(pid) !== undefined;

async function until(cond: () => boolean, ms = 15_000, step = 15): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, step));
  }
}

interface RigOptions {
  mode?: string;
  limits?: Partial<WorkerLimits>;
  wallMs?: number;
  parentEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
  now?: () => number;
  buildEnv?: Record<string, string>;
  /** The central lens permit broker (P8.10), handed to the supervisor. */
  permits?: PermitBroker;
}

let dir: string;
let strangers: ChildProcess[];
let servers: IpcServer[];
let supervisors: WorkerSupervisor[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws-"));
  strangers = [];
  servers = [];
  supervisors = [];
});

afterEach(async () => {
  for (const s of supervisors) await s.stop().catch(() => {});
  for (const s of servers) await s.stop().catch(() => {});
  for (const c of strangers)
    if (c.pid !== undefined) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  rmSync(dir, { recursive: true, force: true });
});

/** A store, a capability store, a supervisor over the fake worker, and the real
 * IPC server serving the supervisor's lookup, ops and events. */
async function rig(o: RigOptions = {}) {
  const base = mkdtempSync(join(dir, "r-"));
  const runDir = join(base, "run");
  const store = new StateStore(":memory:");
  const caps = new CapabilityStore();
  const observed: WorkerObservation[] = [];
  const wall = o.wallMs ?? 60_000;
  mkdirSync(join(base, "out"), { recursive: true });
  const specs: WorkerSpec[] = [];
  const sup = new WorkerSupervisor({
    store,
    capabilities: caps,
    runDir,
    socketPath: join(runDir, "q.sock"),
    workerMain: FAKE,
    logDir: join(base, "logs"),
    payloadDir: join(base, "payloads"),
    buildSpec: (row: SessionCommandRow, mode): WorkerSpec => {
      const spec: WorkerSpec = {
        mode,
        command_id: row.id,
        pr: row.pr,
        session: row.session,
        round_no: row.round_no,
        payload_path: row.payload_path,
        payload_sha256: row.payload_sha256,
        root: base,
        cwd: base,
        agent_dir: join(base, "agent"),
        session_dir: join(base, "sessions"),
        system_prompt_file: join(base, "system.md"),
        model: "faux/faux-1",
        env: { PATH: process.env["PATH"] ?? "/usr/bin", ...o.buildEnv },
        events_file: join(base, "ev.jsonl"),
        stderr_file: join(base, "err.log"),
        wall_clock_ms: wall,
        planned_wave: false,
      };
      specs.push(spec);
      return spec;
    },
    parentEnv: o.parentEnv ?? { PATH: process.env["PATH"] ?? "/usr/bin" },
    extraEnv: {
      FAKE_WORKER_MODE: o.mode ?? "ok",
      FAKE_WORKER_OUT: join(base, "out"),
      ...o.extraEnv,
    },
    limits: { tickMs: 20, killGraceMs: 200, wallGraceMs: 0, ...o.limits },
    observe: (x) => observed.push(x),
    ...(o.permits ? { permits: o.permits } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  supervisors.push(sup);
  // The server asks whichever supervisor is current: a restart swaps it.
  const current = { sup };
  const delegate = (op: string): OpHandler => ({
    roles: ["worker"],
    handle: (ctx, b) => current.sup.ops()[op]!.handle(ctx, b),
  });
  const server = new IpcServer({
    socketPath: join(runDir, "q.sock"),
    capabilities: caps,
    commands: (id) => current.sup.lookup(id),
    ops: {
      "worker.spec": delegate("worker.spec"),
      ...(o.permits
        ? {
            "permits.acquire": delegate("permits.acquire"),
            "permits.release": delegate("permits.release"),
          }
        : {}),
    },
    onEvent: (ctx, kind, b) => current.sup.onEvent(ctx, kind, b),
    helloTimeoutMs: 2000,
  });
  servers.push(server);
  await server.start();
  const round = store.startRound(PR, "first", ["pass-baseline"], 75);
  const roundNo = (store.db.prepare("SELECT round_no FROM rounds WHERE id=?").get(round) as {
    round_no: number;
  }).round_no;
  const submit = (): SessionCommandRow =>
    sup.submit({ pr: PR, kind: "round", round_no: roundNo, payload: "the round order" });
  const out = (id: string, name: string): string => {
    const f = join(base, "out", `${id}.${name}`);
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  };
  const events = (kind: string): Array<Record<string, unknown>> =>
    (
      store.db.prepare("SELECT payload FROM events WHERE kind=? ORDER BY id").all(kind) as Array<{
        payload: string;
      }>
    ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  const use = (next: WorkerSupervisor): void => {
    current.sup = next;
    supervisors.push(next);
  };
  return { sup, store, caps, server, observed, specs, roundNo, submit, out, events, runDir, base, use };
}

const finished = (sup: WorkerSupervisor): (() => boolean) => () => !sup.isLive(SESSION);

describe("[P8.5] the worker's life", () => {
  it("serves a round: spec over IPC, accepted starts the row, exit 0 acks it", async () => {
    const r = await rig();
    const row = r.submit();
    const info = await r.sup.launch(row.id);
    expect(info.generation).toBe(1);
    expect(r.sup.isLive(SESSION)).toBe(true);
    await until(finished(r.sup));
    const done = r.store.getSessionCommand(row.id)!;
    expect(done.status).toBe("acked");
    expect(done.started_at).not.toBeNull();
    expect(r.observed.map((o) => o.kind)).toEqual(
      expect.arrayContaining(["ready", "accepted", "verdict_written", "done"]),
    );
    // The worker was handed exactly the spec the builder made, heartbeat filled in.
    const spec = JSON.parse(r.out(row.id, "spec.json")) as WorkerSpec;
    expect(spec.command_id).toBe(row.id);
    expect(spec.heartbeat_ms).toBe(DEFAULT_WORKER_LIMITS.heartbeatMs);
    // Its capability is dead and its lease gone.
    expect(r.caps.get(row.id)).toBeUndefined();
    expect(readdirSync(join(r.runDir, "workers"))).toEqual([]);
    expect(r.events("worker_exited")[0]).toMatchObject({ outcome: "acked", code: 0 });
  });

  it("fails the row when the worker reports a failure and exits 1", async () => {
    const r = await rig({ mode: "fail" });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    const done = r.store.getSessionCommand(row.id)!;
    expect(done.status).toBe("failed");
    expect(done.failure).toBe("the fake turn failed");
  });

  it("requeues a worker that crashed, under the same id and a new generation", async () => {
    const r = await rig({ mode: "crash" });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    const back = r.store.getSessionCommand(row.id)!;
    expect(back.status).toBe("pending");
    expect(back.recovery_attempts).toBe(1);
    expect(back.started_at).toBeNull();
    expect(r.events("worker_exited")[0]).toMatchObject({ outcome: "requeue", signal: "SIGKILL" });
    // A fresh worker takes it as generation 2 and finishes it.
    r.sup["deps"].extraEnv = { ...r.sup["deps"].extraEnv, FAKE_WORKER_MODE: "ok" };
    const again = await r.sup.launch(row.id);
    expect(again.generation).toBe(2);
    await until(finished(r.sup));
    expect(r.store.getSessionCommand(row.id)!.status).toBe("acked");
  });

  it("stops requeueing once the bound is spent", async () => {
    const r = await rig({ mode: "crash", limits: { maxRequeues: 1 } });
    const row = r.submit();
    for (let i = 0; i < 2; i++) {
      await r.sup.launch(row.id).catch(() => {});
      await until(finished(r.sup));
    }
    const done = r.store.getSessionCommand(row.id)!;
    expect(done.status).toBe("failed");
    expect(done.failure).toContain("requeued 1 times already");
  });

  it("launchPending starts every pending command of a session with no worker", async () => {
    const r = await rig();
    const row = r.submit();
    const started = await r.sup.launchPending();
    expect(started.map((s) => s.command_id)).toEqual([row.id]);
    await until(finished(r.sup));
    expect(await r.sup.launchPending()).toEqual([]);
  });
});

describe("[P8.5] ending a worker", () => {
  it("hard-kills a busy loop that ignores SIGTERM, at its wall clock", async () => {
    const r = await rig({ mode: "busy", wallMs: 300 });
    r.sup.start();
    const row = r.submit();
    const info = await r.sup.launch(row.id);
    await until(() => !alive(info.pid));
    await until(finished(r.sup));
    const done = r.store.getSessionCommand(row.id)!;
    expect(done.status).toBe("failed");
    expect(done.failure).toContain("wall clock");
    expect(r.events("worker_ending")[0]).toMatchObject({ why: "wall_clock" });
    // SIGTERM did nothing (the loop never yields); the KILL did.
    expect(r.events("worker_exited")[0]).toMatchObject({ signal: "SIGKILL" });
    expect(readdirSync(join(r.runDir, "workers"))).toEqual([]);
  });

  it("lets a worker that handles SIGTERM leave on it: no KILL, and the round is not retried", async () => {
    const r = await rig({ mode: "term-ok", wallMs: 2_000, limits: { killGraceMs: 5_000 } });
    r.sup.start();
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    expect(r.events("worker_exited")[0]).toMatchObject({ code: 143, signal: null });
    expect(r.store.getSessionCommand(row.id)!.status).toBe("failed");
  });

  it("takes the whole group down with the leader, tool children included", async () => {
    const r = await rig({ mode: "group", wallMs: 1_500 });
    r.sup.start();
    const row = r.submit();
    const info = await r.sup.launch(row.id);
    await until(() => r.out(row.id, "grandchild.txt") !== "");
    const grandchild = Number(r.out(row.id, "grandchild.txt"));
    expect(alive(grandchild)).toBe(true);
    await until(() => !alive(info.pid) && !alive(grandchild));
    await until(finished(r.sup));
  });

  it("tolerates a late beat (the 2.5 s session-creation stall) and ends a silent worker", async () => {
    let t = 1_000_000;
    const r = await rig({ mode: "silent", wallMs: 600_000, now: () => t });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(() => r.observed.some((o) => o.kind === "ready"));
    const beat = DEFAULT_WORKER_LIMITS.heartbeatMs;
    const stale = staleAfterMs(beat, { ...DEFAULT_WORKER_LIMITS });
    // One beat late plus the worst measured stall: still a live worker.
    t += beat + 2_500;
    r.sup.tick();
    expect(r.sup.workers()[0]?.ending).toBeNull();
    // The allowance is wider than that stall, but not unbounded.
    expect(stale).toBeGreaterThan(beat + 2_500);
    t += stale - (beat + 2_500) + 1;
    r.sup.tick();
    expect(r.sup.workers()[0]?.ending).toBe("heartbeat_lost");
    await until(finished(r.sup));
    // Lost workers requeue: the round is not lost with them.
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
  });

  it("ends a worker that never says ready, and one that never accepts", async () => {
    let t = 5_000_000;
    const mute = await rig({ mode: "mute", wallMs: 100_000_000, now: () => t });
    const a = mute.submit();
    await mute.sup.launch(a.id);
    t += DEFAULT_WORKER_LIMITS.readyMs - 1;
    mute.sup.tick();
    expect(mute.sup.workers()[0]?.ending).toBeNull();
    t += 2;
    mute.sup.tick();
    expect(mute.sup.workers()[0]?.ending).toBe("stage_ready");
    await until(finished(mute.sup));

    const idle = await rig({ mode: "silent", wallMs: 100_000_000, now: () => t });
    const b = idle.submit();
    await idle.sup.launch(b.id);
    await until(() => idle.observed.some((o) => o.kind === "ready"));
    t += DEFAULT_WORKER_LIMITS.acceptMs + 1;
    idle.sup.tick();
    expect(idle.sup.workers()[0]?.ending).toBe("stage_accept");
    await until(finished(idle.sup));
  });

  it("an operator's end fails the command; stop() requeues it for the next daemon", async () => {
    const r = await rig({ mode: "term-ok" });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(() => r.observed.some((o) => o.kind === "accepted"));
    expect(r.sup.kill(row.id)).toBe(true);
    await until(finished(r.sup));
    expect(r.store.getSessionCommand(row.id)!.status).toBe("failed");

    const s = await rig({ mode: "term-ok" });
    const b = s.submit();
    await s.sup.launch(b.id);
    await until(() => s.observed.some((o) => o.kind === "accepted"));
    await s.sup.stop();
    expect(s.store.getSessionCommand(b.id)!.status).toBe("pending");
    expect(s.sup.workers()).toEqual([]);
  });
});

describe("[P8.5] the fences", () => {
  it("rejects a stale generation's request and event, and does not act on them", async () => {
    const r = await rig({ mode: "stale" });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    expect(r.out(row.id, "stale-request.txt")).toBe("stale_generation");
    expect(r.out(row.id, "stale-event.txt")).toContain("stale_generation");
    expect(r.observed.some((o) => o.body && (o.body as { stage?: string }).stage === "stale")).toBe(
      false,
    );
  });

  it("refuses a second spawn for a session, however it is asked", async () => {
    const r = await rig({ mode: "term-ok" });
    const row = r.submit();
    const results = await Promise.allSettled([r.sup.launch(row.id), r.sup.launch(row.id)]);
    expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(WorkerLaunchError);
    // Later, while the first lives: the same command, and a new one for the session.
    await expect(r.sup.launch(row.id)).rejects.toThrow(/already has a worker/);
    expect(() => r.submit()).toThrow(/is running/);
    // The one-active index is the last line.
    expect(() =>
      r.store.createSessionCommand({
        id: "other",
        pr: PR,
        session: SESSION,
        kind: "wake",
        round_no: null,
        payload_sha256: "a".repeat(64),
        payload_path: "/x",
        inject_path: "worker:other",
        next_check_at: new Date().toISOString(),
      }),
    ).toThrow(/UNIQUE/);
    expect(r.sup.workers()).toHaveLength(1);
  });

  it("refuses a spawn while a lease names a live worker, and clears a lease that names a stranger", async () => {
    const r = await rig();
    const row = r.submit();
    const keeper = stranger();
    plantLease(r.sup.leases, { pid: keeper.pid!, command_id: "someone-else" });
    await expect(r.sup.launch(row.id)).rejects.toThrow(/has a live worker/);
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
    // The same lease with a start time that is not that process's: a stale file.
    plantLease(r.sup.leases, { pid: keeper.pid!, command_id: "someone-else", start_time: "1" }, true);
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    expect(alive(keeper.pid!)).toBe(true);
    expect(r.store.getSessionCommand(row.id)!.status).toBe("acked");
  });

  it("serves `worker.spec` to the live generation only, and refuses a dead command's hello", async () => {
    const r = await rig({ mode: "term-ok" });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(() => r.observed.some((o) => o.kind === "accepted"));
    const cap = r.caps.get(row.id)!;
    const client = await IpcClient.connect({
      socketPath: join(r.runDir, "q.sock"),
      role: "worker",
      commandId: row.id,
      capability: cap,
      generation: 1,
    });
    await expect(client.request("worker.spec")).resolves.toMatchObject({ command_id: row.id });
    const old = await IpcClient.connect({
      socketPath: join(r.runDir, "q.sock"),
      role: "worker",
      commandId: row.id,
      capability: cap,
      generation: 0,
    });
    await expect(old.request("worker.spec")).rejects.toMatchObject({ code: "stale_generation" });
    // A shim may not ask for the spec.
    const shim = await IpcClient.connect({
      socketPath: join(r.runDir, "q.sock"),
      role: "shim",
      commandId: row.id,
      capability: cap,
      generation: 1,
    });
    await expect(shim.request("worker.spec")).rejects.toMatchObject({ code: "forbidden" });
    client.close();
    old.close();
    shim.close();
    r.sup.kill(row.id);
    await until(finished(r.sup));
    await expect(
      IpcClient.connect({
        socketPath: join(r.runDir, "q.sock"),
        role: "worker",
        commandId: row.id,
        capability: cap,
        generation: 1,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("serves held wakes through the ops when the daemon gives it a source", async () => {
    const r = await rig();
    expect(Object.keys(r.sup.ops())).toEqual(["worker.spec"]);
    const acked: string[] = [];
    const withWakes = new WorkerSupervisor({
      ...(r.sup["deps"] as ConstructorParameters<typeof WorkerSupervisor>[0]),
      wakes: {
        take: () => [{ id: "w1", message: "hello" }],
        ack: (_c, id) => void acked.push(id),
      },
    });
    supervisors.push(withWakes);
    const ops = withWakes.ops();
    const ctx = { commandId: "c" } as never;
    expect(await ops["wakes.take"]!.handle(ctx, {})).toEqual({
      batches: [{ id: "w1", message: "hello" }],
    });
    await ops["wakes.ack"]!.handle(ctx, { id: "w1" });
    expect(acked).toEqual(["w1"]);
    await expect(Promise.resolve().then(() => ops["wakes.ack"]!.handle(ctx, {}))).rejects.toMatchObject(
      { code: "bad_request" },
    );
  });

  it("holds a spawn while a login pauses the refresher, and refuses when it does not end", async () => {
    const r = await rig();
    let paused = true;
    const deps = r.sup["deps"] as ConstructorParameters<typeof WorkerSupervisor>[0];
    const gated = new WorkerSupervisor({
      ...deps,
      loginGate: {
        paused: () => paused,
        whenResumed: async () => !paused,
      },
    });
    r.use(gated);
    const row = r.submit();
    await expect(gated.launch(row.id)).rejects.toThrow(/refresher paused/);
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
    paused = false;
    await gated.launch(row.id);
    await until(() => !gated.isLive(SESSION));
  });

  it("refuses a spec that is not for the command, and strips what a spec must not carry", async () => {
    const r = await rig({ buildEnv: { GITHUB_TOKEN: "ghs_secret", GH_TOKEN: "ghs_secret2" } });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    const spec = JSON.parse(r.out(row.id, "spec.json")) as WorkerSpec;
    expect(Object.keys(spec.env)).toEqual(["PATH"]);

    const bad = await rig({ buildEnv: { QCR_IPC_SOCKET: "/evil" } });
    const b = bad.submit();
    await expect(bad.sup.launch(b.id)).rejects.toThrow(/IPC names/);
    expect(bad.store.getSessionCommand(b.id)!.status).toBe("pending");

    // A payload that is not the bytes dispatched is never run.
    const tampered = await rig();
    const c = tampered.submit();
    writeFileSync(c.payload_path, "something else\n");
    await expect(tampered.sup.launch(c.id)).rejects.toThrow(/hash/);
    expect(tampered.store.getSessionCommand(c.id)!.status).toBe("failed");
  });
});

describe("[P8.5] the worker's env", () => {
  const secrets: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    GITHUB_TOKEN: "ghs_a",
    GH_TOKEN: "ghs_b",
    GH_ENTERPRISE_TOKEN: "ghs_c",
    OPENAI_API_KEY: "sk-live",
    AWS_SECRET_ACCESS_KEY: "aws",
    NODE_OPTIONS: "--require /evil.js",
    QCR_IPC_CAP_FD: "9",
  };

  it("is an allowlist, with every GitHub credential name stripped last", () => {
    const env = workerProcessEnv(
      secrets,
      { GH_TOKEN: "ghs_extra", GITHUB_TOKEN: "x", FAKE: "1", QCR_IPC_COMMAND_ID: "evil" },
      { QCR_IPC_COMMAND_ID: "real", QCR_IPC_CAP_FD: "3" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      FAKE: "1",
      QCR_IPC_COMMAND_ID: "real",
      QCR_IPC_CAP_FD: "3",
    });
  });

  it("holds no GitHub token and no capability in the process the worker really is", async () => {
    const r = await rig({
      mode: "env",
      parentEnv: secrets,
      extraEnv: { GH_TOKEN: "ghs_extra" },
    });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    const seen = JSON.parse(r.out(row.id, "env.json")) as {
      env: Record<string, string>;
      argv: string[];
      cwd: string;
    };
    const capability = r.out(row.id, "cap.txt");
    expect(capability).toMatch(/^[0-9a-f]{32}$/);
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "OPENAI_API_KEY"])
      expect(seen.env[name], name).toBeUndefined();
    expect(seen.env["NODE_OPTIONS"]).toBeUndefined();
    expect(Object.values(seen.env).some((v) => v.includes(capability))).toBe(false);
    expect(seen.argv).toEqual(["--command", row.id, "--mode", "round"]);
    // The IPC names are the supervisor's, and the fd is a number, not a secret.
    expect(seen.env["QCR_IPC_COMMAND_ID"]).toBe(row.id);
    expect(seen.env["QCR_IPC_GENERATION"]).toBe("1");
    expect(seen.env["QCR_IPC_CAP_FD"]).toBe("3");
    expect(seen.env["QCR_IPC_SOCKET"]).toBe(join(r.runDir, "q.sock"));
    expect(realpathSync(seen.cwd)).toBe(realpathSync(r.base));
  });
});

describe("[P8.5] a restart", () => {
  it("kills the previous daemon's worker group and requeues its round under the same id", async () => {
    const r = await rig({ mode: "group", limits: { killGraceMs: 150 } });
    const row = r.submit();
    const info = await r.sup.launch(row.id);
    await until(() => r.out(row.id, "grandchild.txt") !== "");
    const grandchild = Number(r.out(row.id, "grandchild.txt"));
    const leaseFile = join(r.runDir, "workers", `${SESSION}.lease.json`);
    const lease = JSON.parse(readFileSync(leaseFile, "utf8")) as WorkerLease;
    expect(lease).toMatchObject({ pid: info.pid, pgid: info.pid, command_id: row.id, generation: 1 });
    expect(lease.start_time).toMatch(/^\d+$/);
    expect(lease.boot_id).toBe(realProc.bootId());

    // The daemon dies: its supervisor is gone, the worker and the lease are not.
    const old = r.sup["byCommand"].get(row.id)!;
    old.child.removeAllListeners();
    r.sup["byCommand"].clear();
    r.sup["bySession"].clear();
    expect(alive(info.pid)).toBe(true);

    // A new daemon: same store and run dir, a supervisor of its own.
    const next = new WorkerSupervisor({
      ...(r.sup["deps"] as ConstructorParameters<typeof WorkerSupervisor>[0]),
      extraEnv: { FAKE_WORKER_MODE: "ok", FAKE_WORKER_OUT: join(r.base, "out") },
    });
    r.use(next);
    const result = await next.recover();
    expect(result).toMatchObject({ killed: [SESSION], requeued: [row.id], failed: [] });
    expect(alive(info.pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(existsSync(leaseFile)).toBe(false);
    const back = r.store.getSessionCommand(row.id)!;
    expect(back.status).toBe("pending");
    expect(back.recovery_attempts).toBe(1);

    // The fresh worker takes the same command as generation 2.
    const again = await next.launchPending();
    expect(again).toMatchObject([{ command_id: row.id, generation: 2 }]);
    await until(() => !next.isLive(SESSION));
    expect(r.store.getSessionCommand(row.id)!.status).toBe("acked");
  });

  it("does not kill a process that a lease names but that is not the worker any more", async () => {
    const r = await rig();
    const wrongStart = stranger();
    const wrongBoot = stranger();
    const leader = stranger();
    const real = r.sup.leases;
    plantLease(real, { session: "pr-11", pr: 11, pid: wrongStart.pid!, start_time: "42" });
    plantLease(real, { session: "pr-12", pr: 12, pid: wrongBoot.pid!, boot_id: "other-boot/other-box" });
    plantLease(real, { session: "pr-13", pr: 13, pid: leader.pid! });
    const result = await r.sup.recover();
    // Only the lease that is exactly its process killed it.
    expect(result.killed).toEqual(["pr-13"]);
    expect(result.stale.sort()).toEqual(["pr-11", "pr-12"]);
    await until(() => !alive(leader.pid!));
    expect(alive(wrongStart.pid!)).toBe(true);
    expect(alive(wrongBoot.pid!)).toBe(true);
    expect(real.list()).toEqual([]);
  });

  it("clears a lease file that is not a lease, and requeues running rows that have no worker", async () => {
    const r = await rig();
    const row = r.submit();
    r.store.claimSessionCommand(row.id, "tok", new Date().toISOString());
    writeFileSync(join(r.runDir, "workers", "pr-99.lease.json"), "{not json");
    const result = await r.sup.recover();
    expect(result.stale).toEqual(["pr-99"]);
    expect(result.requeued).toEqual([row.id]);
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
  });

  it("fails, not requeues, a round whose worker group would not die", async () => {
    const r = await rig({ limits: { killGraceMs: 50 } });
    const row = r.submit();
    r.store.claimSessionCommand(row.id, "tok", new Date().toISOString());
    const keeper = stranger();
    plantLease(r.sup.leases, { pid: keeper.pid!, command_id: row.id, pr: PR, session: SESSION });
    const stuck = new WorkerSupervisor({
      ...(r.sup["deps"] as ConstructorParameters<typeof WorkerSupervisor>[0]),
      signal: () => "denied",
    });
    supervisors.push(stuck);
    const result = await stuck.recover();
    expect(result.failed).toEqual([row.id]);
    expect(result.requeued).toEqual([]);
    expect(r.store.getSessionCommand(row.id)!.status).toBe("failed");
  });
});

describe("[P8.5] what an exit means", () => {
  const base = {
    code: 0 as number | null,
    signal: null as NodeJS.Signals | null,
    killedFor: undefined,
    failedReason: undefined,
    spawnError: undefined,
  };

  it.each([
    [{ code: 0 }, "acked"],
    [{ code: 1, failedReason: "the provider refused the login" }, "failed"],
    [{ code: 3 }, "failed"],
    [{ code: 75 }, "requeue"],
    [{ code: 76 }, "requeue"],
    [{ code: 143 }, "requeue"],
    [{ code: null, signal: "SIGKILL" as const }, "requeue"],
    [{ code: 0, killedFor: "wall_clock" as const }, "failed"],
    [{ code: 143, killedFor: "operator" as const }, "failed"],
    [{ code: 143, killedFor: "heartbeat_lost" as const }, "requeue"],
    [{ code: 143, killedFor: "shutdown" as const }, "requeue"],
    [{ code: null, spawnError: "spawn ENOENT" }, "failed"],
  ])("%j is %s", (over, kind) => {
    expect(decideOutcome({ ...base, ...over }).kind).toBe(kind);
  });
});

/** A sleeping process in a group of its own: someone else's, as far as a lease knows. */
function stranger(): ChildProcess {
  const c = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  c.unref();
  strangers.push(c);
  return c;
}

/** A lease that names `pid` as exactly what it is (or, with `over`, as not). */
function plantLease(
  leases: WorkerLeases,
  over: Partial<WorkerLease> & { pid: number },
  replace = false,
): void {
  const identity = realProc.identity(over.pid)!;
  const session = over.session ?? SESSION;
  if (replace) leases.forget(session);
  leases.create({
    v: 1,
    owner_token: "planted",
    command_id: "planted-cmd",
    session,
    pr: PR,
    generation: 1,
    pgid: over.pid,
    start_time: identity.start,
    boot_id: realProc.bootId(),
    command: "planted",
    created_at: new Date().toISOString(),
    ...over,
  });
}

describe("[P8.10] the permit broker behind the supervisor", () => {
  it("serves the permit ops only when it was given a broker", async () => {
    const without = await rig();
    expect(Object.keys(without.sup.ops())).not.toContain("permits.acquire");
    const withIt = await rig({ permits: new PermitBroker() });
    expect(Object.keys(withIt.sup.ops())).toEqual(
      expect.arrayContaining(["permits.acquire", "permits.release"]),
    );
  });

  it("takes a killed worker's permits back when the process is gone, and the requeued one starts clean", async () => {
    const lines: string[] = [];
    const broker = new PermitBroker({ ceiling: 3, staggerMs: 0, log: (m) => lines.push(m) });
    const r = await rig({ mode: "permit-crash", permits: broker });
    const row = r.submit();
    await r.sup.launch(row.id);
    await until(finished(r.sup));
    // The worker took two permits (both granted) and died holding them.
    expect(JSON.parse(r.out(row.id, "permits.json"))).toEqual([true, true]);
    expect(lines.filter((l) => l.includes("came back"))).toHaveLength(2);
    expect(broker.status()).toMatchObject({ in_use: 0, queued: 0, commands: [] });
    // Its requeued successor can take them again: nothing leaked.
    const again = await r.sup.launch(row.id);
    expect(again.generation).toBe(2);
    await until(finished(r.sup));
    expect(broker.status().in_use).toBe(0);
  });
});
