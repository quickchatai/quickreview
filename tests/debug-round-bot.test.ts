// The bot's debug round: a PR's next round runs inside interactive pi.
//
// A FAKE host stands in for tmux and the process table (tests/helpers/fake-pane-host.ts):
// sessions, pids with start times and process groups, signals that kill (or are ignored,
// or cannot kill), and a clock the test moves. The state store, the host lease, the
// capability, the launch file, the supervisor's gate, the worker host, the wakes, the
// dispatch pump, the IPC server and the post ops (through the one MutationGate, in
// dry-run) are the real ones. No pi, no model, no network.
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerOperatorControl } from "../src/workercontrol.js";
import { debugRoundAttachLines, parseTakeoverArgs } from "../src/cli.js";
import { parseConfig, type Config } from "../src/config.js";
import {
  DEBUG_IDLE_MS,
  DEBUG_STATUS_NAME,
  DEBUG_VERDICT_SETTLE_MS,
  DebugRoundManager,
  debugSession,
  type DebugRoundSpec,
} from "../src/debuground.js";
import type { PrSessionHost } from "../src/pr-session-lifecycle.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  CapabilityStore,
  LaunchFiles,
  capsDirOf,
  createCapabilityFd,
  ipcEnv,
} from "../src/ipc/capability.js";
import type { IpcClient } from "../src/ipc/client.js";
import { runPostShim } from "../src/ipc/postshim.js";
import type { WorkerSpec } from "../src/ipc/workerspec.js";
import { newestSessionFile } from "../src/sessionjsonl.js";
import { sessionCommandMarker } from "@quickchatai/pi-quickreview/src/session-command.js";
import { StateStore, type SessionCommandRow } from "../src/state.js";
import { TakeoverManager, composeHostGates, composeLookups } from "../src/takeover.js";
import { Tmux } from "../src/tmux.js";
import { flushHeldWakes, wakeOrHold } from "../src/wakes.js";
import { runtimeOfPr } from "../src/workerruntime.js";
import { WorkerSessionHost } from "../src/worker-session-host.js";
import { WorkerLaunchError, WorkerSupervisor } from "../src/workersupervisor.js";
import { WorktreeManager } from "../src/worktrees.js";
import type { RoundOrder } from "@quickchatai/pi-quickreview/src/types.js";
import { FakePaneHost } from "./helpers/fake-pane-host.js";
import { COMMENTS, HEAD, PR, buildRig, dryrunRecords, type Rig } from "./helpers/post-ops-rig.js";
import { HOST_NOW, trackPr } from "./helpers/session-hooks-host.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const CFG: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const MIN = 60_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "debug-round-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ORDER: RoundOrder = {
  pr: 7,
  title: "Add rate limiting",
  round_id: 1,
  round_no: 1,
  round_type: "first",
  lenses: ["pass-baseline"],
  pass_plan: [{ lens: "pass-baseline", agent: "pass-baseline", tier: "sol-med", raisable_to: [] }],
  addable_lenses: [],
  base_ref: "master",
  base_sha: "base123",
  merge_base: "base123",
  migration_gate: false,
  head_sha: "abc123",
  worktree: "wt/pr-7",
  settled_digest: "",
  issued_at: "2026-08-13T10:00:00Z",
};
const BODY = "ROUND PROMPT BODY";

