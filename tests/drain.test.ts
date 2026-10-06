// Deploy-window drain (2026-08-25): a deploy recreates the container, so the
// operator needs a valve that quiets the board first. While draining:
//   * POST /webhook answers 200 and the delivery is DROPPED — not interpreted,
//     not recorded (the owner chose dropping over recording; the reconcile poll
//     is the single recovery path) — but COUNTED, so the lift can say how many;
//   * the dispatch pump starts no rounds; recheck nudges and ping-pong replies
//     do not fire, and the EOD sweep is DEFERRED until the drain lifts
//     (S2 — it used to be skipped for the day); in-flight rounds run
//     to their natural end;
//   * the flag is a persistent DB row (it must survive the restart it exists
//     for), surfaced in status.json, `qcr status` and the board's top bar;
//   * the boot's FIRST healthy reconcile pass lifts it (`drain_lifted`); a
//     failed first pass leaves it standing — a broken deploy must not resume
//     work blind. Manual `drain off` works at any time.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainManualSshCommand, drainPayload, renderStatus, runDrain } from "../src/cli.js";
import {
  authorizeCommand,
  executeCommand,
  validateCommand,
  type CommandDeps,
} from "../src/commands.js";
import { loadConfig, parseConfig, type Config } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import { startEodTimer } from "../src/eod.js";
import type { GateResult } from "../src/gate.js";
import type { PrRef } from "../src/github.js";
import { runBaseAdvance, runRecheck } from "../src/recheck.js";
import { buildStatusSnapshot, StateStore } from "../src/state.js";
import { topBar, type BoardView } from "../src/tui/board.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { RemoteResult } from "../src/tui/remote.js";
import { handleDelivery, signBody } from "../src/webhook.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const SECRET = "drain-secret";

function eventKinds(store: StateStore): string[] {
  return (
    store.db.prepare("SELECT kind FROM events ORDER BY id").all() as Array<{ kind: string }>
  ).map((e) => e.kind);
}

// ---- the persistent flag ---------------------------------------------------

describe("drain state row", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-drain-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it(
    "survives a simulated restart (new StateStore over the same file)",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const dbPath = join(dir, "state.db");
      const first = new StateStore(dbPath);
      expect(first.drainState()).toEqual({ draining: false, drained_deliveries: 0 });
      expect(first.engageDrain({ issuer: "operator", expires_at: null }).outcome).toBe("engaged");
      first.countDrainedDelivery();
      expect(first.countDrainedDelivery()).toBe(2);
      first.close();

      const second = new StateStore(dbPath);
      const state = second.drainState();
      expect(state.draining).toBe(true);
      expect(state.drained_deliveries).toBe(2);
      if (!state.draining) throw new Error("unreachable: asserted draining above");
      expect(state.since).not.toBeNull();
      // Lifting returns the window's drop count; re-draining starts a fresh one.
      expect(second.liftDrain("operator")).toEqual({ changed: true, dropped: 2 });
      // Idempotent off: no change, and the counter (kept for the record until
      // the next drain-on resets it) is still reported honestly.
      expect(second.liftDrain("operator")).toEqual({ changed: false, dropped: 2 });
      expect(second.engageDrain({ issuer: "operator", expires_at: null }).outcome).toBe("engaged");
      expect(second.drainState().drained_deliveries).toBe(0);
      second.close();
    },
  );
});

// ---- webhook: hard stop ----------------------------------------------------

const labeledPayload = () => ({
  action: "labeled",
  number: 4242,
  label: { id: 1, name: cfg.github.trigger_label, color: "ededed" },
  pull_request: {
    number: 4242,
    title: "t",
    user: { login: "alice", type: "User" },
    head: { sha: "abc" },
    merged: false,
  },
  sender: { login: "alice", type: "User" },
});

function delivery(store: StateStore, payload: unknown, event: string, guid: string) {
  const raw = Buffer.from(JSON.stringify(payload));
  return handleDelivery(
    { cfg, store, secret: SECRET, onInterpretation: () => {} },
    { signature: signBody(raw, SECRET), guid, event },
    raw,
  );
}

