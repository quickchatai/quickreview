// [P8.10] The central lens permit broker (D25). The daemon's one count of lens
// sessions alive across every worker: a global ceiling (20), first-in first-out
// across workers, grants spaced by a stagger, permits taken back when a worker
// ends. Its ops ride the real IPC server on a real unix socket; the lens runner
// reaches it through its Permits port (a local semaphore everywhere else).
//
// What is pinned, against the ticket's verify:
//   - N fake workers never exceed the ceiling;
//   - a killed worker's permits return (here by capability revocation, and in
//     tests/worker-supervisor.test.ts by a real killed process);
//   - consecutive grants are at least the stagger apart;
//   - one-shot routes are unchanged (the local port is the semaphore as it was);
//   - 20 staggered faux session creations keep the event-loop lag under the D6 bar.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createBashGuard } from "@quickchatai/pi-quickreview/extensions/bash-guard.js";
import { localPermits } from "@quickchatai/pi-quickreview/src/engine/lens/permits.js";
import { loadBuiltAgents } from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import {
  createLensRunner,
  type LensRunConfig,
} from "@quickchatai/pi-quickreview/src/engine/lens/runlens.js";
import { WeightedSemaphore } from "@quickchatai/pi-quickreview/src/engine/lens/semaphore.js";
import { CapabilityStore, socketPathOf } from "../src/ipc/capability.js";
import { IpcClient } from "../src/ipc/client.js";
import {
  DEFAULT_LENS_GRANT_STAGGER_MS,
  DEFAULT_LENS_PERMITS,
  PERMITS_ACQUIRE_OP,
  PermitBroker,
  brokerPermits,
  permitOps,
} from "../src/ipc/permits.js";
import type { CommandState, IpcError } from "../src/ipc/protocol.js";
import { IpcServer } from "../src/ipc/server.js";
import { StateStore, buildStatusSnapshot } from "../src/state.js";
import { createHostRig, useOfflineGuard, type HostRig } from "./pi-canary/harness.js";

useOfflineGuard();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const who = (commandId: string, generation = 1) => ({ commandId, generation });