/** The worker spec a round of this command would be given. */
const specOf =
  (root: string) =>
  (row: SessionCommandRow, mode: "round" | "answer" = "round"): WorkerSpec => ({
    mode,
    command_id: row.id,
    pr: row.pr,
    session: row.session,
    round_no: row.round_no,
    payload_path: row.payload_path,
    payload_sha256: row.payload_sha256,
    root,
    cwd: root,
    agent_dir: join(root, "agent"),
    session_dir: join(root, "state", "pi-sessions", row.session),
    system_prompt_file: join(root, "prompts", "system.md"),
    model: "faux/faux-1",
    env: { PATH: "/usr/bin", HOME: join(root, "home"), QCR_SESSION_NAME: row.session },
    events_file: join(root, "state", "live", `${row.session}.jsonl`),
    stderr_file: join(root, "state", "workers", `${row.id}.err`),
    wall_clock_ms: 600_000,
    planned_wave: false,
  });

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
    afterRelease?: (pr: number) => Promise<void> | void;
    store?: StateStore;
    capabilities?: CapabilityStore;
    socketPath?: string;
  } = {},
) {
  const root = join(dir, "root");
  const runDir = join(dir, "run");
  for (const d of ["state", "verdict", "prompts", "agent", "secrets"])
    mkdirSync(join(root, d), { recursive: true });
  const store = o.store ?? new StateStore(":memory:", () => HOST_NOW);
  const capabilities = o.capabilities ?? new CapabilityStore();
  const launchFiles = new LaunchFiles({ capsDir: capsDirOf(join(dir, "st")), store: capabilities });
  const host = new FakePaneHost();
  const spawned: string[] = [];
  let mgr!: DebugRoundManager;
  const supervisor = new WorkerSupervisor({
    store,
    capabilities,
    runDir,
    socketPath: o.socketPath ?? join(runDir, "q.sock"),
    workerMain: "/opt/qcr/dist/src/botworker.js",
    logDir: join(dir, "logs"),
    payloadDir: join(dir, "payloads"),
    buildSpec: specOf(root),
    parentEnv: { PATH: "/usr/bin" },
    hostGate: (pr) => mgr.hostGate(pr),
    proc: host.proc,
    signal: host.signal,
    spawn: (() => {
      spawned.push(`spawn(pis alive: ${host.alivePis()})`);
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 55_555;
      return child;
    }) as never,
  });
  const manager = (extra: Partial<ConstructorParameters<typeof DebugRoundManager>[0]> = {}) =>
    new DebugRoundManager({
      store,
      commands: supervisor,
      capabilities,
      launchFiles,
      runDir,
      socketPath: o.socketPath ?? join(runDir, "q.sock"),
      tmux: new Tmux({ exec: host.exec }),
      gate: (pr) => supervisor.breaker.gate(pr),
      buildSpec: (row) => specOf(root)(row),
      newestSessionFile,
      launcherMain: "/opt/qcr/dist/src/ipc/launcher.js",
      debugMain: "/opt/qcr/dist/src/debugroundpi.js",
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
  mgr = manager();
  const worktrees = new WorktreeManager({
    root,
    repo: "o/n",
    cloneDir: "example-app",
    cloneUrl: "/dev/null",
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  const hostFor = (debugRounds: DebugRoundManager) =>
    new WorkerSessionHost({
      cfg: CFG,
      root,
      worktrees,
      store,
      supervisor,
      debugRounds,
      ovSessions: { create: async () => true, remove: async () => true },
      now: () => HOST_NOW,
      log: () => {},
    });
  return {
    root,
    runDir,
    store,
    capabilities,
    launchFiles,
    host,
    supervisor,
    spawned,
    manager,
    mgr,
    worker: hostFor(mgr),
    hostFor,
  };
}
type Rg = ReturnType<typeof rig>;

/** A round for PR `pr` and the order the dispatch pump would hand the host. */
async function dispatch(r: Rg, pr = 7): Promise<SessionCommandRow> {
  trackPr(r.store, pr);
  r.store.startRound(pr, "first", ["pass-baseline"], 75);
  await r.worker.dispatchRound({ ...ORDER, pr, worktree: `wt/pr-${pr}` }, BODY);
  return r.store.activeSessionCommand(`pr-${pr}`)!;
}

const verdictFile = (r: Rg, pr = 7, round = 1): string =>
  join(r.root, "verdict", `pr-${pr}-round-${round}.json`);

describe("arming the lease", () => {
  it("takes the lease in debug mode and starts no pi until the round arrives", async () => {
    const r = rig();
    upsert(r.store, 7);
    const res = await r.mgr.arm(7, "owner");
    expect(res).toMatchObject({ ok: true, session: "debug-pr-7" });
    expect(r.store.hostLease(7)).toMatchObject({
      pr: 7,
      kind: "debug",
      state: "held",
      holder: "owner",
    });
    expect(r.host.sessions.size).toBe(0);
    // status.json's runtime
    expect(runtimeOfPr(7, { workers: () => [], lease: (pr) => r.mgr.leaseOf(pr) })).toBe("debug");
    expect(runtimeOfPr(8, { workers: () => [], lease: (pr) => r.mgr.leaseOf(pr) })).toBe("idle");
    // no worker starts beside it
    expect(r.mgr.hostGate(7)).toMatch(/debug lease/);
  });

  it("is refused under a drain with the reason `drained`, and the lease is not taken", async () => {
    const r = rig();
    upsert(r.store, 7);
    r.store.engageDrain({ issuer: "operator", expires_at: null });
    const res = await r.mgr.arm(7);
    expect(res).toMatchObject({
      ok: false,
      code: "drained",
      reason: expect.stringMatching(/^drained/),
    });
    expect(r.store.hostLease(7)).toBeUndefined();
    // the operator's verb says the same
    const control = workerOperatorControl({
      supervisor: {
        control: async () => ({ ok: false, reason: "n/a" }),
        abortRound: async () => ({ ok: false, reason: "n/a" }),
      },
      debug: r.mgr,
    });
    expect(await control({ command: "debug-round", pr: 7 }, "f")).toMatchObject({
      ok: false,
      code: "drained",
    });
  });

  it("is refused for a parked PR", async () => {
    const r = rig();
    upsert(r.store, 7);
    r.store.recordWorkerFailure(7, {
      commandId: "x",
      error: "boom",
      at: new Date().toISOString(),
      parkAfter: 1,
    });
    expect(r.store.isWorkerParked(7)).toBe(true);
    expect(await r.mgr.arm(7)).toMatchObject({ ok: false, code: "parked" });
    expect(r.store.hostLease(7)).toBeUndefined();
  });

  it("is granted a takeover under the same drain, because a takeover never posts", async () => {
    const r = rig();
    upsert(r.store, 7);
    r.store.engageDrain({ issuer: "operator", expires_at: null });
    const takeover = new TakeoverManager({
      store: r.store,
      capabilities: r.capabilities,
      launchFiles: r.launchFiles,
      runDir: r.runDir,
      socketPath: join(r.runDir, "q.sock"),
      tmux: new Tmux({ exec: r.host.exec }),
      plan: () => ({
        root: r.root,
        cwd: r.root,
        agent_dir: join(r.root, "agent"),
        session_file: join(r.root, "s.jsonl"),
        model: "faux/faux-1",
        extensions: [],
        env: {},
      }),
      launcherMain: "/l.js",
      takeoverMain: "/t.js",
      nodeBin: "/usr/bin/node",
      proc: r.host.proc,
      signal: r.host.signal,
      now: () => r.host.clock,
    });
    expect(await r.mgr.arm(7)).toMatchObject({ ok: false, code: "drained" });
    expect(await takeover.grant(7)).toMatchObject({ ok: true, session: "takeover-pr-7" });
    // and once the drain lifts a debug round is refused beside the takeover
    r.store.liftDrain("operator");
    expect(await r.mgr.arm(7)).toMatchObject({ ok: false, code: "leased" });
  });

  it("is refused while a worker runs, however it is seen, and for a PR it does not know", async () => {
    const a = rig();
    upsert(a.store, 7);
    a.store.createSessionCommand({
      id: "c1",
      pr: 7,
      session: "pr-7",
      kind: "wake",
      round_no: null,
      payload_sha256: "a".repeat(64),
      payload_path: join(dir, "p.md"),
      inject_path: "worker:c1",
      next_check_at: new Date().toISOString(),
    });
    expect(await a.mgr.arm(7)).toMatchObject({ ok: false, code: "worker" });
    expect(a.store.hostLease(7)).toBeUndefined();
    const b = rig({ workerRuns: () => true });
    upsert(b.store, 7);
    expect(await b.mgr.arm(7)).toMatchObject({ ok: false, code: "worker" });
    const c = rig({ workerRuns: () => null });
    upsert(c.store, 7);
    expect(await c.mgr.arm(7)).toMatchObject({ ok: false, code: "worker" });
    const d = rig();
    expect(await d.mgr.arm(9)).toMatchObject({ ok: false, code: "unknown_pr" });
    upsert(d.store, 9);
    expect((await d.mgr.arm(9)).ok).toBe(true);
    expect(await d.mgr.arm(9)).toMatchObject({ ok: false, code: "leased" });
  });
});

describe("the round is delivered to interactive pi, not to a worker", () => {
  it("hands the dispatched round to tmux debug-pr-<n> on a spec file; no worker spawns", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7, "owner")).ok).toBe(true);
    const row = await dispatch(r);

    // the round's own command, claimed by the lease: one id, one generation
    const lease = r.store.hostLease(7)!;
    expect(row).toMatchObject({
      kind: "round",
      status: "running",
      attempt: 1,
      owner_token: lease.token,
    });
    expect(r.spawned).toEqual([]);
    expect(r.supervisor.runs("pr-7")).toBe(false);
    expect([...r.host.sessions.keys()]).toEqual(["debug-pr-7"]);

    // the pane runs the launcher (claims the capability), then the pane's entry on a spec file
    const { cmd, cwd } = r.host.sessions.get("debug-pr-7")!;
    expect(cwd).toBe(r.root);
    expect(cmd.slice(0, 5)).toEqual([
      "/usr/bin/node",
      "/opt/qcr/dist/src/ipc/launcher.js",
      expect.stringMatching(/\.cap$/),
      "--",
      "/usr/bin/node",
    ]);
    expect(cmd[5]).toBe("/opt/qcr/dist/src/debugroundpi.js");
    const spec = JSON.parse(readFileSync(cmd[6]!, "utf8")) as DebugRoundSpec;
    expect(spec).toMatchObject({
      pr: 7,
      session: "debug-pr-7",
      command_id: row.id,
      round_no: 1,
      payload_path: row.payload_path,
      payload_sha256: row.payload_sha256,
      marker: sessionCommandMarker(row.id, row.payload_sha256),
      idle_ms: DEBUG_IDLE_MS,
      session_dir: join(r.root, "state", "pi-sessions", "pr-7"),
    });
    // a PR with no JSONL gets one born; the pi's extensions carry the lens tools
    expect(spec.session_file).toBeUndefined();
    expect(spec.extensions.map((e) => e.slice(r.root.length + 1))).toEqual([
      "extensions/cli/bash-guard.ts",
      "extensions/cli/ledger-pin.ts",
      "extensions/cli/debug-round.ts",
      "packages/pi-plugin/extensions/finding-clusters.ts",
      "extensions/vendor/openviking-pi/index.ts",
    ]);
    // the post shims' names are in the env, the secret is not; no GitHub token of any name
    expect(spec.env).toMatchObject({
      QCR_IPC_COMMAND_ID: row.id,
      QCR_IPC_GENERATION: "1",
      QCR_IPC_CAP_FD: "3",
      QCR_PR: "7",
      QCR_SANDBOX_ROOT: r.root,
    });
    const cap = r.capabilities.get(row.id)!;
    expect(cap).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(spec)).not.toContain(cap);
    expect(JSON.stringify(spec)).not.toMatch(/GITHUB_TOKEN|GH_TOKEN/);
    expect(r.launchFiles.outstanding()).toBe(1);

    // the host-level view: the round is the command's, the lease's, and debug
    expect(r.mgr.lookup(row.id)).toEqual({
      pr: 7,
      generation: 1,
      active: true,
      may_post: true,
      lease: "debug",
    });
    expect(r.mgr.lookup("unknown")).toBeNull();
    expect(runtimeOfPr(7, { workers: () => [], lease: (pr) => r.mgr.leaseOf(pr) })).toBe("debug");
  });

  it("uses the PR's own JSONL when it has one", async () => {
    const r = rig();
    upsert(r.store, 7);
    const sessions = join(r.root, "state", "pi-sessions", "pr-7");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), '{"type":"session","id":"abc"}\n');
    expect((await r.mgr.arm(7)).ok).toBe(true);
    await dispatch(r);
    const spec = JSON.parse(
      readFileSync(r.host.sessions.get("debug-pr-7")!.cmd[6]!, "utf8"),
    ) as DebugRoundSpec;
    expect(spec.session_file).toBe(join(sessions, "s.jsonl"));
  });

  it(
    "the dispatch pump hands the round out under a debug lease",
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
      expect((await r.mgr.arm(7)).ok).toBe(true);
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

  it("takes a round order that was already waiting when the lease was armed", async () => {
    const r = rig();
    upsert(r.store, 7);
    trackPr(r.store, 7);
    const round = r.store.startRound(7, "first", ["pass-baseline"], 75);
    expect(round).toBeGreaterThan(0);
    const roundNo = r.store.roundsFor(7)[0]!.round_no;
    const waiting = r.supervisor.submit({
      pr: 7,
      kind: "round",
      round_no: roundNo,
      payload: "ORDER",
    });
    expect(waiting.status).toBe("pending");
    const res = await r.mgr.arm(7);
    expect(res).toMatchObject({ ok: true, message: expect.stringMatching(/started/) });
    expect(r.store.getSessionCommand(waiting.id)).toMatchObject({
      status: "running",
      owner_token: r.store.hostLease(7)!.token,
    });
    expect([...r.host.sessions.keys()]).toEqual(["debug-pr-7"]);
  });

  it("holds the order while a drain stands, and delivers it once it lifts", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    r.store.engageDrain({ issuer: "operator", expires_at: null });
    const row = await dispatch(r);
    // the order waits, as it would for a worker; the lease stays armed
    expect(row).toMatchObject({ status: "pending" });
    expect(r.host.sessions.size).toBe(0);
    expect(await r.mgr.sweep()).toMatchObject({ delivered: [] });
    expect(r.host.sessions.size).toBe(0);
    // the drain lifts: the sweep delivers the waiting order to the armed lease's pi
    r.store.liftDrain("operator");
    expect(await r.mgr.sweep()).toMatchObject({ delivered: [7] });
    expect([...r.host.sessions.keys()]).toEqual(["debug-pr-7"]);
    expect(r.store.getSessionCommand(row.id)).toMatchObject({ status: "running" });
  });

  it("logs why a sweep could not deliver the waiting order, once per distinct reason", async () => {
    const lines: string[] = [];
    const r = rig();
    const mgr = r.manager({ log: (m) => lines.push(m) });
    upsert(r.store, 7);
    expect((await mgr.arm(7)).ok).toBe(true);
    r.store.engageDrain({ issuer: "operator", expires_at: null });
    await dispatch(r);
    lines.length = 0;
    await mgr.sweep();
    await mgr.sweep();
    expect(lines.filter((l) => l.includes("#7") && l.includes("not delivered"))).toHaveLength(1);
    r.store.liftDrain("operator");
    expect(await mgr.sweep()).toMatchObject({ delivered: [7] });
  });

  it("leaves nothing behind when tmux cannot start the pi: the order goes back to pending", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    r.host.failNewSession = true;
    const row = await dispatch(r);
    expect(row).toMatchObject({ status: "pending", owner_token: null });
    expect(r.store.hostLease(7)).toBeUndefined();
    expect(r.mgr.hostGate(7)).toBeNull();
    expect(readdirSync(join(r.runDir, "debug")).filter((f) => f.endsWith(".lease.json"))).toEqual(
      [],
    );
    expect(r.capabilities.get(row.id)).toBeUndefined();
    // a worker may take it now
    expect((await r.supervisor.launch(row.id)).command_id).toBe(row.id);
  });
});