describe("webhook while draining", () => {
  it("answers 200, drops the delivery unrecorded, and counts it", () => {
    const store = new StateStore(":memory:");
    store.engageDrain({ issuer: "operator", expires_at: null });
    const res = delivery(store, labeledPayload(), "pull_request", "drain-g1");
    expect(res.status).toBe(200);
    expect(res.reason).toBe("draining");
    expect(res.interpretation).toBeUndefined();
    expect(store.drainState().drained_deliveries).toBe(1);
    // NOT recorded: no delivery row, no webhook_event — the reconcile poll is
    // the single recovery path, and a redelivery after the lift is not a dupe.
    expect(
      (store.db.prepare("SELECT COUNT(*) AS c FROM deliveries").get() as { c: number }).c,
    ).toBe(0);
    expect(eventKinds(store)).not.toContain("webhook_event");

    store.liftDrain("operator");
    const after = delivery(store, labeledPayload(), "pull_request", "drain-g1");
    expect(after.reason).toBe("trigger");
    expect(after.interpretation?.kind).toBe("trigger");
    store.close();
  });

  it("still 403s a bad signature (the drop only ever answers authentic deliveries)", () => {
    const store = new StateStore(":memory:");
    store.engageDrain({ issuer: "operator", expires_at: null });
    const raw = Buffer.from(JSON.stringify(labeledPayload()));
    const res = handleDelivery(
      { cfg, store, secret: SECRET, onInterpretation: () => {} },
      { signature: signBody(raw, "wrong"), guid: "g", event: "pull_request" },
      raw,
    );
    expect(res.status).toBe(403);
    expect(store.drainState().drained_deliveries).toBe(0);
    store.close();
  });

  it("drops an author reply too — ping-pong cannot fire from a drained webhook", () => {
    const store = new StateStore(":memory:");
    store.registerBotComment(800001, 4242);
    store.engageDrain({ issuer: "operator", expires_at: null });
    const payload = {
      action: "created",
      comment: {
        id: 900001,
        in_reply_to_id: 800001,
        body: "done",
        user: { login: "alice", type: "User" },
        path: "x.py",
      },
      pull_request: {
        number: 4242,
        title: "t",
        user: { login: "alice", type: "User" },
        head: { sha: "abc" },
      },
      sender: { login: "alice", type: "User" },
    };
    expect(delivery(store, payload, "pull_request_review_comment", "drain-g2").reason).toBe(
      "draining",
    );
    store.liftDrain("operator");
    expect(
      delivery(store, payload, "pull_request_review_comment", "drain-g3").interpretation?.kind,
    ).toBe("author_reply");
    store.close();
  });
});

// ---- dispatch pump ----------------------------------------------------------

class PumpAdapter implements DispatchAdapter {
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

describe("dispatch pump while draining", () => {
  it(
    "starts nothing; the queued PR dispatches after the lift",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const store = new StateStore(":memory:");
      store.upsertPr({
        number: 7,
        state: "queued",
        head_sha: "sha7",
        title: "PR 7",
        author: "alice",
        trigger_ts: "2026-08-25T09:00:00Z",
        trigger_provenance: "human",
        stale_recheck: 0,
        migration_gate: 0,
      });
      const orders: unknown[] = [];
      const hooks = {
        async dispatchRound(order: unknown) {
          orders.push(order);
        },
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
      };
      store.engageDrain({ issuer: "operator", expires_at: null });
      expect(await dispatchOnce({ cfg, store, adapter: new PumpAdapter(), hooks })).toEqual([]);
      expect(orders).toHaveLength(0);
      expect(store.runningRounds()).toHaveLength(0);

      store.liftDrain("operator");
      const dispatched = await dispatchOnce({ cfg, store, adapter: new PumpAdapter(), hooks });
      expect(dispatched.map((o) => o.pr)).toEqual([7]);
      store.close();
    },
  );
});

// ---- recheck ----------------------------------------------------------------