describe("[P8.10] the broker: ceiling, order, stagger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the ruled ceiling of 20 and a 250 ms stagger", () => {
    expect(DEFAULT_LENS_PERMITS).toBe(20);
    expect(DEFAULT_LENS_GRANT_STAGGER_MS).toBe(250);
    const b = new PermitBroker();
    expect(b.status()).toMatchObject({ ceiling: 20, stagger_ms: 250, in_use: 0, queued: 0 });
    expect(() => new PermitBroker({ ceiling: 0 })).toThrow(/ceiling/);
    expect(() => new PermitBroker({ ceiling: 2.5 })).toThrow(/ceiling/);
    expect(() => new PermitBroker({ staggerMs: -1 })).toThrow(/stagger/);
  });

  it("never grants past the ceiling, and a release lets the next in", async () => {
    const b = new PermitBroker({ ceiling: 2, staggerMs: 0 });
    const order: string[] = [];
    const ask = (cmd: string, lens: string) =>
      b.acquire(who(cmd), lens).then(() => order.push(`${cmd}/${lens}`));
    void ask("w1", "a");
    void ask("w2", "b");
    void ask("w1", "c");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["w1/a", "w2/b"]);
    expect(b.status()).toMatchObject({ in_use: 2, queued: 1 });
    expect(b.release("w2", "b")).toBe("released");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["w1/a", "w2/b", "w1/c"]);
    expect(b.release("w2", "b")).toBe("none"); // idempotent
    expect(b.status().in_use).toBe(2);
  });

  it("grants first-in first-out across workers, and a heavy head is not starved", async () => {
    const b = new PermitBroker({ ceiling: 3, staggerMs: 0 });
    const order: string[] = [];
    const ask = (cmd: string, lens: string, weight = 1) =>
      b.acquire(who(cmd), lens, weight).then(() => order.push(lens));
    void ask("w1", "a");
    void ask("w2", "b");
    void ask("w3", "c");
    void ask("w1", "heavy", 3); // waits for the whole ceiling
    void ask("w2", "d"); // behind the heavy one, though one permit would fit
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a", "b", "c"]);
    b.release("w1", "a");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a", "b", "c"]); // 1 free, the head needs 3: nobody jumps it
    b.release("w2", "b");
    b.release("w3", "c");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a", "b", "c", "heavy"]);
    b.release("w1", "heavy");
    await vi.advanceTimersByTimeAsync(0);
    expect(order.at(-1)).toBe("d");
  });

  it("clamps a weight into 1..ceiling", async () => {
    const b = new PermitBroker({ ceiling: 4, staggerMs: 0 });
    await b.acquire(who("w"), "huge", 99);
    expect(b.status().in_use).toBe(4);
    b.release("w", "huge");
    await b.acquire(who("w"), "zero", 0);
    expect(b.status().in_use).toBe(1);
  });

  it("spaces consecutive grants at least the stagger apart, even when all ask at once", async () => {
    const b = new PermitBroker({ ceiling: 20, staggerMs: 250 });
    const at: number[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 20; i++)
      void b.acquire(who(`w${i % 4}`), `l${i}`).then(() => at.push(Date.now() - t0));
    await vi.advanceTimersByTimeAsync(20 * 250);
    expect(at).toHaveLength(20);
    expect(at[0]).toBe(0); // an idle broker grants the first at once
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(250);
    // A wave of 20 takes 19 gaps to be fully granted, not one burst.
    expect(at.at(-1)).toBe(19 * 250);
    expect(b.status()).toMatchObject({ in_use: 20, queued: 0 });
  });

  it("does not delay a grant that comes after the stagger has already passed", async () => {
    const b = new PermitBroker({ ceiling: 5, staggerMs: 250 });
    await b.acquire(who("w"), "a");
    await vi.advanceTimersByTimeAsync(1000);
    let granted = false;
    void b.acquire(who("w"), "b").then(() => (granted = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toBe(true);
  });

  it("cancels a queued wait when it is released, and refuses a second ask for one lens", async () => {
    const b = new PermitBroker({ ceiling: 1, staggerMs: 0 });
    await b.acquire(who("w"), "a");
    const waiting = b.acquire(who("w"), "b");
    const caught = waiting.catch((e: IpcError) => e);
    await expect(b.acquire(who("w"), "b")).rejects.toMatchObject({ code: "bad_request" });
    expect(b.release("w", "b")).toBe("cancelled");
    expect(await caught).toMatchObject({ code: "cancelled" });
    expect(b.status()).toMatchObject({ in_use: 1, queued: 0 });
  });

  it("takes a command's permits and waits back when its worker ends, and lets the queue on", async () => {
    const b = new PermitBroker({ ceiling: 2, staggerMs: 0 });
    await b.acquire(who("dead"), "a");
    await b.acquire(who("dead"), "b");
    const behind = b.acquire(who("alive"), "c");
    const deadWait = b.acquire(who("dead"), "d");
    const caught = deadWait.catch((e: IpcError) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.status()).toMatchObject({ in_use: 2, queued: 2 });
    expect(b.releaseCommand("dead")).toBe(3);
    await behind; // the survivor got a freed permit
    expect(await caught).toMatchObject({ code: "cancelled" });
    expect(b.status()).toMatchObject({
      in_use: 1,
      queued: 0,
      commands: [{ command_id: "alive", in_use: 1, queued: 0 }],
    });
  });

  it("drops a stale generation: a newer worker for the command frees the older one's permits", async () => {
    const b = new PermitBroker({ ceiling: 2, staggerMs: 0 });
    await b.acquire(who("c", 1), "old1");
    await b.acquire(who("c", 1), "old2");
    await b.acquire(who("c", 2), "new1"); // generation 2 started: generation 1 is gone
    expect(b.status()).toMatchObject({ in_use: 1 });
  });

  it("reaps what the daemon no longer stands behind: an inactive command, an old generation", async () => {
    const b = new PermitBroker({ ceiling: 5, staggerMs: 0 });
    await b.acquire(who("gone", 1), "a");
    await b.acquire(who("moved", 1), "b");
    await b.acquire(who("fine", 3), "c");
    const state = (generation: number, active = true): CommandState => ({
      pr: 1,
      generation,
      active,
      may_post: false,
      lease: "none",
    });
    const views: Record<string, CommandState | null> = {
      gone: state(1, false),
      moved: state(2),
      fine: state(3),
    };
    expect(b.reap((id) => views[id] ?? null)).toBe(2);
    expect(b.status().commands).toEqual([{ command_id: "fine", in_use: 1, queued: 0 }]);
  });

  it("reaps on its timer once started, and stop ends every wait", async () => {
    const b = new PermitBroker({ ceiling: 1, staggerMs: 0 });
    await b.acquire(who("w"), "a");
    const waiting = b.acquire(who("w"), "b").catch((e: IpcError) => e);
    let active = true;
    b.start(() => ({ pr: 1, generation: 1, active, may_post: false, lease: "none" }), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.status().in_use).toBe(1);
    active = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toMatchObject({ code: "cancelled" });
    expect(b.status()).toMatchObject({ in_use: 0, queued: 0 });
    b.stop();
  });
});