describe("a PR that closes under a debug round", () => {
  it("stops the debug pi and frees the lease before its session counts as gone", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7, "owner")).ok).toBe(true);
    await dispatch(r);
    expect([...r.host.sessions.keys()]).toEqual(["debug-pr-7"]);
    r.store.db.prepare("UPDATE pr_state SET state = 'closed' WHERE number = 7").run();

    await r.worker.lifecycle.archiveAndClose(7);

    expect(r.host.sessions.size).toBe(0);
    expect(r.store.hostLease(7)).toBeUndefined();
  });

  it("is not proven gone while the debug lease holds the session", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7, "owner")).ok).toBe(true);
    r.store.db.prepare("UPDATE pr_state SET state = 'closed' WHERE number = 7").run();
    const live = await (r.worker as unknown as { workerHost(): PrSessionHost })
      .workerHost()
      .liveSessions();

    expect(live).toEqual(["pr-7"]);
  });
});

describe("the round ends with the verdict commit", () => {
  it("marks the round started when the order went out, then ends it after the verdict and a quiet pane", async () => {
    const delivered: string[] = [];
    const r = rig({
      afterRelease: async (pr) => {
        delivered.push(`after:${pr}`);
      },
    });
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);
    const pid = r.host.sessions.get("debug-pr-7")!.pid;
    expect(await r.worker.roundPromptAccepted(7, 1, 0)).toBeNull();

    // the extension wrote order_sent_at: the receipt the silent-round net reads
    const status = join(dir, "run", "debug", "debug-pr-7.agent", DEBUG_STATUS_NAME);
    mkdirSync(join(dir, "run", "debug", "debug-pr-7.agent"), { recursive: true });
    writeFileSync(
      status,
      JSON.stringify({ state: "started", order_sent_at: "2026-10-19T09:00:05Z" }),
    );
    expect(await r.mgr.sweep()).toEqual({ released: [], stuck: [], delivered: [] });
    expect(await r.worker.roundPromptAccepted(7, 1, 0)).toBe(true);
    expect(r.store.getSessionCommand(row.id)!.started_at).not.toBeNull();

    // the verdict is committed: the pane is given a moment for the model's closing words
    writeFileSync(verdictFile(r), "{}");
    r.host.clock += 1_000;
    expect((await r.mgr.sweep()).released).toEqual([]);
    expect(r.host.procs.get(pid)!.alive).toBe(true);
    r.host.activity.set("debug-pr-7", r.host.clock); // the model is still talking
    r.host.clock += DEBUG_VERDICT_SETTLE_MS - 1_000;
    expect((await r.mgr.sweep()).released).toEqual([]);
    r.host.clock += 2_000;
    expect(await r.mgr.sweep()).toEqual({ released: [7], stuck: [], delivered: [] });

    // the pi is gone, the round is served, the lease is free, the capability is dead
    expect(r.host.procs.get(pid)!.alive).toBe(false);
    expect(r.store.getSessionCommand(row.id)).toMatchObject({ status: "acked" });
    expect(r.store.hostLease(7)).toBeUndefined();
    expect(r.capabilities.get(row.id)).toBeUndefined();
    expect(delivered).toEqual(["after:7"]);
    expect(r.mgr.hostGate(7)).toBeNull();
    expect(runtimeOfPr(7, { workers: () => [], lease: (pr) => r.mgr.leaseOf(pr) })).toBe("idle");
  });

  it("the daemon's watcher moves the verdict to processed/ before the sweep: the round still ends and is acked", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);
    writeFileSync(verdictFile(r), "{}");
    mkdirSync(join(r.root, "verdict", "processed"), { recursive: true });
    renameSync(
      verdictFile(r),
      join(r.root, "verdict", "processed", "2026-10-19T09-00-00-000Z-pr-7-round-1.json"),
    );
    expect((await r.mgr.sweep()).released).toEqual([]); // seen, and latched
    r.host.clock += 2 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.store.getSessionCommand(row.id)).toMatchObject({ status: "acked" });
    expect(r.store.hostLease(7)).toBeUndefined();
  });

  it("the round row is finished and the file is gone: the round ends on that, and is acked", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);
    r.store.finishRound(r.store.roundsFor(7)[0]!.id, "approve", null);
    expect((await r.mgr.sweep()).released).toEqual([]);
    r.host.clock += 2 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.store.getSessionCommand(row.id)).toMatchObject({ status: "acked" });
    expect(r.store.hostLease(7)).toBeUndefined();
  });

  it("a verdict seen by a sweep stays committed after the file is archived, when the pi exits", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);
    writeFileSync(verdictFile(r), "{}");
    expect((await r.mgr.sweep()).released).toEqual([]);
    rmSync(verdictFile(r)); // archived somewhere the manager cannot see
    r.host.clock += 2 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.store.getSessionCommand(row.id)).toMatchObject({ status: "acked" });
  });

  it("the next round goes back to a worker, after the debug pi is gone", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const first = await dispatch(r);
    writeFileSync(verdictFile(r), "{}");
    expect((await r.mgr.sweep()).released).toEqual([]); // the verdict is seen
    r.host.clock += 2 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.store.getSessionCommand(first.id)!.status).toBe("acked");

    // round 2 of the same PR: no lease, so a worker
    r.store.startRound(7, "followup", ["pass-baseline"], 75);
    await r.worker.dispatchRound({ ...ORDER, round_id: 2, round_no: 2 }, BODY);
    expect(r.spawned).toEqual(["spawn(pis alive: 0)"]);
    expect(r.supervisor.runs("pr-7")).toBe(true);
    expect(r.host.sessions.size).toBe(0);
  });

  it("a pi that exits before the verdict hands the round back to a worker, which resumes the same command", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);
    r.host.die(r.host.sessions.get("debug-pr-7")!.pid); // the operator quit pi
    expect(await r.mgr.sweep()).toEqual({ released: [7], stuck: [], delivered: [] });
    expect(r.store.getSessionCommand(row.id)).toMatchObject({
      status: "pending",
      owner_token: null,
      recovery_attempts: 1,
    });
    expect(r.store.hostLease(7)).toBeUndefined();
    // a worker takes the same command: the debug pi is gone before it spawns
    const info = await r.supervisor.launch(row.id);
    expect(info.command_id).toBe(row.id);
    expect(r.spawned).toEqual(["spawn(pis alive: 0)"]);
    expect(r.store.getSessionCommand(row.id)).toMatchObject({ status: "running", attempt: 2 });
  });

  it("an operator's release mid-round does the same, and a still-alive pi blocks the worker", async () => {
    const r = rig();
    upsert(r.store, 7);
    r.host.immortalNext = true; // a pi the kernel cannot end
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);

    const stuck = await r.mgr.release(7);
    expect(stuck).toMatchObject({
      ok: false,
      code: "pi_alive",
      reason: expect.stringMatching(/still running/),
    });
    expect(r.host.signals.map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
    // the lease stands (ending) and so does the gate: still no worker
    expect(r.store.hostLease(7)).toMatchObject({ kind: "debug", state: "ending" });
    await expect(r.supervisor.launch(row.id)).rejects.toThrow(WorkerLaunchError);
    expect(await r.supervisor.launchPending()).toEqual([]);
    expect(r.spawned).toEqual([]);
    expect((await r.mgr.sweep()).stuck).toEqual([7]);

    // the process finally dies: the next sweep confirms it, settles the round and frees the lease
    for (const p of r.host.procs.values()) p.immortal = false;
    r.host.signal(-r.host.procs.keys().next().value!, "SIGKILL");
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.store.getSessionCommand(row.id)).toMatchObject({ status: "pending" });
    await r.supervisor.launch(row.id);
    expect(r.spawned).toEqual(["spawn(pis alive: 0)"]);
  });

  it("expires after 30 minutes without activity, armed or in a round (fake clock)", async () => {
    const armed = rig();
    upsert(armed.store, 7);
    expect((await armed.mgr.arm(7)).ok).toBe(true);
    armed.host.clock += 29 * MIN + 59_000;
    expect((await armed.mgr.sweep()).released).toEqual([]);
    armed.host.clock += 1_000;
    expect((await armed.mgr.sweep()).released).toEqual([7]);
    expect(armed.store.hostLease(7)).toBeUndefined();

    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);
    r.host.clock += 25 * MIN;
    r.host.activity.set("debug-pr-7", r.host.clock); // the operator typed
    r.host.clock += 25 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([]);
    r.host.clock += 5 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([7]);
    expect(r.host.alivePis()).toBe(0);
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
  });

  it("a tmux that cannot be asked decides nothing", async () => {
    const r = rig();
    upsert(r.store, 7);
    let broken = false;
    const exec = r.host.exec;
    const mgr = r.manager({
      tmux: new Tmux({
        exec: async (cmd, args, o) =>
          broken && args[0] === "list-sessions"
            ? { code: 1, stdout: "", stderr: "permission denied" }
            : exec(cmd, args, o),
      }),
    });
    expect((await mgr.arm(7)).ok).toBe(true);
    await r
      .hostFor(mgr)
      .dispatchRound({ ...ORDER, pr: 7 }, BODY)
      .catch(() => undefined);
    trackPr(r.store, 7);
    broken = true;
    r.host.clock += 2 * 60 * MIN;
    expect(await mgr.sweep()).toEqual({ released: [], stuck: [], delivered: [] });
    expect(r.store.hostLease(7)).toBeDefined();
  });

  it("a daemon restart ends the debug round and hands its order back to pending", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const row = await dispatch(r);
    const reborn = r.manager(); // the new daemon: same store, same disk, no memory
    expect(await reborn.recover()).toEqual({ released: [7], stuck: [], delivered: [] });
    expect(r.host.alivePis()).toBe(0);
    expect(r.store.hostLease(7)).toBeUndefined();
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
  });

  it("held wakes are parked while the debug round runs and delivered at its end", async () => {
    const injected: string[] = [];
    const inject = async (_pr: number, message: string): Promise<void> => {
      injected.push(message);
    };
    const r: Rg = rig({
      afterRelease: async (pr) => {
        await flushHeldWakes({ store: r.store, inject }, pr);
      },
    });
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    await dispatch(r);
    expect(
      await wakeOrHold({ store: r.store, inject }, 7, "the author replied", "author_reply"),
    ).toBe("held");
    expect(injected).toEqual([]);
    writeFileSync(verdictFile(r), "{}");
    // the daemon's verdict watcher ingests the verdict meanwhile: the round is done, the wakes stay parked
    r.store.finishRound(r.store.roundsFor(7)[0]!.id, "request_changes", null);
    expect(await flushHeldWakes({ store: r.store, inject }, 7)).toBe(0);
    expect((await r.mgr.sweep()).released).toEqual([]);
    r.host.clock += 2 * MIN;
    expect((await r.mgr.sweep()).released).toEqual([7]);
    // the round is acked and nothing blocks the PR any more: the wake went in
    expect(injected.join("\n")).toContain("the author replied");
  });
});