describe("recheck while draining", () => {
  it("generates no nudge (noop: draining), and works again after the lift", async () => {
    const store = new StateStore(":memory:");
    store.engageDrain({ issuer: "operator", expires_at: null });
    const inject = vi.fn();
    const out = await runRecheck(
      { cfg, store, adapter: {}, inject },
      { pr: 5, trigger: "push", head_sha: "h2" },
    );
    expect(out).toMatchObject({ action: "noop", reason: "draining" });
    expect(inject).not.toHaveBeenCalled();
    store.liftDrain("operator");
    const after = await runRecheck(
      { cfg, store, adapter: {}, inject },
      { pr: 5, trigger: "push", head_sha: "h2" },
    );
    // The drain lifted, so the recheck must get PAST the drain gate. It still
    // no-ops here — this PR carries no approval to re-check — and that is the
    // point: the reason has to be that one, not "draining".
    //
    // The two weaker forms both pass for the wrong reason. Reading `reason`
    // off the union asserted `undefined !== "draining"` on every non-noop arm;
    // narrowing it to `null` only MOVED the vacuity, since `null !==
    // "draining"` is equally trivial. Naming the expected reason is what
    // actually pins the gate order.
    expect(after.action).toBe("noop");
    if (after.action !== "noop") throw new Error("unreachable");
    expect(
      after.reason,
      "the drain gate must be behind us — a noop now needs a reason of its own",
    ).toBe("no-standing-approval");
    store.close();
  });

  it("skips the base-advance fan-out before any per-PR API call", async () => {
    const store = new StateStore(":memory:");
    store.upsertPr({
      number: 9,
      state: "tracked",
      head_sha: "h9",
      title: "PR 9",
      author: "alice",
      trigger_ts: null,
      trigger_provenance: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.recordReviewedHead(9, {
      head_sha: "h9",
      verdict: "APPROVE",
      posted_event: "approved",
      round_no: 1,
    });
    store.engageDrain({ issuer: "operator", expires_at: null });
    const getPr = vi.fn();
    const enabled: Config = {
      ...cfg,
      recheck: { ...cfg.recheck, enabled: true, on_base_advance: true },
    };
    const out = await runBaseAdvance(
      { cfg: enabled, store, adapter: { getPr }, inject: vi.fn() },
      { branch: "master", before: "a", after: "b" },
    );
    expect(out.size).toBe(0);
    expect(getPr).not.toHaveBeenCalled();
    store.close();
  });
});

// ---- EOD sweep ---------------------------------------------------------------

describe("EOD sweep while draining", () => {
  // a drain DEFERS the day's sweep (it used to skip it). The
  // deferred day fires on the first poll after the lift; the full contract
  // (persistence across a restart, retries) is in tests/memory-writes.test.ts.
  it("defers the day's fire (onHeld, no inject), re-arms for the next day, and fires the deferred day once the drain lifts", async () => {
    let clock = new Date("2026-08-25T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const held: string[] = [];
    let draining = true;
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: "Europe/Warsaw",
      now: () => clock,
      readPrompt: () => "sweep {{date}}",
      shouldHold: () => draining,
      onHeld: (d) => held.push(d),
      injectOverseer: async (m) => {
        injected.push(m);
      },
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
    });
    clock = new Date("2026-08-25T16:00:00Z"); // 18:00 CEST
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(injected).toEqual([]);
    expect(held).toEqual(["2026-08-25"]);
    // Re-armed for tomorrow, plus the deferred day's drain poll.
    expect(timers).toHaveLength(3);
    expect(timer.deferredDates()).toEqual(["2026-08-25"]);
    const poll = timers.find((t) => t.ms === 60_000)!;
    const tomorrow = timers.find((t, i) => i > 0 && t.ms !== 60_000)!;
    // The drain lifts: the deferred day fires on the next poll.
    draining = false;
    poll.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(injected).toEqual(["sweep 2026-08-25"]);
    expect(timer.deferredDates()).toEqual([]);
    // Next day: the sweep fires normally.
    clock = new Date("2026-08-26T16:00:00Z");
    tomorrow.cb();
    await new Promise((r) => setTimeout(r, 0));
    expect(injected).toEqual(["sweep 2026-08-25", "sweep 2026-08-26"]);
    timer.stop();
  });
});

// ---- auto-lift on healthy boot ----------------------------------------------

const PR = 101;

function bootAdapter(over: Partial<Record<string, unknown>> = {}): DaemonAdapter {
  const pr: PrRef = {
    number: PR,
    title: "test PR",
    author: "someone",
    head_sha: "headsha1",
    base_ref: "master",
    updated_at: "2026-08-25T00:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
  } as PrRef;
  const gate = async (): Promise<GateResult> => ({ executed: false });
  return {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    listOpenPrs: async () => [pr],
    getPr: async () => pr,
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [],
    addLabel: gate,
    removeLabel: gate,
    deleteTeamReviewRequest: gate,
    createReview: gate,
    ...over,
  } as unknown as DaemonAdapter;
}

describe("drain auto-lift", () => {
  let root: string;
  let store: StateStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-drain-boot-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    store = new StateStore(":memory:");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lifts on the boot's first HEALTHY reconcile pass, logging the drop count", async () => {
    store.engageDrain({ issuer: "operator", expires_at: null });
    store.countDrainedDelivery();
    store.countDrainedDelivery();
    store.countDrainedDelivery();
    const daemon = createDaemon({
      cfg: { ...loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
      root,
      store,
      adapter: bootAdapter(),
      listen: false,
      log: () => {},
    });
    await daemon.start();
    try {
      expect(store.drainState().draining).toBe(false);
      const lifted = store.db
        .prepare("SELECT payload FROM events WHERE kind = 'drain_lifted'")
        .all() as Array<{ payload: string }>;
      expect(lifted).toHaveLength(1);
      expect(JSON.parse(lifted[0]!.payload)).toMatchObject({ dropped_deliveries: 3 });
    } finally {
      await daemon.stop();
    }
  });

  it("does NOT lift when the first reconcile pass fails — and never auto-lifts later that boot", async () => {
    store.engageDrain({ issuer: "operator", expires_at: null });
    const adapter = bootAdapter({
      listOpenPrs: async () => {
        throw new Error("github down");
      },
    });
    const daemon = createDaemon({
      cfg: { ...loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml")), dry_run: true },
      root,
      store,
      adapter,
      listen: false,
      log: () => {},
    });
    await daemon.start();
    try {
      expect(store.drainState().draining).toBe(true);
      // Even a later, healthy reconcile pass must not lift — only the boot's
      // FIRST pass may (a broken deploy resumes only on an explicit drain off).
      (adapter as { listOpenPrs: () => Promise<PrRef[]> }).listOpenPrs = async () => [];
      await daemon.reconcile();
      expect(store.drainState().draining).toBe(true);
      expect(eventKinds(store)).not.toContain("drain_lifted");
      // The manual lift always works.
      expect(store.liftDrain("operator").changed).toBe(true);
    } finally {
      await daemon.stop();
    }
  });
});

// ---- the command channel -----------------------------------------------------

describe("drain command", () => {
  it("accepts {on:true} and {on:false}", () => {
    for (const on of [true, false]) {
      const v = validateCommand({ command: "drain", on });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.command).toEqual({ command: "drain", on });
    }
  });

  it("rejects garbage: non-boolean, missing and unknown fields", () => {
    expect(validateCommand({ command: "drain", on: "yes" }).ok).toBe(false);
    expect(validateCommand({ command: "drain", on: 1 }).ok).toBe(false);
    expect(validateCommand({ command: "drain" }).ok).toBe(false);
    expect(validateCommand({ command: "drain", on: true, pr: 5 }).ok).toBe(false);
  });

  it("is operator-tiered: never author- or anyone-reachable", () => {
    const cmd = { command: "drain", on: true } as const;
    const origin = (tier: string) =>
      ({ tier, slack_user: "U1", authorized_prs: [4242], source: "slack" }) as never;
    expect(authorizeCommand(cmd, null).ok).toBe(true); // daemon/tmux autonomy
    expect(authorizeCommand(cmd, origin("owner")).ok).toBe(true);
    expect(authorizeCommand(cmd, origin("system")).ok).toBe(true);
    expect(authorizeCommand(cmd, origin("author")).ok).toBe(false);
    expect(authorizeCommand(cmd, origin("anyone")).ok).toBe(false);
  });

  it("executes through the wired dep, and refuses loudly when unwired", async () => {
    const calls: boolean[] = [];
    const deps = { drain: (on: boolean) => void calls.push(on) } as unknown as CommandDeps;
    const v = validateCommand({ command: "drain", on: true });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect((await executeCommand(v.command, deps)).ok).toBe(true);
    expect(calls).toEqual([true]);
    const unwired = await executeCommand(v.command, {} as CommandDeps);
    expect(unwired.ok).toBe(false);
    expect(unwired.reason).toContain("not wired");
  });
});