describe("[P8.10] status.json shows the permits", () => {
  it("carries the ceiling, the permits in use and the queue, per command", async () => {
    const b = new PermitBroker({ ceiling: 2, staggerMs: 0 });
    await b.acquire(who("w1"), "a");
    await b.acquire(who("w2"), "b");
    void b.acquire(who("w1"), "c").catch(() => {});
    const store = new StateStore(":memory:");
    try {
      const snap = buildStatusSnapshot(
        store,
        false,
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
        b.status(),
      );
      expect(snap.permits).toEqual({
        ceiling: 2,
        stagger_ms: 0,
        in_use: 2,
        queued: 1,
        commands: [
          { command_id: "w1", in_use: 1, queued: 1 },
          { command_id: "w2", in_use: 1, queued: 0 },
        ],
      });
      // No broker running: no key, so a reader says "not reported".
      expect(buildStatusSnapshot(store, false)).not.toHaveProperty("permits");
    } finally {
      store.close();
      b.stop();
    }
  });
});

// ---- over the wire ----------------------------------------------------------

interface Daemon {
  broker: PermitBroker;
  caps: CapabilityStore;
  rows: Map<string, CommandState>;
  server: IpcServer;
  sock: string;
  dir: string;
  clients: IpcClient[];
  connect(commandId: string): Promise<IpcClient>;
  stop(): Promise<void>;
}