describe("a sweep does not take an earlier round's evidence or a launch in flight for this round's", () => {
  it("a status file left by the PR's previous debug round is not this round's start receipt", async () => {
    const r = rig();
    upsert(r.store, 7);
    expect((await r.mgr.arm(7)).ok).toBe(true);
    const borrow = join(dir, "run", "debug", "debug-pr-7.agent");
    mkdirSync(borrow, { recursive: true });
    const status = join(borrow, DEBUG_STATUS_NAME);
    writeFileSync(
      status,
      JSON.stringify({ state: "started", order_sent_at: "2026-10-18T09:00:05Z" }),
    );
    const row = await dispatch(r);
    await r.mgr.sweep();
    expect(r.store.getSessionCommand(row.id)!.started_at).toBeNull();
    expect(await r.worker.roundPromptAccepted(7, 1, 0)).toBeNull();
  });

  it("a sweep during the launch leaves the round alone", async () => {
    const r = rig();
    upsert(r.store, 7);
    let open!: () => void;
    const gate = new Promise<void>((res) => {
      open = res;
    });
    const gated = r.manager({
      tmux: new Tmux({
        exec: async (...a: Parameters<typeof r.host.exec>) => {
          if (a.join(" ").includes("new-session")) await gate;
          return r.host.exec(...a);
        },
      }),
    });
    expect((await gated.arm(7)).ok).toBe(true);
    const worker = r.hostFor(gated);
    trackPr(r.store, 7);
    r.store.startRound(7, "first", ["pass-baseline"], 75);
    const dispatching = worker.dispatchRound({ ...ORDER, worktree: "wt/pr-7" }, BODY);
    await new Promise((res) => setTimeout(res, 20));
    expect((await gated.sweep()).released).toEqual([]);
    expect(r.store.hostLease(7)).toBeDefined();
    open();
    await dispatching;
    expect([...r.host.sessions.keys()]).toEqual(["debug-pr-7"]);
    expect(r.store.hostLease(7)).toBeDefined();
  });
});