// ---- surfacing ---------------------------------------------------------------

describe("drain surfacing", () => {
  it("rides the status snapshot while draining, absent otherwise", () => {
    const store = new StateStore(":memory:");
    expect(buildStatusSnapshot(store, false)).not.toHaveProperty("draining");
    store.engageDrain({ issuer: "operator", expires_at: null });
    store.countDrainedDelivery();
    const snap = buildStatusSnapshot(store, false);
    expect(snap.draining).toBe(true);
    expect(snap.drained_deliveries).toBe(1);
    expect(snap.draining_since).toBeDefined();
    store.close();
  });

  it("renders a DRAINING line in qcr status", () => {
    const out = renderStatus({
      written_at: "2026-08-25T10:00:00Z",
      dry_run: false,
      prs: [],
      running_rounds: 2,
      total_spend_usd: 0,
      draining: true,
      drained_deliveries: 4,
      draining_since: "2026-08-25T09:30:00Z",
      heartbeat: "2026-08-25T10:00:00Z",
    });
    expect(out).toContain("DRAINING");
    expect(out).toContain("dropped: 4");
    expect(out).toContain("2026-08-25T09:30:00Z");
  });

  it("paints a DRAINING banner segment on the board's top bar", () => {
    const view: BoardView = {
      health: { kind: "ok", heartbeatAgeS: 5 },
      dryRun: false,
      snapshot: {
        written_at: "2026-08-25T10:00:00Z",
        dry_run: false,
        prs: [],
        running_rounds: 3,
        total_spend_usd: 0,
        draining: true,
        drained_deliveries: 7,
        heartbeat: "2026-08-25T10:00:00Z",
      },
      events: [],
      selected: 0,
      eventsFocus: false,
      eventsScroll: 0,
      help: false,
    };
    const bar = stripAnsi(topBar(view, 160));
    expect(bar).toContain("DRAINING");
    expect(bar).toContain("3 rounds finishing");
    expect(bar).toContain("7 dropped");
    const quiet = stripAnsi(
      topBar({ ...view, snapshot: { ...view.snapshot!, draining: undefined } }, 160),
    );
    expect(quiet).not.toContain("DRAINING");
  });
});

