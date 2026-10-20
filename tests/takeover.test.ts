// [P8.13] The takeover lease (D27): the operator works in a PR's real session.
//
// A FAKE host stands in for tmux and the process table: sessions, pids with start
// times and process groups, signals that kill (or are ignored, or cannot kill),
// and a clock that the test moves. The store, the lease, the capability, the
// launch file, the supervisor's gate, the wakes, the dispatch pump and the post
// ops are the real ones. No pi, no model, no network.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashGuard } from "../extensions/bash-guard.js";
import { workerOperatorControl } from "../src/workercontrol.js";
import { parseTakeoverArgs, takeoverAttachLines } from "../src/cli.js";
import { parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import { CapabilityStore, LaunchFiles, capsDirOf } from "../src/ipc/capability.js";
import type { IpcClient } from "../src/ipc/client.js";
import { StateStore, type SessionCommandRow } from "../src/state.js";
import {
  TAKEOVER_IDLE_MS,
  TAKEOVER_TOOLS,
  TakeoverManager,
  composeLookups,
  takeoverPlanFor,
  takeoverSession,
  type TakeoverPlan,
  type TakeoverSpec,
} from "../src/takeover.js";
import { Tmux, type ExecFn } from "../src/tmux.js";
import { flushHeldWakes, wakeOrHold } from "../src/wakes.js";
import type { ProcView, SignalFn } from "../src/workerlease.js";
import { runtimeOfPr } from "../src/workerruntime.js";
import { WorkerLaunchError, WorkerSupervisor } from "../src/workersupervisor.js";
import { buildRig, PR, type Rig } from "./helpers/post-ops-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const CFG: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const MIN = 60_000;

// ---- the fake host: tmux and the process table ---------------------------------

interface FakeProc {
  alive: boolean;
  start: string;
  pgid: number;
  /** Ignores the hangup and the TERM: only a KILL ends it. */
  stubborn: boolean;
  /** Survives even a KILL (uninterruptible sleep). */
  immortal: boolean;
  session: string;
}

class FakeHost {
  sessions = new Map<string, { pid: number; cmd: string[]; cwd: string | undefined }>();
  procs = new Map<number, FakeProc>();
  activity = new Map<string, number>();
  clock = Date.parse("2026-10-19T09:00:00.000Z");
  nextPid = 4000;
  /** The next pi started ignores the hangup and the TERM. */
  stubbornNext = false;
  immortalNext = false;
  /** tmux refuses the next new-session. */
  failNewSession = false;
  signals: Array<[number, string]> = [];

  readonly exec: ExecFn = async (_cmd, args) => {
    const name = (flag: string): string =>
      (args[args.indexOf(flag) + 1] ?? "").replace(/^=|:$/g, "");
    switch (args[0]) {
      case "new-session": {
        if (this.failNewSession) return { code: 1, stdout: "", stderr: "tmux: no space" };
        const session = name("-s");
        const cwdAt = args.indexOf("-c");
        const rest = args.slice(cwdAt >= 0 ? cwdAt + 2 : args.indexOf("-s") + 2);
        const pid = this.nextPid++;
        this.sessions.set(session, {
          pid,
          cmd: rest,
          cwd: cwdAt >= 0 ? args[cwdAt + 1] : undefined,
        });
        this.procs.set(pid, {
          alive: true,
          start: String(1000 + pid),
          pgid: pid,
          stubborn: this.stubbornNext || this.immortalNext,
          immortal: this.immortalNext,
          session,
        });
        this.stubbornNext = false;
        this.immortalNext = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      case "kill-session": {
        const session = name("-t");
        const s = this.sessions.get(session);
        if (s) {
          const p = this.procs.get(s.pid)!;
          if (!p.stubborn) this.die(s.pid);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      case "list-sessions":
        return this.sessions.size === 0
          ? { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-0/default" }
          : { code: 0, stdout: [...this.sessions.keys()].join("\n") + "\n", stderr: "" };
      case "has-session":
        return { code: this.sessions.has(name("-t")) ? 0 : 1, stdout: "", stderr: "" };
      case "list-panes": {
        const s = this.sessions.get(name("-t"));
        return s
          ? { code: 0, stdout: `${s.pid}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "" };
      }
      case "display-message": {
        const at = this.activity.get(name("-t"));
        return at === undefined
          ? { code: 0, stdout: "\n", stderr: "" }
          : { code: 0, stdout: `${Math.floor(at / 1000)}\n`, stderr: "" };
      }
      default:
        return { code: 1, stdout: "", stderr: `unscripted tmux ${args[0]}` };
    }
  };

  die(pid: number): void {
    const p = this.procs.get(pid);
    if (!p) return;
    p.alive = false;
    this.sessions.delete(p.session);
  }

  readonly proc: ProcView = {
    identity: (pid) => {
      const p = this.procs.get(pid);
      return p?.alive ? { start: p.start, pgid: p.pgid } : undefined;
    },
    members: (pgid) =>
      [...this.procs.entries()]
        .filter(([, p]) => p.alive && p.pgid === pgid)
        .map(([pid, p]) => ({ pid, start: p.start })),
    bootId: () => "boot-1/ctr-1",
  };

  readonly signal: SignalFn = (target, sig) => {
    this.signals.push([target, sig]);
    const group = target < 0;
    let hit = false;
    for (const [pid, p] of this.procs) {
      if (!p.alive || (group ? p.pgid !== -target : pid !== target)) continue;
      hit = true;
      if (p.immortal) continue;
      if (sig === "SIGKILL" || (sig === "SIGTERM" && !p.stubborn)) this.die(pid);
    }
    return hit ? "sent" : "gone";
  };

  alivePis(): number {
    return [...this.procs.values()].filter((p) => p.alive).length;
  }
}

// ---- the rig --------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "takeover-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const planFor =
  (root: string): ((pr: number) => TakeoverPlan) =>
  (pr) => {
    if (pr === 99) throw new Error("PR #99 has no session JSONL: nothing to take over");
    return {
      root,
      cwd: root,
      agent_dir: join(root, "agent"),
      session_file: join(root, "state", "pi-sessions", `pr-${pr}`, "s.jsonl"),
      model: "faux/faux-1",
      extensions: [join(root, "extensions", "cli", "bash-guard.ts")],
      env: { QCR_SANDBOX_ROOT: root },
    };
  };

function upsert(store: StateStore, n: number, state: "queued" | "tracked" = "tracked"): void {
  store.upsertPr({
    number: n,
    state,
    head_sha: `sha${n}`,
    title: `PR ${n}`,
    author: "alice",
    trigger_ts: state === "queued" ? "2026-10-19T08:00:00Z" : null,
    trigger_provenance: "human",
    stale_recheck: 0,
    migration_gate: 0,
  });
}

function rig(
  o: {
    workerRuns?: (pr: number) => boolean | null;
    afterRelease?: (pr: number) => Promise<void>;
  } = {},
) {
  const root = join(dir, "root");
  const runDir = join(dir, "run");
  mkdirSync(join(root, "state"), { recursive: true });
  const store = new StateStore(":memory:");
  const capabilities = new CapabilityStore();
  const launchFiles = new LaunchFiles({ capsDir: capsDirOf(join(dir, "st")), store: capabilities });
  const host = new FakeHost();
  const manager = (extra: Partial<ConstructorParameters<typeof TakeoverManager>[0]> = {}) =>
    new TakeoverManager({
      store,
      capabilities,
      launchFiles,
      runDir,
      socketPath: join(runDir, "q.sock"),
      tmux: new Tmux({ exec: host.exec }),
      plan: planFor(root),
      launcherMain: "/opt/qcr/dist/src/ipc/launcher.js",
      takeoverMain: "/opt/qcr/dist/src/takeoverpi.js",
      nodeBin: "/usr/bin/node",
      killGraceMs: 200,
      proc: host.proc,
      signal: host.signal,
      now: () => host.clock,
      sleep: async (ms) => {
        host.clock += ms;
      },
      ...(o.workerRuns ? { workerRuns: o.workerRuns } : {}),
      ...(o.afterRelease ? { afterRelease: o.afterRelease } : {}),
      ...extra,
    });
  return { root, runDir, store, capabilities, launchFiles, host, manager, mgr: manager() };
}

/** A supervisor whose spawn is a fake that records what the pis were doing then. */
function supervisorOver(r: ReturnType<typeof rig>, log: string[]) {
  const sup = new WorkerSupervisor({
    store: r.store,
    capabilities: r.capabilities,
    runDir: r.runDir,
    socketPath: join(r.runDir, "q.sock"),
    workerMain: "/opt/qcr/dist/src/botworker.js",
    logDir: join(dir, "logs"),
    payloadDir: join(dir, "payloads"),
    buildSpec: (row: SessionCommandRow, mode) => ({
      mode,
      command_id: row.id,
      pr: row.pr,
      session: row.session,
      round_no: row.round_no,
      payload_path: row.payload_path,
      payload_sha256: row.payload_sha256,
      root: r.root,
      cwd: r.root,
      agent_dir: join(r.root, "agent"),
      session_dir: join(r.root, "sessions"),
      system_prompt_file: join(r.root, "system.md"),
      model: "faux/faux-1",
      env: { PATH: "/usr/bin" },
      events_file: join(dir, "ev.jsonl"),
      stderr_file: join(dir, "err.log"),
      wall_clock_ms: 60_000,
      planned_wave: false,
    }),
    parentEnv: { PATH: "/usr/bin" },
    hostGate: (pr) => r.mgr.hostGate(pr),
    proc: r.host.proc,
    signal: r.host.signal,
    spawn: (() => {
      log.push(`spawn(pis alive: ${r.host.alivePis()})`);
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 55_555;
      return child;
    }) as never,
  });
  const round = r.store.startRound(7, "first", ["pass-baseline"], 75);
  const roundNo = (
    r.store.db.prepare("SELECT round_no FROM rounds WHERE id=?").get(round) as { round_no: number }
  ).round_no;
  return {
    sup,
    submit: () =>
      sup.submit({ pr: 7, kind: "round", round_no: roundNo, payload: "the round order" }),
  };
}

const spawnedPis = (host: FakeHost): string[] => [...host.sessions.keys()];

describe("[P8.13] granting the lease", () => {
  it("starts interactive pi on the real session in tmux takeover-pr-<n>, with the lease in SQLite", async () => {
    const r = rig();
    upsert(r.store, 7);
    const res = await r.mgr.grant(7, "owner");
    expect(res).toMatchObject({ ok: true, session: "takeover-pr-7" });
    expect(spawnedPis(r.host)).toEqual(["takeover-pr-7"]);

    const lease = r.store.hostLease(7)!;
    expect(lease).toMatchObject({ pr: 7, kind: "takeover", state: "held", holder: "owner" });
    // the pane runs the launcher (claims the capability), then the pane's entry on a spec file
    const { cmd, cwd } = r.host.sessions.get("takeover-pr-7")!;
    expect(cwd).toBe(r.root);
    expect(cmd.slice(0, 5)).toEqual([
      "/usr/bin/node",
      "/opt/qcr/dist/src/ipc/launcher.js",
      expect.stringMatching(/\.cap$/),
      "--",
      "/usr/bin/node",
    ]);
    expect(cmd[5]).toBe("/opt/qcr/dist/src/takeoverpi.js");
    const spec = JSON.parse(readFileSync(cmd[6]!, "utf8")) as TakeoverSpec;
    // the PR's real JSONL (write, not fork), the read tools, and the no-post marker
    expect(spec).toMatchObject({
      pr: 7,
      session: "takeover-pr-7",
      session_file: join(r.root, "state", "pi-sessions", "pr-7", "s.jsonl"),
      tools: TAKEOVER_TOOLS,
      idle_ms: TAKEOVER_IDLE_MS,
    });
    expect(spec.tools.split(",")).not.toContain("edit");
    expect(spec.tools.split(",")).not.toContain("write");
    expect(spec.env).toMatchObject({ QCR_TAKEOVER: "1", QCR_IPC_COMMAND_ID: lease.command_id });
    expect(JSON.stringify(spec)).not.toMatch(/GITHUB_TOKEN|GH_TOKEN/);
    // the capability exists for the launch file, and is not in the spec
    expect(r.capabilities.get(lease.command_id)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(spec)).not.toContain(r.capabilities.get(lease.command_id)!);
    expect(r.launchFiles.outstanding()).toBe(1);
    // the status runtime
    expect(runtimeOfPr(7, { workers: () => [], lease: (pr) => r.mgr.leaseOf(pr) })).toBe(
      "takeover",
    );
    expect(runtimeOfPr(8, { workers: () => [], lease: (pr) => r.mgr.leaseOf(pr) })).toBe("idle");
  });

  it("is refused while a worker runs, however it is seen", async () => {
    // a worker command owns the session
    const a = rig();
    upsert(a.store, 7);
    a.store.createSessionCommand({
      id: "c1",
      pr: 7,
      session: "pr-7",
      kind: "round",
      round_no: 1,
      payload_sha256: "a".repeat(64),
      payload_path: join(dir, "p.md"),
      inject_path: "worker:c1",
      next_check_at: new Date().toISOString(),
    });
    expect(await a.mgr.grant(7)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/worker command/),
    });
    expect(a.store.hostLease(7)).toBeUndefined();
    expect(spawnedPis(a.host)).toEqual([]);

    // a worker process the lease files show, with no command row
    const b = rig({ workerRuns: () => true });
    expect(await b.mgr.grant(7)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/worker runs/),
    });
    // a look that failed proves nothing
    const c = rig({ workerRuns: () => null });
    expect(await c.mgr.grant(7)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot tell/),
    });
    expect(spawnedPis(c.host)).toEqual([]);
  });

  it("is refused for a PR with nothing to resume, and twice for one PR", async () => {
    const r = rig();
    expect(await r.mgr.grant(99)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/nothing to take over/),
    });
    expect((await r.mgr.grant(7)).ok).toBe(true);
    expect(await r.mgr.grant(7)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already under a takeover lease/),
    });
    expect(spawnedPis(r.host)).toEqual(["takeover-pr-7"]);
  });

  it("is granted under a drain and on a parked PR, because it never posts", async () => {
    const r = rig();
    r.store.engageDrain({ issuer: "operator", expires_at: null });
    r.store.recordWorkerFailure(7, {
      commandId: "x",
      error: "boom",
      at: new Date().toISOString(),
      parkAfter: 1,
    });
    expect(r.store.isWorkerParked(7)).toBe(true);
    expect((await r.mgr.grant(7)).ok).toBe(true);
  });

  it("leaves nothing behind when tmux cannot start the pi", async () => {
    const r = rig();
    r.host.failNewSession = true;
    const res = await r.mgr.grant(7);
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/failed/) });
    expect(r.store.hostLease(7)).toBeUndefined();
    expect(r.mgr.hostGate(7)).toBeNull();
    expect(
      readdirSync(join(r.runDir, "takeover")).filter((f) => f.endsWith(".lease.json")),
    ).toEqual([]);
  });
});

describe("[P8.13] the lease and a worker refuse each other", () => {
  it("the worker is refused while the lease is held, and its command waits", async () => {
    const r = rig();
    upsert(r.store, 7);
    const log: string[] = [];
    const { sup, submit } = supervisorOver(r, log);
    expect((await r.mgr.grant(7)).ok).toBe(true);
    const row = submit(); // a round handed off in the instant before the grant won
    await expect(sup.launch(row.id)).rejects.toThrow(WorkerLaunchError);
    await expect(sup.launch(row.id)).rejects.toThrow(/takeover lease/);
    expect(await sup.launchPending()).toEqual([]);
    expect(log).toEqual([]);
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
  });

  it("after release the pi is gone before the next worker spawns; a still-alive pi blocks the spawn", async () => {
    const r = rig();
    upsert(r.store, 7);
    const log: string[] = [];
    const { sup, submit } = supervisorOver(r, log);
    r.host.immortalNext = true; // a pi the kernel cannot end
    expect((await r.mgr.grant(7)).ok).toBe(true);
    const row = submit();

    const stuck = await r.mgr.release(7);
    expect(stuck).toMatchObject({ ok: false, reason: expect.stringMatching(/still running/) });
    // the kill was tried: TERM, then KILL to the group
    expect(r.host.signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
    // the lease stands (ending) and so does the gate: still no worker
    expect(r.store.hostLease(7)).toMatchObject({ state: "ending" });
    await expect(sup.launch(row.id)).rejects.toThrow(/lease/);
    expect(await sup.launchPending()).toEqual([]);
    expect(log).toEqual([]);
    // a sweep while it lives frees nothing
    expect((await r.mgr.sweep()).stuck).toEqual([7]);
    expect(r.store.hostLease(7)).toBeDefined();

    // the process finally dies: the next sweep confirms it and frees the lease
    for (const p of r.host.procs.values()) p.immortal = false;
    r.host.signal(-r.host.procs.keys().next().value!, "SIGKILL");
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.store.hostLease(7)).toBeUndefined();
    const started = await sup.launch(row.id);
    expect(started.command_id).toBe(row.id);
    // the only spawn came after the last pi was gone
    expect(log).toEqual(["spawn(pis alive: 0)"]);
  });

  it("a release frees the lease only once the process is confirmed gone, and a clean one does so at once", async () => {
    const r = rig();
    expect((await r.mgr.grant(7)).ok).toBe(true);
    const pid = r.host.sessions.get("takeover-pr-7")!.pid;
    const res = await r.mgr.release(7);
    expect(res).toMatchObject({ ok: true });
    expect(r.host.procs.get(pid)!.alive).toBe(false);
    expect(r.store.hostLease(7)).toBeUndefined();
    expect(r.capabilities.get(r.store.hostLeases()[0]?.command_id ?? "none")).toBeUndefined();
    expect(
      readdirSync(join(r.runDir, "takeover")).filter((f) => f.endsWith(".lease.json")),
    ).toEqual([]);
    expect(await r.mgr.release(7)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no takeover lease/),
    });
  });

  it("a stubborn pi that dies on the KILL is released", async () => {
    const r = rig();
    r.host.stubbornNext = true;
    expect((await r.mgr.grant(7)).ok).toBe(true);
    expect(await r.mgr.release(7)).toMatchObject({ ok: true });
    expect(r.host.signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(r.host.alivePis()).toBe(0);
  });
});

describe("[P8.13] the lease holds dispatch and parks wakes", () => {
  it("holds a wake in pending_wakes; the release delivers it", async () => {
    const delivered: string[] = [];
    const inject = async (_pr: number, message: string): Promise<void> => {
      delivered.push(message);
    };
    const r = rig({
      afterRelease: async (pr) => {
        await flushHeldWakes({ store: r.store, inject }, pr);
      },
    });
    upsert(r.store, 7);
    expect((await r.mgr.grant(7)).ok).toBe(true);

    expect(
      await wakeOrHold({ store: r.store, inject }, 7, "the author replied", "author_reply"),
    ).toBe("held");
    expect(
      await wakeOrHold({ store: r.store, inject }, 7, "a recheck", "recheck:ci", {
        holdOnFailure: true,
      }),
    ).toBe("held");
    expect(delivered).toEqual([]);
    expect(r.store.heldWakes(7)).toHaveLength(2);
    // a flush does not push into the operator's session either
    expect(await flushHeldWakes({ store: r.store, inject }, 7)).toBe(0);
    expect(delivered).toEqual([]);

    expect(await r.mgr.release(7)).toMatchObject({ ok: true });
    expect(delivered.join("\n")).toContain("the author replied");
    expect(r.store.heldWakes(7)).toHaveLength(0);
    // and with the lease gone a wake goes straight in
    expect(await wakeOrHold({ store: r.store, inject }, 7, "later", "author_reply")).toBe(
      "injected",
    );
  });

  it(
    "the dispatch pump starts no round for the PR until the release",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const r = rig();
      upsert(r.store, 7, "queued");
      const orders: unknown[] = [];
      const hooks = {
        async dispatchRound(order: unknown) {
          orders.push(order);
        },
        async inject() {},
        async archiveAndClose() {},
      };
      class Adapter implements DispatchAdapter {
        async getPr(): Promise<{ base_ref: string }> {
          return { base_ref: "master" };
        }
        async listPrFiles() {
          return [{ filename: "src/app.ts", additions: 5, deletions: 1, status: "modified" }];
        }
        async addLabel(): Promise<GateResult> {
          return { executed: false, dryRunFile: "x" };
        }
        async removeLabel(): Promise<GateResult> {
          return { executed: false, dryRunFile: "x" };
        }
        async deleteTeamReviewRequest(): Promise<GateResult> {
          return { executed: false, dryRunFile: "x" };
        }
        async createReview(): Promise<GateResult> {
          return { executed: false, dryRunFile: "x" };
        }
      }
      expect((await r.mgr.grant(7)).ok).toBe(true);
      expect(
        await dispatchOnce({ cfg: CFG, store: r.store, adapter: new Adapter(), hooks }),
      ).toEqual([]);
      expect(orders).toHaveLength(0);
      expect((await r.mgr.release(7)).ok).toBe(true);
      const dispatched = await dispatchOnce({
        cfg: CFG,
        store: r.store,
        adapter: new Adapter(),
        hooks,
      });
      expect(dispatched).toHaveLength(1);
      expect(orders).toHaveLength(1);
    },
  );
});

describe("[P8.13] the lease expires after 30 minutes idle", () => {
  it("ends at 30 minutes without activity (fake clock), and kills the pi first", async () => {
    const r = rig();
    expect((await r.mgr.grant(7)).ok).toBe(true);
    const pid = r.host.sessions.get("takeover-pr-7")!.pid;
    r.host.clock += 29 * MIN + 59_000;
    expect(await r.mgr.sweep()).toEqual({ released: [], stuck: [] });
    expect(r.store.hostLease(7)).toMatchObject({ state: "held" });
    r.host.clock += 1_000;
    expect(await r.mgr.sweep()).toEqual({ released: [7], stuck: [] });
    expect(r.host.procs.get(pid)!.alive).toBe(false);
    expect(r.store.hostLease(7)).toBeUndefined();
  });

  it("activity in the pane keeps the lease; the clock restarts from it", async () => {
    const r = rig();
    expect((await r.mgr.grant(7)).ok).toBe(true);
    r.host.clock += 25 * MIN;
    r.host.activity.set("takeover-pr-7", r.host.clock); // the operator typed
    r.host.clock += 25 * MIN; // 50 minutes since the grant, 25 since the last key
    expect((await r.mgr.sweep()).released).toEqual([]);
    r.host.clock += 5 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([7]);
  });

  it("a pi the operator quit frees the lease at the next sweep", async () => {
    const r = rig();
    expect((await r.mgr.grant(7)).ok).toBe(true);
    r.host.die(r.host.sessions.get("takeover-pr-7")!.pid);
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.store.hostLease(7)).toBeUndefined();
  });

  it("a tmux that cannot be asked decides nothing", async () => {
    const r = rig();
    expect((await r.mgr.grant(7)).ok).toBe(true);
    const broken = r.manager({
      tmux: new Tmux({ exec: async () => ({ code: 1, stdout: "", stderr: "permission denied" }) }),
    });
    r.host.clock += 2 * 60 * MIN;
    expect(await broken.sweep()).toEqual({ released: [], stuck: [] });
    expect(r.store.hostLease(7)).toBeDefined();
  });

  it("a daemon restart ends every takeover and frees it once the pi is gone", async () => {
    const r = rig();
    expect((await r.mgr.grant(7)).ok).toBe(true);
    const reborn = r.manager(); // the new daemon: same store, same disk, no memory
    expect(await reborn.recover()).toEqual({ released: [7], stuck: [] });
    expect(r.host.alivePis()).toBe(0);
    expect(r.store.hostLease(7)).toBeUndefined();
  });
});

describe("[P8.13] the daemon refuses every post for a PR under the lease", () => {
  let po: Rig;
  const clients: IpcClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await po?.server.stop();
  });

  it("a post.review from the takeover's command is refused at the daemon, and nothing is sent", async () => {
    po = await buildRig(false, clients);
    const store = po.store;
    const host = new FakeHost();
    const runDir = join(dir, "run");
    const mgr = new TakeoverManager({
      store,
      capabilities: po.caps,
      launchFiles: new LaunchFiles({ capsDir: capsDirOf(join(dir, "st")), store: po.caps }),
      runDir,
      socketPath: po.sock,
      tmux: new Tmux({ exec: host.exec }),
      plan: planFor(join(dir, "root")),
      launcherMain: "/l.js",
      takeoverMain: "/t.js",
      nodeBin: "/usr/bin/node",
      proc: host.proc,
      signal: host.signal,
      now: () => host.clock,
      sleep: async (ms) => {
        host.clock += ms;
      },
    });
    // the server asks the takeover manager for the takeover's command
    const original = po.rows.get.bind(po.rows);
    po.rows.get = (id) => composeLookups(mgr.lookup, (x) => original(x) ?? null)(id) ?? undefined;
    expect((await mgr.grant(PR)).ok).toBe(true);
    const commandId = store.hostLease(PR)!.command_id;

    const body = po.write(`pr-${PR}-x.md`, "x");
    const shim = await po.connect(commandId);
    for (const [op, ask] of [
      ["post.review", { pr: PR, body_file: body, event: "COMMENT" }],
      ["post.approval", { pr: PR, body_file: body }],
      ["post.reply", { pr: PR, comment_id: 1, body_file: body }],
    ] as const)
      await expect(shim.request(op, ask, { pr: PR })).rejects.toMatchObject({
        code: "lease_takeover",
      });
    expect(po.gh.posts()).toEqual([]);
    expect(existsSync(join(po.state, "dryrun"))).toBe(false);

    // once released the capability is revoked: the command cannot even connect
    expect((await mgr.release(PR)).ok).toBe(true);
    expect(po.caps.get(commandId)).toBeUndefined();
    await expect(po.connect(commandId, { capability: "0".repeat(32) })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("bash-guard blocks the post scripts under the takeover policy and still allows the reading ones", () => {
    const root = join(dir, "sandbox");
    mkdirSync(root, { recursive: true });
    type Handler = (e: unknown, ctx: unknown) => unknown;
    const handlerOf = (noPost: boolean): Handler => {
      let h: Handler | undefined;
      void createBashGuard({ sandboxRoot: root, replay: false, noPost, secretDirs: [] })({
        on: (name: string, fn: Handler) => {
          if (name === "tool_call") h = fn;
        },
      } as never);
      return h!;
    };
    const run = (h: Handler, command: string): unknown =>
      h({ toolName: "bash", input: { command } }, { cwd: root });
    const takeover = handlerOf(true);
    const round = handlerOf(false);
    for (const script of [
      "scripts/post-review.sh 7 body.md",
      "scripts/approve-pr.sh 7 body.md",
      "scripts/reply-thread.sh 7 1 body.md",
      "bash scripts/post-review.sh 7 body.md",
      `bash -x scripts/approve-pr.sh 7 body.md`,
    ]) {
      expect(run(takeover, script), script).toMatchObject({
        block: true,
        reason: expect.stringMatching(/takeover posts nothing/),
      });
      // the same command is the round's job: sanctioned there
      expect(run(round, script), script).toBeUndefined();
    }
    for (const read of [
      "scripts/pr-context.sh 7",
      "scripts/pr-threads.sh 7",
      "scripts/pr-checks.sh 7",
      "git log -3",
      "gh pr view 7",
    ])
      expect(run(takeover, read), read).toBeUndefined();
    // a raw gh post is still refused, as on every route
    expect(run(takeover, "gh pr review 7 --approve")).toMatchObject({ block: true });
  });
});

describe("[P8.13] the operator's verbs", () => {
  it("takeover and release are served by the manager through the operator control route", async () => {
    const r = rig();
    const control = workerOperatorControl({
      supervisor: {
        control: async () => ({ ok: false, reason: "n/a" }),
        abortRound: async () => ({ ok: false, reason: "n/a" }),
      },
      takeover: r.mgr,
    });
    const granted = await control({ command: "takeover", pr: 7 }, "f");
    expect(granted).toMatchObject({ ok: true, ack: "handled", session: "takeover-pr-7" });
    expect(await control({ command: "takeover", pr: 7 }, "f")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already/),
    });
    expect(await control({ command: "release", pr: 7 }, "f")).toMatchObject({
      ok: true,
      ack: "handled",
    });
    expect(await control({ command: "release", pr: 7 }, "f")).toMatchObject({ ok: false });
  });

  it("qcr takeover and qcr release take exactly one PR number", () => {
    expect(parseTakeoverArgs(["12"])).toBe(12);
    for (const bad of [[], ["x"], ["0"], ["1", "2"], ["-3"]])
      expect(() => parseTakeoverArgs(bad)).toThrow(/usage/);
    expect(takeoverAttachLines(12).join("\n")).toContain("tmux attach -t takeover-pr-12");
  });

  it("names the pane the way the TUI looks for it", () => {
    expect(takeoverSession(12)).toBe("takeover-pr-12");
  });

  it("plans a PR from the daemon's layout, and refuses one with no JSONL", () => {
    const plan = takeoverPlanFor({
      root: "/r",
      agentDir: "/r/pihome/agent",
      sessionsRoot: "/r/state/pi-sessions",
      model: "m",
      pr: 7,
      newestSessionFile: (d) =>
        d === "/r/state/pi-sessions/pr-7" ? "/r/state/pi-sessions/pr-7/a.jsonl" : undefined,
    });
    expect(plan).toMatchObject({
      session_file: "/r/state/pi-sessions/pr-7/a.jsonl",
      extensions: ["/r/extensions/cli/bash-guard.ts"],
    });
    expect(() =>
      takeoverPlanFor({
        root: "/r",
        agentDir: "/a",
        sessionsRoot: "/r/s",
        model: "m",
        pr: 8,
        newestSessionFile: () => undefined,
      }),
    ).toThrow(/nothing to take over/);
  });
});