describe("it posts like any round: through the gate, with the install's dry_run", () => {
  let po: Rig;
  const clients: IpcClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await po?.server.stop();
  });

  /** The rig with the debug manager answering for its own commands. */
  async function poRig(opts: { keepCapability?: boolean } = {}) {
    po = await buildRig(true, clients);
    const capabilities = opts.keepCapability
      ? (Object.assign(Object.create(po.caps), { revoke: () => {} }) as CapabilityStore)
      : po.caps;
    const r = rig({ store: po.store, capabilities, socketPath: po.sock });
    upsert(po.store, PR);
    // the server asks the debug manager first, then the rig's own table
    const original = po.rows.get.bind(po.rows);
    po.rows.get = (id) => composeLookups(r.mgr.lookup, (x) => original(x) ?? null)(id) ?? undefined;
    expect((await r.mgr.arm(PR, "owner")).ok).toBe(true);
    const row = await dispatch(r, PR);
    // the post ops key the round by its command: round 1 at HEAD
    po.rounds.set(row.id, { round_no: 1, head_sha: HEAD });
    return { r, row };
  }

  /** The shim's own env, as the pane gives it: the socket, the command, the generation, and an
   * inherited fd holding the capability. */
  const shimEnv = (row: SessionCommandRow, cap: string, generation = 1) => {
    const fd = createCapabilityFd(join(dir, "fds"), cap);
    return {
      fd,
      env: {
        ...ipcEnv({ socketPath: po.sock, commandId: row.id, generation, capFdIndex: fd }),
        QCR_ROUND_NO: "1",
        QCR_EXPECTED_HEAD: HEAD,
      },
    };
  };
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    };
  };

  it("a post lands in state/dryrun/ through the gate, twice from one fd, and is refused after the release", async () => {
    const { r, row } = await poRig();
    const cap = po.caps.get(row.id)!;
    const body = po.write(`pr-${PR}-body.md`, "Round 1: one blocker.");
    const comments = po.write(`pr-${PR}-comments.json`, COMMENTS);
    const { env } = shimEnv(row, cap);

    // the real post shim, over the real socket; the capability is read from the fd
    const first = io();
    expect(
      await runPostShim("review", [String(PR), "COMMENT", body, comments], env, first.io),
    ).toBe(0);
    expect(first.err).toEqual([]);
    const records = dryrunRecords(po);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: expect.any(String) });
    expect(po.gh.posts()).toEqual([]); // dry-run: nothing was sent to GitHub
    // a second post in the same round reads the same fd again
    const reply = io();
    expect(
      await runPostShim(
        "reply",
        [String(PR), "77", po.write(`pr-${PR}-reply.md`, "ok")],
        env,
        reply.io,
      ),
    ).toBe(0);
    expect(po.gh.posts()).toEqual([]);
    expect(dryrunRecords(po).length).toBeGreaterThan(1);
    const before = dryrunRecords(po).length;

    // the release: the generation moves, the capability is revoked, the pi is killed and confirmed gone
    const pid = r.host.sessions.get("debug-pr-7")!.pid;
    expect(r.mgr.lookup(row.id)!.generation).toBe(1);
    expect((await r.mgr.release(PR)).ok).toBe(true);
    expect(r.host.procs.get(pid)!.alive).toBe(false);
    expect(r.mgr.lookup(row.id)).toMatchObject({ active: false, generation: 2 });
    expect(po.caps.get(row.id)).toBeUndefined();

    // a late post is refused, and nothing is written
    const late = io();
    expect(await runPostShim("review", [String(PR), "COMMENT", body], env, late.io)).toBe(1);
    expect(late.err.join("")).toMatch(/unauthorized|command_inactive|stale_generation/);
    expect(dryrunRecords(po)).toHaveLength(before);
    expect(po.gh.posts()).toEqual([]);
  });

  it("the generation fence alone refuses a late post, with the capability still live", async () => {
    const { r, row } = await poRig({ keepCapability: true });
    const cap = po.caps.get(row.id)!;
    const body = po.write(`pr-${PR}-body.md`, "x");
    const { env } = shimEnv(row, cap);
    const before = io();
    expect(await runPostShim("review", [String(PR), "COMMENT", body], env, before.io)).toBe(0);
    const count = dryrunRecords(po).length;

    expect((await r.mgr.release(PR)).ok).toBe(true);
    // the capability was NOT revoked (the store here ignores it): the lookup refuses
    expect(po.caps.get(row.id)).toBe(cap);
    const late = io();
    expect(await runPostShim("review", [String(PR), "COMMENT", body], env, late.io)).toBe(1);
    expect(late.err.join("")).toMatch(/command_inactive|stale_generation/);
    expect(dryrunRecords(po)).toHaveLength(count);
  });

  it("a round handed back to a worker under the same id is the supervisor's again, not this manager's", async () => {
    const { r, row } = await poRig();
    expect((await r.mgr.release(PR)).ok).toBe(true); // before the verdict: back to pending
    expect(r.store.getSessionCommand(row.id)!.status).toBe("pending");
    await r.supervisor.launch(row.id);
    // the lease is gone and the command is a running worker's: the debug lookup does not speak for it
    expect(r.mgr.lookup(row.id)).toBeNull();
    expect(r.supervisor.lookup(row.id)).toMatchObject({ active: true, generation: 2 });
  });

  it("another PR's post, with this command's capability, is refused", async () => {
    const { row } = await poRig();
    const body = po.write(`pr-8-body.md`, "x");
    const { env } = shimEnv(row, po.caps.get(row.id)!);
    const out = io();
    expect(await runPostShim("review", ["8", "COMMENT", body], env, out.io)).toBe(1);
    expect(out.err.join("")).toMatch(/wrong_pr/);
    expect(dryrunRecords(po)).toEqual([]);
  });
});