// ---- qcr drain (the CLI route) -----------------------------------------------

describe("qcr drain over the unwedge command channel", () => {
  const ok = (stdout = ""): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });

  it("writes the validated payload over ssh and reads the daemon's verdict back", async () => {
    const writes: Array<{ argv: string[]; stdin?: string }> = [];
    const lines: string[] = [];
    let polled = 0;
    const ssh = async (
      _host: string,
      argv: string[],
      opts?: { stdin?: string },
    ): Promise<RemoteResult> => {
      if (opts?.stdin !== undefined) {
        writes.push({ argv, stdin: opts.stdin });
        return ok();
      }
      polled++;
      return ok(JSON.stringify({ ok: true, draining: true, running_rounds: 2 }));
    };
    const code = await runDrain(true, {
      cfg,
      ssh,
      log: (l) => lines.push(l),
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.stdin!)).toEqual({ command: "drain", on: true });
    // The write rides the SAME docker-exec-over-ssh channel the TUI unwedge
    // uses: an atomic tmp+mv into the daemon's commands/ dir.
    expect(writes[0]!.argv.join(" ")).toContain(`${cfg.tui.remote_sandbox_root}/commands`);
    expect(polled).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("2 round(s) still finishing");
  });

  it("reports the drop count on drain off", async () => {
    const lines: string[] = [];
    const ssh = async (
      _h: string,
      _a: string[],
      opts?: { stdin?: string },
    ): Promise<RemoteResult> =>
      opts?.stdin !== undefined
        ? ok()
        : ok(JSON.stringify({ ok: true, draining: false, dropped_deliveries: 11 }));
    expect(
      await runDrain(false, { cfg, ssh, log: (l) => lines.push(l), sleep: async () => {} }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("11 webhook delivery(ies)");
  });

  it("prints the exact manual ssh fallback when the runner path fails", async () => {
    const lines: string[] = [];
    const ssh = async (): Promise<RemoteResult> => ({
      ok: false,
      stdout: "",
      stderr: "no route",
      code: 255,
    });
    const now = new Date("2026-08-31T12:00:00Z");
    expect(
      await runDrain(true, {
        cfg,
        ssh,
        log: (l) => lines.push(l),
        sleep: async () => {},
        now: () => now,
      }),
    ).toBe(1);
    const manual = drainManualSshCommand(cfg.tui, true, now);
    expect(lines.join("\n")).toContain(manual);
    expect(manual).toContain(`ssh ${cfg.tui.ssh_host}`);
    expect(manual).toContain('{"command":"drain","on":true}');
  });

  it("surfaces the daemon's refusal instead of pretending", async () => {
    const lines: string[] = [];
    const ssh = async (
      _h: string,
      _a: string[],
      opts?: { stdin?: string },
    ): Promise<RemoteResult> =>
      opts?.stdin !== undefined ? ok() : ok(JSON.stringify({ ok: false, reason: "tier: nope" }));
    expect(
      await runDrain(true, { cfg, ssh, log: (l) => lines.push(l), sleep: async () => {} }),
    ).toBe(1);
    expect(lines.join("\n")).toContain("tier: nope");
  });

  it("payload builder emits exactly the whitelisted shape", () => {
    expect(JSON.parse(drainPayload(false))).toEqual({ command: "drain", on: false });
    const v = validateCommand(JSON.parse(drainPayload(true)));
    expect(v.ok).toBe(true);
  });
});