async function daemon(broker: PermitBroker): Promise<Daemon> {
  const dir = mkdtempSync(join(tmpdir(), "permits-"));
  const caps = new CapabilityStore();
  const rows = new Map<string, CommandState>();
  const sock = socketPathOf(dir);
  const server = new IpcServer({
    socketPath: sock,
    capabilities: caps,
    commands: (id) => rows.get(id) ?? null,
    ops: permitOps(broker),
    helloTimeoutMs: 2000,
  });
  broker.attach(caps);
  await server.start();
  const clients: IpcClient[] = [];
  return {
    broker,
    caps,
    rows,
    server,
    sock,
    dir,
    clients,
    async connect(commandId) {
      if (!rows.has(commandId))
        rows.set(commandId, { pr: 1, generation: 1, active: true, may_post: false, lease: "none" });
      if (caps.get(commandId) === undefined) caps.mint(commandId);
      const c = await IpcClient.connect({
        socketPath: sock,
        role: "worker",
        commandId,
        capability: caps.get(commandId)!,
        generation: 1,
        timeoutMs: 5000,
      });
      clients.push(c);
      return c;
    },
    async stop() {
      for (const c of clients) c.close();
      broker.stop();
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("[P8.10] the broker on the worker socket", () => {
  let d: Daemon | undefined;
  afterEach(async () => {
    await d?.stop();
    d = undefined;
  });

  it("N fake workers never hold more than the ceiling, and every permit comes back", async () => {
    d = await daemon(new PermitBroker({ ceiling: 20, staggerMs: 0 }));
    const dd = d;
    let held = 0;
    let peak = 0;
    const workers = Array.from({ length: 30 }, (_, w) => ({ id: `cmd-${w}` }));
    await Promise.all(
      workers.map(async ({ id }) => {
        const client = await dd.connect(id);
        const permits = brokerPermits(client);
        // Four lens passes per worker, each a permit held for a moment.
        await Promise.all(
          Array.from({ length: 4 }, async (_, i) => {
            const p = await permits.acquire(`${id}-l${i}`, 1);
            peak = Math.max(peak, ++held);
            await sleep(8 + ((w(id) * 3 + i) % 7));
            held--;
            p.release();
          }),
        );
      }),
    );
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(20);
    await vi.waitFor(() => expect(dd.broker.status()).toMatchObject({ in_use: 0, queued: 0 }));
  });

  it("a killed worker's permits return and the queue behind it moves", async () => {
    d = await daemon(new PermitBroker({ ceiling: 2, staggerMs: 0 }));
    const victim = brokerPermits(await d.connect("victim"));
    const bystander = brokerPermits(await d.connect("bystander"));
    await victim.acquire("v1", 1);
    await victim.acquire("v2", 1);
    let got = false;
    const behind = bystander.acquire("b1", 1).then(() => (got = true));
    await sleep(30);
    expect(got).toBe(false);
    expect(d.broker.status()).toMatchObject({ in_use: 2, queued: 1 });
    // The worker's process dies: the supervisor revokes its capability.
    d.caps.revoke("victim");
    await behind;
    expect(d.broker.status()).toMatchObject({
      in_use: 1,
      queued: 0,
      commands: [{ command_id: "bystander", in_use: 1, queued: 0 }],
    });
  });

  it("grants consecutive passes at least the stagger apart, measured at the workers", async () => {
    const stagger = 40;
    d = await daemon(new PermitBroker({ ceiling: 20, staggerMs: stagger }));
    const dd = d;
    const clients = await Promise.all(["a", "b", "c", "d"].map((id) => dd.connect(id)));
    const at: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const p = await brokerPermits(clients[i % 4]!).acquire(`l${i}`, 1);
        at.push(Date.now());
        p.release();
      }),
    );
    at.sort((x, y) => x - y);
    // setTimeout may fire a millisecond early against the wall clock.
    for (let i = 1; i < at.length; i++)
      expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(stagger - 2);
  });

  it("ends a wait the worker gives up on, and a late grant is given back", async () => {
    d = await daemon(new PermitBroker({ ceiling: 1, staggerMs: 0 }));
    const permits = brokerPermits(await d.connect("w"));
    const first = await permits.acquire("l1", 1);
    const ac = new AbortController();
    const waiting = permits.acquire("l2", 1, ac.signal);
    await sleep(20);
    expect(d.broker.status().queued).toBe(1);
    ac.abort(new Error("lens aborted"));
    await expect(waiting).rejects.toThrow("lens aborted");
    await vi.waitFor(() => expect(d!.broker.status()).toMatchObject({ in_use: 1, queued: 0 }));
    first.release();
    first.release(); // idempotent
    await vi.waitFor(() => expect(d!.broker.status().in_use).toBe(0));
    // Already aborted: no request is made at all.
    await expect(permits.acquire("l3", 1, ac.signal)).rejects.toThrow();
    expect(d.broker.status()).toMatchObject({ in_use: 0, queued: 0 });
  });

  it("takes a command and generation from the connection, never from the body", async () => {
    d = await daemon(new PermitBroker({ ceiling: 3, staggerMs: 0 }));
    const client = await d.connect("honest");
    await client.request(PERMITS_ACQUIRE_OP, {
      lens_id: "x",
      weight: 1,
      command_id: "someone-else",
      capability: "0".repeat(32),
    });
    expect(d.broker.status().commands).toEqual([{ command_id: "honest", in_use: 1, queued: 0 }]);
    await expect(client.request(PERMITS_ACQUIRE_OP, { weight: 1 })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      client.request(PERMITS_ACQUIRE_OP, { lens_id: "../x", weight: 1 }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("serves the ops to a worker only, and refuses a stale generation", async () => {
    d = await daemon(new PermitBroker({ ceiling: 3, staggerMs: 0 }));
    d.rows.set("c", { pr: 1, generation: 2, active: true, may_post: false, lease: "none" });
    d.caps.mint("c");
    const shim = await IpcClient.connect({
      socketPath: d.sock,
      role: "shim",
      commandId: "c",
      capability: d.caps.get("c")!,
      generation: 2,
    });
    d.clients.push(shim);
    await expect(shim.request(PERMITS_ACQUIRE_OP, { lens_id: "x" })).rejects.toMatchObject({
      code: "forbidden",
    });
    const stale = await IpcClient.connect({
      socketPath: d.sock,
      role: "worker",
      commandId: "c",
      capability: d.caps.get("c")!,
      generation: 1,
    });
    d.clients.push(stale);
    await expect(stale.request(PERMITS_ACQUIRE_OP, { lens_id: "x" })).rejects.toMatchObject({
      code: "stale_generation",
    });
    expect(d.broker.status().in_use).toBe(0);
  });
});

// ---- the lens runner behind the port ----------------------------------------

describe("[P8.10] the lens runner's Permits port", () => {
  let rig: HostRig;
  let dir: string;
  let d: Daemon | undefined;

  const agent = (name: string): string =>
    `---\nname: ${name}\ndescription: ${name} lens\nmodel: faux/faux-1\ntools: read, bash\n---\nYou are ${name}. Report findings.\n`;

  beforeEach(async () => {
    rig = await createHostRig();
    dir = mkdtempSync(join(tmpdir(), "permit-runner-"));
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "pass-a.md"), agent("pass-a"));
  });
  afterEach(async () => {
    await d?.stop();
    d = undefined;
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const guard = (): ExtensionFactory =>
    createBashGuard({ sandboxRoot: dir, replay: false, secretDirs: [] });
  const config = (over: Partial<LensRunConfig> = {}): LensRunConfig => ({
    host: rig.host,
    permits: 4,
    registry: loadBuiltAgents(join(dir, "agents")),
    cwd: dir,
    env: { PATH: process.env["PATH"], HOME: dir },
    bashGuard: guard(),
    ledgerPath: join(dir, "round", "lens-ledger.jsonl"),
    sessionGapMs: 0,
    ...over,
  });

  it("one-shot routes are unchanged: with no port the host's local semaphore caps the passes", async () => {
    let inFlight = 0;
    let peak = 0;
    rig.faux.setResponses(
      Array.from({ length: 6 }, () => async () => {
        peak = Math.max(peak, ++inFlight);
        await sleep(20);
        inFlight--;
        return fauxAssistantMessage("ok");
      }),
    );
    const runner = createLensRunner(config({ permits: 2 }));
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => runner.run({ agent: "pass-a", task: `row ${i}` })),
    );
    expect(peak).toBe(2);
    expect(runs.every((r) => r.result.exitCode === 0)).toBe(true);
  });

  it("the local port is the semaphore: FIFO, weights, an idempotent release", async () => {
    const sem = new WeightedSemaphore(2);
    const port = localPermits(sem);
    const a = await port.acquire("a", 1);
    const b = await port.acquire("b", 1);
    expect(sem.held).toBe(2);
    let c = false;
    void port.acquire("c", 1).then(() => (c = true));
    await sleep(5);
    expect(c).toBe(false);
    a.release();
    a.release();
    await sleep(5);
    expect(c).toBe(true);
    expect(sem.held).toBe(2);
    b.release();
    expect(sem.held).toBe(1);
  });

  it("a pass asks the port for a permit under its own id, holds it for the session, and returns it", async () => {
    const events: string[] = [];
    rig.faux.setResponses([
      async () => {
        events.push("model");
        return fauxAssistantMessage("found nothing");
      },
    ]);
    const runner = createLensRunner(
      config({
        permitPort: {
          async acquire(lensId, weight) {
            events.push(`acquire ${weight} ${lensId.length > 0}`);
            return { release: () => events.push("release") };
          },
        },
      }),
    );
    const run = await runner.run({ agent: "pass-a", task: "row" });
    expect(run.result.exitCode).toBe(0);
    expect(events).toEqual(["acquire 1 true", "model", "release"]);
  });

  it("a port that refuses is a failed pass, not a thrown one", async () => {
    const runner = createLensRunner(
      config({
        permitPort: {
          acquire: () => Promise.reject(new Error("the daemon is gone")),
        },
      }),
    );
    const run = await runner.run({ agent: "pass-a", task: "row" });
    expect(run.result).toMatchObject({
      exitCode: 1,
      stopReason: "error",
      errorMessage: "no lens permit: the daemon is gone",
    });
  });

  it("an abort while the broker holds the pass back ends it as aborted before it started", async () => {
    d = await daemon(new PermitBroker({ ceiling: 1, staggerMs: 0 }));
    const permits = brokerPermits(await d.connect("w"));
    const blocker = await permits.acquire("blocker", 1);
    const runner = createLensRunner(config({ permitPort: permits }));
    const ac = new AbortController();
    const running = runner.run({ agent: "pass-a", task: "row", signal: ac.signal });
    await sleep(30);
    expect(d.broker.status().queued).toBe(1);
    ac.abort();
    const run = await running;
    expect(run.result).toMatchObject({
      exitCode: 1,
      stopReason: "aborted",
      errorMessage: "lens aborted before it started",
    });
    await vi.waitFor(() => expect(d!.broker.status().queued).toBe(0));
    blocker.release();
  });

  it("20 staggered faux session creations keep the event-loop lag under the D6 bar", async () => {
    // The broker alone spaces the creations: the runner's own per-host gap is off.
    d = await daemon(new PermitBroker());
    expect(d.broker.status()).toMatchObject({ ceiling: 20, stagger_ms: 250 });
    const clients = await Promise.all(["w1", "w2", "w3", "w4"].map((id) => d!.connect(id)));
    let inFlight = 0;
    let peak = 0;
    const created: number[] = [];
    rig.faux.setResponses(
      Array.from({ length: 20 }, () => async () => {
        created.push(Date.now());
        peak = Math.max(peak, ++inFlight);
        await sleep(60);
        inFlight--;
        return fauxAssistantMessage("found nothing");
      }),
    );
    // Four workers' runners over one host stand in for four processes: each asks
    // the broker through its own connection.
    const runners = clients.map((c) =>
      createLensRunner(config({ permitPort: brokerPermits(c), sessionGapMs: 0 })),
    );
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const runs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runners[i % 4]!.run({ agent: "pass-a", task: `row ${i}` }),
      ),
    );
    lag.disable();
    expect(runs.every((r) => r.result.exitCode === 0)).toBe(true);
    expect(peak).toBeLessThanOrEqual(20);
    // D6: p99 event-loop lag <= 200 ms (docs/cpu-gate.md).
    expect(lag.percentile(99) / 1e6).toBeLessThanOrEqual(200);
    // The wave was spread over the stagger, not made in one burst.
    expect(Math.max(...created) - Math.min(...created)).toBeGreaterThanOrEqual(19 * 240);
    await vi.waitFor(() => expect(d!.broker.status()).toMatchObject({ in_use: 0, queued: 0 }));
  }, 60_000);
});

function w(id: string): number {
  return Number(id.split("-")[1] ?? 0);
}