describe("the operator's verbs", () => {
  it("debug-round and release are served by the manager through the operator control route", async () => {
    const r = rig();
    upsert(r.store, 7);
    const control = workerOperatorControl({
      supervisor: {
        control: async () => ({ ok: false, reason: "n/a" }),
        abortRound: async () => ({ ok: false, reason: "n/a" }),
      },
      debug: r.mgr,
    });
    expect(await control({ command: "debug-round", pr: 7 }, "f")).toMatchObject({
      ok: true,
      ack: "handled",
      session: "debug-pr-7",
    });
    expect(await control({ command: "debug-round", pr: 7 }, "f")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already/),
    });
    expect(await control({ command: "release", pr: 7 }, "f")).toMatchObject({
      ok: true,
      ack: "handled",
    });
    expect(await control({ command: "release", pr: 7 }, "f")).toMatchObject({ ok: false });
    // without the manager the verb is refused with a reason
    const bare = workerOperatorControl({
      supervisor: {
        control: async () => ({ ok: false, reason: "n/a" }),
        abortRound: async () => ({ ok: false, reason: "n/a" }),
      },
    });
    expect(await bare({ command: "debug-round", pr: 7 }, "f")).toMatchObject({ ok: false });
  });

  it("a release frees the lease the PR is under, and a takeover's release never touches a debug lease", async () => {
    const r = rig();
    upsert(r.store, 7);
    const takeover = new TakeoverManager({
      store: r.store,
      capabilities: r.capabilities,
      launchFiles: r.launchFiles,
      runDir: r.runDir,
      socketPath: join(r.runDir, "q.sock"),
      tmux: new Tmux({ exec: r.host.exec }),
      plan: () => {
        throw new Error("no session");
      },
      launcherMain: "/l.js",
      takeoverMain: "/t.js",
      proc: r.host.proc,
      signal: r.host.signal,
      now: () => r.host.clock,
    });
    expect((await r.mgr.arm(7)).ok).toBe(true);
    expect(await takeover.release(7)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/debug lease, not a takeover/),
    });
    expect(r.store.hostLease(7)).toMatchObject({ kind: "debug", state: "held" });
    // and the takeover's IPC lookup does not answer for a debug round's command
    expect(takeover.lookup(r.store.hostLease(7)!.command_id)).toBeNull();
    // the gates compose
    expect(
      composeHostGates(
        () => null,
        (pr) => r.mgr.hostGate(pr),
      )(7),
    ).toMatch(/debug lease/);
    expect(composeHostGates(() => null)(7)).toBeNull();
  });

  it("qcr debug-round takes exactly one PR number and says how to attach", () => {
    expect(parseTakeoverArgs(["12"])).toBe(12);
    expect(() => parseTakeoverArgs([])).toThrow(/debug-round/);
    expect(debugRoundAttachLines(12).join("\n")).toContain("tmux attach -t debug-pr-12");
    expect(debugSession(12)).toBe("debug-pr-12");
  });
});
