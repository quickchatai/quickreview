// the dispatch levers are bounded for a SESSION and untouched for
// the OPERATOR, and the two are told apart structurally.
//
//   * A session-issued drain / pause-pr ALWAYS carries an expiry and ALWAYS
//     draws on a per-day minute budget; it cannot lift or narrow an operator's
//     hold; the operator's grant upgrades a session's.
//   * The operator's own drain (`qcr drain on`, the deploy tab) is unbounded,
//     and the boot's first healthy reconcile still lifts whatever stands.
//   * Who is asking is decided by the CHANNEL — `commands/operator/` is a
//     root-owned directory the daemon's uid (every session's uid) cannot write
//     — never by a field in the file. A file there without the seal is served
//     as a session's, loudly.
//   * The hold's expiry binds at every reader the moment it passes, with no
//     sweep required; the sweep only writes the ledger.
//
// Every fence here was verified by mutation (the defect applied, the test
// red, the defect reverted); the MUTATION notes say which edit.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainManualSshCommand, renderStatus, runDrain } from "../src/cli.js";
import {
  CommandWatcher,
  executeCommand,
  operatorSealVerdict,
  processOperatorSeal,
  validateCommand,
  type CommandDeps,
  type OperatorSeal,
  type PathIdentity,
} from "../src/commands.js";
import { LEVERS_DEFAULTS, loadConfig, parseLevers, type Config } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { queuedInOrder } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrRef } from "../src/github.js";
import {
  boundSessionGrant,
  drainLever,
  holdActive,
  mayLift,
  mergeHold,
  minutesFromNow,
  pauseLever,
  resumeLever,
  sweepExpiredLevers,
  type LeverDeps,
} from "../src/levers.js";
import { buildStatusSnapshot, StateStore } from "../src/state.js";
import { detailLines, leverHolderLabel, topBar, type BoardView } from "../src/tui/board.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { RemoteResult } from "../src/tui/remote.js";
import { operatorCommandWriteScript } from "../src/tui/unwedge.js";

const cfg: Config = loadConfig(resolve(process.cwd(), "tests/fixtures/config.toml"));
const T0 = new Date("2026-09-02T10:00:00.000Z");
const OPERATOR = { issuer: "operator", expires_at: null } as const;

function eventsOf(store: StateStore, kind: string): Array<Record<string, unknown>> {
  return (
    store.db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Array<{
      payload: string;
    }>
  ).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

function queue(store: StateStore, n: number): void {
  store.upsertPr({
    number: n,
    state: "queued",
    head_sha: `sha${n}`,
    title: `PR ${n}`,
    author: "alice",
    trigger_ts: "2026-09-02T09:00:00Z",
    trigger_provenance: "human",
    stale_recheck: 0,
    migration_gate: 0,
  });
}

/** A store on a clock the test moves. */
function clocked(): { store: StateStore; tick: (min: number) => void; now: () => Date } {
  let clock = T0;
  const store = new StateStore(":memory:", () => clock);
  return {
    store,
    tick: (min) => (clock = new Date(clock.getTime() + min * 60_000)),
    now: () => clock,
  };
}

// ---- the pure precedence ----------------------------------------------------

describe("mergeHold / mayLift / holdActive", () => {
  const session = (min: number) =>
    ({ issuer: "session", expires_at: minutesFromNow(T0, min) }) as const;

  it("nothing standing → engaged with the grant, as given", () => {
    expect(mergeHold(null, OPERATOR)).toEqual({
      hold: { issuer: "operator", expires_at: null },
      outcome: "engaged",
    });
    expect(mergeHold(null, session(10))).toEqual({
      hold: { issuer: "session", expires_at: session(10).expires_at },
      outcome: "engaged",
    });
  });

  it("a session never narrows or replaces an operator's hold; an operator's grant upgrades a session's", () => {
    // MUTATION: swap the two issuer branches in mergeHold — both lines fail.
    expect(mergeHold({ issuer: "operator", expires_at: null }, session(10)).outcome).toBe(
      "unchanged",
    );
    const up = mergeHold({ issuer: "session", expires_at: session(10).expires_at }, OPERATOR);
    expect(up).toEqual({ hold: { issuer: "operator", expires_at: null }, outcome: "upgraded" });
  });

  it("the same issuer only ever WIDENS: a later expiry extends, an earlier one changes nothing", () => {
    const standing = { issuer: "session", expires_at: session(20).expires_at } as const;
    expect(mergeHold(standing, session(30))).toEqual({
      hold: { issuer: "session", expires_at: session(30).expires_at },
      outcome: "extended",
    });
    expect(mergeHold(standing, session(5)).outcome).toBe("unchanged");
    // An operator widening to "until lifted" is an extension too.
    expect(
      mergeHold({ issuer: "operator", expires_at: session(20).expires_at }, OPERATOR).outcome,
    ).toBe("extended");
  });

  it("mayLift: the operator lifts anything, a session only a session's", () => {
    expect(mayLift({ issuer: "operator", expires_at: null }, "session")).toBe(false);
    expect(mayLift({ issuer: "operator", expires_at: null }, "operator")).toBe(true);
    expect(mayLift({ issuer: "session", expires_at: "x" }, "session")).toBe(true);
  });

  it("holdActive: a null expiry never lapses; a dated one lapses at its instant", () => {
    const at = minutesFromNow(T0, 10);
    expect(holdActive({ issuer: "session", expires_at: at }, minutesFromNow(T0, 9))).toBe(true);
    expect(holdActive({ issuer: "session", expires_at: at }, at)).toBe(false);
    expect(holdActive({ issuer: "operator", expires_at: null }, "2999-01-01T00:00:00.000Z")).toBe(
      true,
    );
    expect(holdActive(null, at)).toBe(false);
  });
});

describe("boundSessionGrant", () => {
  const base = { kind: "drain" as const, maxMin: 30, budgetMin: 90, now: T0 };

  it("an omitted for_min gets the cap, or what is left of the budget, never 'until lifted'", () => {
    expect(boundSessionGrant({ ...base, requestedMin: undefined, usedMin: 0 })).toEqual({
      ok: true,
      minutes: 30,
      expires_at: minutesFromNow(T0, 30),
    });
    expect(boundSessionGrant({ ...base, requestedMin: undefined, usedMin: 80 })).toMatchObject({
      ok: true,
      minutes: 10,
    });
  });

  it("refuses past the cap, past the remaining budget, and on a spent budget — each naming the number", () => {
    // MUTATION: drop the `requestedMin > maxMin` branch — the first line fails.
    expect(boundSessionGrant({ ...base, requestedMin: 31, usedMin: 0 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("cap of 30"),
    });
    expect(boundSessionGrant({ ...base, requestedMin: 20, usedMin: 80 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("10 minutes left"),
    });
    expect(boundSessionGrant({ ...base, requestedMin: undefined, usedMin: 90 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("budget for today is spent"),
    });
    expect(boundSessionGrant({ ...base, requestedMin: 30, usedMin: 60 })).toMatchObject({
      ok: true,
      minutes: 30,
    });
  });
});

describe("[levers] config", () => {
  it("defaults, and refuses a zero bound or a budget that cannot fund one full grant", () => {
    expect(parseLevers({})).toEqual(LEVERS_DEFAULTS);
    expect(cfg.levers).toEqual(LEVERS_DEFAULTS);
    expect(() => parseLevers({ session_drain_max_min: 0 })).toThrow(/session_drain_max_min/);
    expect(() => parseLevers({ session_pause_max_min: 1.5 })).toThrow(/session_pause_max_min/);
    expect(() => parseLevers({ session_drain_budget_min_per_day: 10 })).toThrow(
      /at least session_drain_max_min/,
    );
    expect(() => parseLevers({ session_pause_budget_min_per_day: 10 })).toThrow(
      /at least session_pause_max_min/,
    );
  });
});

// ---- the store: expiry binds at the reader --------------------------------

describe("store — drain holds", () => {
  it("a session drain stops binding at its expiry with NO sweep, at drainState() itself", () => {
    const { store, tick } = clocked();
    const res = store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 30) });
    expect(res.outcome).toBe("engaged");
    expect(store.drainState()).toMatchObject({
      draining: true,
      issued_by: "session",
      expires_at: minutesFromNow(T0, 30),
    });
    tick(29);
    expect(store.drainState().draining).toBe(true);
    tick(1);
    // MUTATION: make drainState skip the holdActive fold — this fails.
    // The not-draining arm carries NO holder at all — the union makes "draining with no issuer" unspellable.
    expect(store.drainState()).toEqual({ draining: false, drained_deliveries: 0 });
    // The row is still there for the sweep to retire, and it retires exactly it.
    expect(store.expireLevers()).toEqual({ drain: true, pauses: [] });
    expect(store.expireLevers()).toEqual({ drain: false, pauses: [] });
    store.close();
  });

  it("an operator drain has no expiry, and a session can neither lift nor narrow it", () => {
    const { store, tick } = clocked();
    expect(store.engageDrain(OPERATOR).outcome).toBe("engaged");
    tick(24 * 60);
    expect(store.drainState()).toMatchObject({
      draining: true,
      issued_by: "operator",
      expires_at: null,
    });
    expect(
      store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 30) }).outcome,
    ).toBe("unchanged");
    expect(store.drainState()).toMatchObject({ draining: true, expires_at: null });
    // MUTATION: make liftDrain ignore `mayLift` — this fails.
    expect(store.liftDrain("session")).toMatchObject({
      changed: false,
      refused: "held-by-operator",
    });
    expect(store.drainState().draining).toBe(true);
    expect(store.liftDrain("operator").changed).toBe(true);
    expect(store.drainState().draining).toBe(false);
    store.close();
  });

  it("the operator's grant upgrades a session's drain and keeps its drop window; the session's lift then bounces", () => {
    const { store } = clocked();
    store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 30) });
    store.countDrainedDelivery();
    const up = store.engageDrain(OPERATOR);
    expect(up.outcome).toBe("upgraded");
    expect(up.state).toMatchObject({
      draining: true,
      issued_by: "operator",
      expires_at: null,
      drained_deliveries: 1,
    });
    expect(store.liftDrain("session").refused).toBe("held-by-operator");
    store.close();
  });

  it("a session extending its own drain only widens; a lapsed session drain re-engages as a fresh window", () => {
    const { store, tick } = clocked();
    store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 20) });
    store.countDrainedDelivery();
    expect(
      store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 10) }).outcome,
    ).toBe("unchanged");
    expect(
      store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 30) }),
    ).toMatchObject({
      outcome: "extended",
      state: { expires_at: minutesFromNow(T0, 30), drained_deliveries: 1 },
    });
    tick(31);
    expect(
      store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 60) }),
    ).toMatchObject({
      outcome: "engaged",
      state: { drained_deliveries: 0 },
    });
    store.close();
  });

  it("a legacy draining row (no issuer recorded) is the OPERATOR's and never lapses", () => {
    const { store, tick } = clocked();
    store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 5) });
    store.db
      .prepare("UPDATE drain_state SET issued_by = NULL, expires_at = NULL WHERE id = 1")
      .run();
    tick(24 * 60);
    expect(store.drainState()).toMatchObject({
      draining: true,
      issued_by: "operator",
      expires_at: null,
    });
    expect(store.liftDrain("session").refused).toBe("held-by-operator");
    store.close();
  });

  it("the boot auto-lift still lifts whatever stands — a session's drain included", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-levers-boot-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    const store = new StateStore(":memory:");
    store.engageDrain({ issuer: "session", expires_at: minutesFromNow(new Date(), 30) });
    const daemon = createDaemon({
      cfg: { ...cfg, dry_run: true },
      root,
      store,
      adapter: bootAdapter(),
      listen: false,
      log: () => {},
    });
    await daemon.start();
    try {
      expect(store.drainState().draining).toBe(false);
      expect(eventsOf(store, "drain_lifted")).toHaveLength(1);
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("store — pause holds", () => {
  it("a session pause lapses at every reader — getPr, allPrs, the dispatch queue — with no sweep", () => {
    const { store, tick } = clocked();
    queue(store, 1);
    queue(store, 2);
    const res = store.pausePr(
      1,
      { issuer: "session", expires_at: minutesFromNow(T0, 60) },
      "churn",
    );
    expect(res).toEqual({
      outcome: "engaged",
      hold: { issuer: "session", expires_at: minutesFromNow(T0, 60) },
    });
    expect(store.getPr(1)).toMatchObject({
      paused: 1,
      pause_issuer: "session",
      pause_reason: "churn",
      pause_since: T0.toISOString(),
    });
    expect(queuedInOrder(store).map((p) => p.number)).toEqual([2]);
    tick(60);
    // MUTATION: make withLivePause return the row unfolded — all three fail.
    expect(store.getPr(1)!.paused).toBe(0);
    expect(store.allPrs().find((p) => p.number === 1)!.paused).toBe(0);
    expect(queuedInOrder(store).map((p) => p.number)).toEqual([1, 2]);
    expect(store.expireLevers()).toEqual({ drain: false, pauses: [1] });
    expect(store.getPr(1)).toMatchObject({
      paused: 0,
      pause_issuer: null,
      pause_reason: null,
      pause_since: null,
    });
    store.close();
  });

  it("a session cannot resume an operator's pause; the operator's grant upgrades a session's", () => {
    const { store } = clocked();
    queue(store, 7);
    store.pausePr(7, OPERATOR, "deploy");
    expect(
      store.pausePr(7, { issuer: "session", expires_at: minutesFromNow(T0, 10) }, "x").outcome,
    ).toBe("unchanged");
    // MUTATION: make resumePr ignore `mayLift` — this fails.
    expect(store.resumePr(7, "session")).toEqual({ changed: false, refused: "held-by-operator" });
    expect(store.getPr(7)!.paused).toBe(1);
    expect(store.resumePr(7, "operator")).toEqual({ changed: true });
    store.pausePr(7, { issuer: "session", expires_at: minutesFromNow(T0, 10) }, "x");
    expect(store.pausePr(7, OPERATOR, "y")).toMatchObject({
      outcome: "upgraded",
      hold: { issuer: "operator", expires_at: null },
    });
    expect(store.getPr(7)!.pause_reason).toBe("y");
    store.close();
  });

  it("a legacy paused row (no issuer recorded) is the operator's and never lapses", () => {
    const { store, tick } = clocked();
    queue(store, 3);
    store.pausePr(3, { issuer: "session", expires_at: minutesFromNow(T0, 5) }, "old");
    store.db
      .prepare("UPDATE pr_state SET pause_issuer = NULL, pause_expires_at = NULL WHERE number = 3")
      .run();
    tick(24 * 60);
    expect(store.getPr(3)).toMatchObject({ paused: 1, pause_issuer: "operator" });
    expect(store.resumePr(3, "session").refused).toBe("held-by-operator");
    store.close();
  });

  it("the grant ledger charges per day, and per PR for pauses", () => {
    const { store } = clocked();
    store.recordLeverGrant("drain", null, 30, "2026-09-02", "x");
    store.recordLeverGrant("drain", null, 20, "2026-09-02", "x");
    store.recordLeverGrant("drain", null, 20, "2026-09-03", "x");
    store.recordLeverGrant("pause", 5, 240, "2026-09-02", "x");
    expect(store.leverMinutesUsed("drain", "2026-09-02", null)).toBe(50);
    expect(store.leverMinutesUsed("drain", "2026-09-03", null)).toBe(20);
    expect(store.leverMinutesUsed("pause", "2026-09-02", 5)).toBe(240);
    expect(store.leverMinutesUsed("pause", "2026-09-02", 6)).toBe(0);
    store.close();
  });
});

// ---- the handlers ---------------------------------------------------------

function deps(store: StateStore, now: () => Date): LeverDeps {
  return { store, levers: cfg.levers, timezone: cfg.ops.timezone, now };
}

describe("drainLever", () => {
  it("a session drain is bounded to the cap when for_min is omitted, ledgered, and refused once the day's budget is spent", async () => {
    const { store, tick, now } = clocked();
    const d = deps(store, now);
    const first = await drainLever(d, true, "session", undefined, async () => {});
    expect(first).toMatchObject({
      ok: true,
      draining: true,
      issuer: "session",
      expires_at: minutesFromNow(T0, 30),
      outcome: "engaged",
    });
    expect(eventsOf(store, "drain_on")).toEqual([
      { by: "session", outcome: "engaged", expires_at: minutesFromNow(T0, 30) },
    ]);
    tick(30);
    expect(store.drainState().draining).toBe(false);
    const second = await drainLever(d, true, "session", undefined, async () => {});
    expect(second).toMatchObject({ ok: true, expires_at: minutesFromNow(now(), 30) });
    tick(30);
    const third = await drainLever(d, true, "session", undefined, async () => {});
    expect(third).toMatchObject({ ok: true, expires_at: minutesFromNow(now(), 30) }); // 90 of 90 used
    tick(30);
    // MUTATION: make grantFor skip `charge()` — this fails (the budget never fills).
    const fourth = await drainLever(d, true, "session", undefined, async () => {});
    expect(fourth).toMatchObject({
      ok: false,
      reason: expect.stringContaining("budget for today is spent"),
    });
    expect(store.drainState().draining).toBe(false);
    store.close();
  });

  it("an explicit for_min past the cap is refused with the cap named; within it, honoured", async () => {
    const { store, now } = clocked();
    const d = deps(store, now);
    expect(await drainLever(d, true, "session", 31, async () => {})).toMatchObject({
      ok: false,
      reason: expect.stringContaining("cap of 30"),
    });
    expect(await drainLever(d, true, "session", 12, async () => {})).toMatchObject({
      ok: true,
      expires_at: minutesFromNow(T0, 12),
    });
    store.close();
  });

  it("an operator drain is unbounded and charges no budget; a session cannot lift it", async () => {
    const { store, now } = clocked();
    const d = deps(store, now);
    const lifted: string[] = [];
    expect(await drainLever(d, true, "operator", undefined, async () => {})).toMatchObject({
      ok: true,
      issuer: "operator",
      expires_at: null,
      running_rounds: 0,
    });
    expect(store.leverMinutesUsed("drain", "2026-09-02", null)).toBe(0);
    // MUTATION: make drainLever's OFF path call liftDrain("operator") regardless of issuer — this fails.
    const refused = await drainLever(
      d,
      false,
      "session",
      undefined,
      async () => void lifted.push("session"),
    );
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringContaining("held by the operator"),
    });
    expect(lifted).toEqual([]);
    expect(store.drainState().draining).toBe(true);
    const ok = await drainLever(
      d,
      false,
      "operator",
      undefined,
      async () => void lifted.push("operator"),
    );
    expect(ok).toMatchObject({ ok: true, draining: false });
    expect(lifted).toEqual(["operator"]);
    expect(eventsOf(store, "drain_off")).toEqual([{ by: "operator", dropped_deliveries: 0 }]);
    store.close();
  });

  it("the operator's for_min is honoured verbatim (an operator may bound their own drain)", async () => {
    const { store, now } = clocked();
    expect(await drainLever(deps(store, now), true, "operator", 500, async () => {})).toMatchObject(
      { ok: true, issuer: "operator", expires_at: minutesFromNow(T0, 500) },
    );
    store.close();
  });
});

describe("pauseLever / resumeLever", () => {
  it("a session pause defaults to the cap, is budgeted per PR per day, and its resume bounces off an operator's", async () => {
    const { store, tick, now } = clocked();
    const d = deps(store, now);
    queue(store, 11);
    queue(store, 12);
    expect(pauseLever(d, 99, "r", "session", undefined)).toMatchObject({
      ok: false,
      reason: "unknown PR #99",
    });
    expect(pauseLever(d, 11, "waiting on CI fix", "session", undefined)).toMatchObject({
      ok: true,
      paused: 11,
      issuer: "session",
      expires_at: minutesFromNow(T0, 240),
    });
    expect(eventsOf(store, "pr_paused")).toEqual([
      {
        reason: "waiting on CI fix",
        by: "session",
        outcome: "engaged",
        expires_at: minutesFromNow(T0, 240),
      },
    ]);
    tick(240);
    expect(pauseLever(d, 11, "again", "session", undefined)).toMatchObject({
      ok: true,
      expires_at: minutesFromNow(now(), 240),
    });
    tick(240);
    expect(pauseLever(d, 11, "third", "session", undefined)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("budget for today is spent"),
    });
    // Another PR has its own budget.
    expect(pauseLever(d, 12, "own", "session", undefined)).toMatchObject({ ok: true });
    // Operator pause; session resume refused; operator resume works and pumps.
    const pumped: string[] = [];
    expect(pauseLever(d, 12, "deploy", "operator", undefined)).toMatchObject({
      ok: true,
      issuer: "operator",
      expires_at: null,
      outcome: "upgraded",
    });
    expect(await resumeLever(d, 12, "session", async () => void pumped.push("s"))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("paused by the operator"),
    });
    expect(pumped).toEqual([]);
    expect(await resumeLever(d, 12, "operator", async () => void pumped.push("o"))).toEqual({
      ok: true,
      resumed: 12,
    });
    expect(pumped).toEqual(["o"]);
    expect(store.getPr(12)!.paused).toBe(0);
    store.close();
  });
});

describe("sweepExpiredLevers", () => {
  it("writes the ledger for what lapsed — and the daemon pump runs it", async () => {
    const { store, tick, now } = clocked();
    queue(store, 21);
    store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 10) });
    store.pausePr(21, { issuer: "session", expires_at: minutesFromNow(T0, 10) }, "r");
    const lines: string[] = [];
    expect(sweepExpiredLevers(store, (l) => lines.push(l))).toEqual({ drain: false, pauses: [] });
    tick(10);
    expect(sweepExpiredLevers(store, (l) => lines.push(l))).toEqual({ drain: true, pauses: [21] });
    expect(eventsOf(store, "drain_expired")).toHaveLength(1);
    expect(eventsOf(store, "pr_pause_expired")).toHaveLength(1);
    expect(lines.join("\n")).toContain("#21");
    void now;

    // Through the daemon: a lapsed session drain leaves its ledger row on the
    // next pump. MUTATION: drop the sweep call from daemon.ts pump — fails.
    const root = mkdtempSync(join(tmpdir(), "qcr-levers-pump-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    const { store: s2, tick: tick2 } = clocked();
    s2.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 10) });
    const daemon = createDaemon({
      cfg: { ...cfg, dry_run: true },
      root,
      store: s2,
      adapter: bootAdapter(),
      listen: false,
      log: () => {},
    });
    try {
      tick2(10);
      await daemon.pump();
      expect(eventsOf(s2, "drain_expired")).toHaveLength(1);
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
    store.close();
  });
});

// ---- the command vocabulary -------------------------------------------------

describe("commands — for_min and the issuer context", () => {
  it("for_min is optional and must be a positive integer; a drain OFF takes none", () => {
    expect(validateCommand({ command: "drain", on: true, for_min: 15 })).toEqual({
      ok: true,
      command: { command: "drain", on: true, for_min: 15 },
    });
    expect(validateCommand({ command: "pause-pr", pr: 3, reason: "r", for_min: 60 })).toEqual({
      ok: true,
      command: { command: "pause-pr", pr: 3, reason: "r", for_min: 60 },
    });
    expect(validateCommand({ command: "drain", on: true })).toEqual({
      ok: true,
      command: { command: "drain", on: true },
    });
    for (const bad of [0, -5, 1.5, "10", null]) {
      expect(validateCommand({ command: "drain", on: true, for_min: bad }).ok, String(bad)).toBe(
        false,
      );
      expect(
        validateCommand({ command: "pause-pr", pr: 3, reason: "r", for_min: bad }).ok,
        String(bad),
      ).toBe(false);
    }
    expect(validateCommand({ command: "drain", on: false, for_min: 5 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("on = true"),
    });
  });

  it("executeCommand passes the CONTEXT's issuer — and a call with no context is a session's", async () => {
    const calls: unknown[][] = [];
    const d = {
      drain: (...a: unknown[]) => void calls.push(["drain", ...a]),
      pausePr: (...a: unknown[]) => void calls.push(["pause", ...a]),
      resumePr: (...a: unknown[]) => void calls.push(["resume", ...a]),
    } as unknown as CommandDeps;
    // MUTATION: default ctx issuer "operator" in executeCommand — the first three fail.
    await executeCommand({ command: "drain", on: true, for_min: 9 }, d);
    await executeCommand({ command: "pause-pr", pr: 4, reason: "r" }, d);
    await executeCommand({ command: "resume-pr", pr: 4 }, d);
    await executeCommand({ command: "drain", on: true }, d, { file: "f", issuer: "operator" });
    expect(calls).toEqual([
      ["drain", true, "session", 9],
      ["pause", 4, "r", "session", undefined],
      ["resume", 4, "session"],
      ["drain", true, "operator", undefined],
    ]);
  });
});

// ---- the seal --------------------------------------------------------------

describe("operatorSealVerdict", () => {
  const root: PathIdentity = { uid: 0, gid: 0, mode: 0o755, kind: "dir" };
  const rootFile: PathIdentity = { uid: 0, gid: 0, mode: 0o644, kind: "file" };
  // A fixture that names no kind is a directory when it stands at the dir
  // path and a regular file otherwise — the kind checks get their own case.
  type Loose = Partial<PathIdentity> & { uid: number; gid: number; mode: number };
  const seal = (paths: Record<string, Loose | null>, euid = 1001, gids = [1001]): OperatorSeal => ({
    euid,
    gids,
    stat: (p) => {
      const s = paths[p];
      if (!s) return null;
      return { kind: p.endsWith(".json") ? "file" : "dir", ...s };
    },
  });

  it("sealed: a root-owned 0755 directory holding a root-owned 0644 file, seen by uid 1001", () => {
    expect(
      operatorSealVerdict(
        seal({ "/c/operator": root, "/c/operator/a.json": rootFile }),
        "/c/operator",
        "/c/operator/a.json",
      ),
    ).toEqual({ sealed: true });
  });

  it("not sealed: anything the daemon's own identity could have written", () => {
    // MUTATION: make writableBy return false — every line below fails.
    const cases: Array<[string, Record<string, Loose>]> = [
      [
        "directory owned by our uid",
        { "/c/operator": { uid: 1001, gid: 1001, mode: 0o755 }, "/c/operator/a.json": rootFile },
      ],
      [
        "world-writable directory",
        { "/c/operator": { uid: 0, gid: 0, mode: 0o777 }, "/c/operator/a.json": rootFile },
      ],
      [
        "group-writable directory in our group",
        { "/c/operator": { uid: 0, gid: 1001, mode: 0o775 }, "/c/operator/a.json": rootFile },
      ],
      [
        "file owned by our uid",
        { "/c/operator": root, "/c/operator/a.json": { uid: 1001, gid: 1001, mode: 0o644 } },
      ],
      [
        "world-writable file",
        { "/c/operator": root, "/c/operator/a.json": { uid: 0, gid: 0, mode: 0o666 } },
      ],
    ];
    for (const [label, paths] of cases) {
      const v = operatorSealVerdict(seal(paths), "/c/operator", "/c/operator/a.json");
      expect(v.sealed, label).toBe(false);
    }
    // A group-writable directory in a group we are NOT in is still sealed.
    expect(
      operatorSealVerdict(
        seal({ "/c/operator": { uid: 0, gid: 5, mode: 0o775 }, "/c/operator/a.json": rootFile }),
        "/c/operator",
        "/c/operator/a.json",
      ).sealed,
    ).toBe(true);
    expect(operatorSealVerdict(seal({}), "/c/operator", "/c/operator/a.json")).toEqual({
      sealed: false,
      reason: "operator directory missing",
    });
  });

  it("not sealed: a symlink standing in for the directory or the file, whoever owns it", () => {
    // MUTATION: drop the `kind` checks — both lines below fail. `commands/`
    // is the daemon's, so a session can plant a root-owned-looking link there.
    const asDir = operatorSealVerdict(
      seal({ "/c/operator": { ...root, kind: "symlink" }, "/c/operator/a.json": rootFile }),
      "/c/operator",
      "/c/operator/a.json",
    );
    expect(asDir).toEqual({
      sealed: false,
      reason: "operator directory is a symlink, not a directory",
    });
    const asFile = operatorSealVerdict(
      seal({ "/c/operator": root, "/c/operator/a.json": { ...rootFile, kind: "symlink" } }),
      "/c/operator",
      "/c/operator/a.json",
    );
    expect(asFile).toEqual({
      sealed: false,
      reason: "command file is a symlink, not a regular file",
    });
  });

  it("the REAL process seal over a directory this process made is NOT sealed — the honest case a test can produce", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-seal-"));
    try {
      writeFileSync(join(dir, "a.json"), "{}");
      const v = operatorSealVerdict(processOperatorSeal(), dir, join(dir, "a.json"));
      expect(v.sealed).toBe(false);
      if (!v.sealed) expect(v.reason).toContain(`uid ${process.geteuid?.()}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- the operator watcher ------------------------------------------------

describe("CommandWatcher over commands/operator/", () => {
  let root: string;
  let store: StateStore;
  const sealed: OperatorSeal = {
    euid: 1001,
    gids: [1001],
    stat: (p) =>
      p.endsWith(".json")
        ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
        : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
  };

  function watcherDeps(): { deps: CommandDeps; issuers: string[] } {
    const issuers: string[] = [];
    const d = {
      drain: (_on: boolean, issuer: string) => {
        issuers.push(issuer);
        return { ok: true, draining: true, issuer, running_rounds: 0 };
      },
    } as unknown as CommandDeps;
    return { deps: d, issuers };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-opwatch-"));
    mkdirSync(join(root, "commands"), { recursive: true });
    store = new StateStore(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const opDir = () => join(root, "commands", "operator");
  const result = (name: string) =>
    JSON.parse(
      readFileSync(join(root, "commands", "results", `${name}.result.json`), "utf8"),
    ) as Record<string, unknown>;

  it("with the seal: issuer operator, result beside the session dir's, the file stays put, and it never re-executes", async () => {
    mkdirSync(opDir());
    writeFileSync(join(opDir(), "d1.json"), JSON.stringify({ command: "drain", on: true }));
    const { deps: d, issuers } = watcherDeps();
    const w = new CommandWatcher({
      dir: opDir(),
      operator: sealed,
      deps: d,
      store,
      sweepIntervalMs: 0,
    });
    await w.sweep();
    expect(issuers).toEqual(["operator"]);
    expect(result("d1")).toMatchObject({ ok: true, command: "drain", issuer: "operator" });
    expect(existsSync(join(opDir(), "d1.json"))).toBe(true);
    expect(existsSync(join(opDir(), "processed"))).toBe(false);
    expect(eventsOf(store, "command_executed")).toEqual([
      { command: "drain", file: "d1.json", issuer: "operator" },
    ]);
    // MUTATION: drop the operatorCommandHandled check in handleFile — the next two lines fail.
    await w.sweep();
    await new CommandWatcher({
      dir: opDir(),
      operator: sealed,
      deps: d,
      store,
      sweepIntervalMs: 0,
    }).sweep();
    expect(issuers).toEqual(["operator"]);
    w.stop();
  });

  it("WITHOUT the seal (the real process identity over a dir this test made): served as a SESSION's, loudly", async () => {
    mkdirSync(opDir());
    writeFileSync(join(opDir(), "d2.json"), JSON.stringify({ command: "drain", on: true }));
    const { deps: d, issuers } = watcherDeps();
    const lines: string[] = [];
    const w = new CommandWatcher({
      dir: opDir(),
      operator: processOperatorSeal(),
      deps: d,
      store,
      sweepIntervalMs: 0,
      log: (l) => lines.push(l),
    });
    await w.sweep();
    // MUTATION: make issuerFor return "operator" when unsealed — all four fail.
    expect(issuers).toEqual(["session"]);
    expect(result("d2")).toMatchObject({ issuer: "session" });
    expect(eventsOf(store, "operator_channel_unsealed")).toEqual([
      { file: "d2.json", reason: expect.stringContaining("writable by uid") },
    ]);
    expect(lines.join("\n")).toContain("NOT sealed");
    w.stop();
  });

  it("never creates the directory itself, and attaches when the operator's first write creates it", async () => {
    const { deps: d, issuers } = watcherDeps();
    const w = new CommandWatcher({
      dir: opDir(),
      operator: sealed,
      deps: d,
      store,
      sweepIntervalMs: 0,
    });
    await w.start();
    // MUTATION: let ensureDirs mkdir the operator dir — this fails.
    expect(existsSync(opDir())).toBe(false);
    expect(existsSync(join(root, "commands", "results"))).toBe(true);
    mkdirSync(opDir());
    writeFileSync(join(opDir(), ".d3.json.tmp"), JSON.stringify({ command: "drain", on: true }));
    const { renameSync } = await import("node:fs");
    renameSync(join(opDir(), ".d3.json.tmp"), join(opDir(), "d3.json"));
    for (let i = 0; i < 100 && issuers.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(issuers).toEqual(["operator"]);
    w.stop();
  });

  /** A seal that vouches for exactly the INODES it was handed — what a real
   * root-owned directory is — so a directory swapped in at the same path is
   * the session's, as it would be on the VM. */
  function inodeSeal(rootInodes: Set<bigint>, onStat?: (p: string) => void): OperatorSeal {
    return {
      euid: 1001,
      gids: [1001],
      stat: (p) => {
        onStat?.(p);
        try {
          const s = lstatSync(p, { bigint: true });
          const kind = s.isSymbolicLink()
            ? "symlink"
            : s.isDirectory()
              ? "dir"
              : s.isFile()
                ? "file"
                : "other";
          return rootInodes.has(s.ino)
            ? { uid: 0, gid: 0, mode: kind === "dir" ? 0o755 : 0o644, kind }
            : { uid: 1001, gid: 1001, mode: 0o755, kind };
        } catch {
          return null;
        }
      },
    };
  }
  const ino = (p: string): bigint => statSync(p, { bigint: true }).ino;

  it("the seal binds to the bytes executed: a directory swapped in during a parse retry is served as a session's", async () => {
    mkdirSync(opDir());
    writeFileSync(join(opDir(), "d4.json"), ""); // an empty file parses on retry
    const { deps: d, issuers } = watcherDeps();
    const w = new CommandWatcher({
      dir: opDir(),
      operator: inodeSeal(new Set([ino(opDir()), ino(join(opDir(), "d4.json"))])),
      deps: d,
      store,
      sweepIntervalMs: 0,
      parseAttempts: 3,
      parseRetryMs: 30,
    });
    const swept = w.sweep(); // the first read has happened synchronously
    renameSync(opDir(), join(root, "commands", "operator.sealed"));
    mkdirSync(opDir());
    writeFileSync(join(opDir(), "d4.json"), JSON.stringify({ command: "drain", on: true }));
    await swept;
    w.stop();
    // MUTATION: decide the issuer before the read (the old order) — this fails.
    expect(issuers).toContain("session");
    expect(issuers).not.toContain("operator");
  });

  it("the seal binds to the bytes executed: a directory swapped BACK before the seal check is still not the operator's", async () => {
    mkdirSync(opDir());
    writeFileSync(join(opDir(), "d5.json"), JSON.stringify({ command: "drain", on: true }));
    const sealedAway = join(root, "commands", "operator.sealed");
    const roots = new Set([ino(opDir()), ino(join(opDir(), "d5.json"))]);
    renameSync(opDir(), sealedAway);
    // The session's directory stands at the path while the file is read…
    mkdirSync(opDir());
    writeFileSync(join(opDir(), "d5.json"), JSON.stringify({ command: "drain", on: true }));
    const evilAway = join(root, "commands", "operator.evil");
    let swapped = false;
    const { deps: d, issuers } = watcherDeps();
    const w = new CommandWatcher({
      // …and the sealed one is back by the time the seal is checked.
      operator: inodeSeal(roots, () => {
        if (swapped) return;
        swapped = true;
        renameSync(opDir(), evilAway);
        renameSync(sealedAway, opDir());
      }),
      dir: opDir(),
      deps: d,
      store,
      sweepIntervalMs: 0,
    });
    await w.sweep();
    w.stop();
    expect(swapped).toBe(true);
    // MUTATION: drop the read-identity comparison in issuerFor — this fails.
    expect(issuers[0]).toBe("session");
    expect(eventsOf(store, "operator_channel_unsealed")[0]).toMatchObject({
      reason: expect.stringContaining("replaced"),
    });
  });

  it("a sealed operator file skips the Slack belt; an unsealed one does not", async () => {
    mkdirSync(opDir());
    writeFileSync(join(opDir(), "b1.json"), JSON.stringify({ command: "drain", on: true }));
    const guest = {
      dir: "local" as const,
      currentOrigin: () =>
        ({
          event_id: "Ev1",
          source: "slack",
          slack_user: "U0GUEST",
          tier: "anyone",
          authorized_prs: [],
        }) as never,
    };
    const { deps: d, issuers } = watcherDeps();
    await new CommandWatcher({
      dir: opDir(),
      operator: sealed,
      tier: guest,
      deps: d,
      store,
      sweepIntervalMs: 0,
    }).sweep();
    expect(issuers).toEqual(["operator"]);
    writeFileSync(join(opDir(), "b2.json"), JSON.stringify({ command: "drain", on: true }));
    await new CommandWatcher({
      dir: opDir(),
      operator: processOperatorSeal(),
      tier: guest,
      deps: d,
      store,
      sweepIntervalMs: 0,
    }).sweep();
    // MUTATION: skip tierCheck for every operator-dir file — this fails.
    expect(issuers).toEqual(["operator"]);
    expect(result("b2")).toMatchObject({ ok: false, issuer: "session" });
    expect(String(result("b2").reason)).toMatch(/^tier: this turn was caused by a Slack message/);
  });

  it("a session directory's watcher stamps session and archives as before", async () => {
    const dir = join(root, "commands");
    writeFileSync(join(dir, "s1.json"), JSON.stringify({ command: "drain", on: true }));
    const { deps: d, issuers } = watcherDeps();
    const w = new CommandWatcher({ dir, deps: d, store });
    await w.sweep();
    expect(issuers).toEqual(["session"]);
    expect(result("s1")).toMatchObject({ issuer: "session" });
    expect(existsSync(join(dir, "processed", "s1.json"))).toBe(true);
    w.stop();
  });
});

// ---- visibility -------------------------------------------------------------

describe("visibility — snapshot, qcr status, the board", () => {
  it("status.json carries who holds the drain and when it lapses, and each held PR's hold", () => {
    const { store } = clocked();
    queue(store, 31);
    store.engageDrain({ issuer: "session", expires_at: minutesFromNow(T0, 30) });
    store.pausePr(31, { issuer: "session", expires_at: minutesFromNow(T0, 60) }, "flaky CI");
    const snap = buildStatusSnapshot(store, false, undefined, () => T0);
    expect(snap).toMatchObject({
      draining: true,
      draining_by: "session",
      draining_until: minutesFromNow(T0, 30),
    });
    expect(snap.prs[0]).toMatchObject({
      paused: 1,
      pause: {
        issuer: "session",
        reason: "flaky CI",
        since: T0.toISOString(),
        expires_at: minutesFromNow(T0, 60),
      },
    });
    store.liftDrain("session");
    store.engageDrain(OPERATOR);
    const op = buildStatusSnapshot(store, false, undefined, () => T0);
    expect(op.draining_by).toBe("operator");
    expect(op).not.toHaveProperty("draining_until");
    store.resumePr(31, "session");
    expect(buildStatusSnapshot(store, false, undefined, () => T0).prs[0]).not.toHaveProperty(
      "pause",
    );
    store.close();
  });

  it("qcr status says who holds the drain, when it lapses, and which PRs are held by whom", () => {
    const base = {
      written_at: "x",
      dry_run: false,
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "x",
    } as const;
    const pr = {
      number: 31,
      state: "queued" as const,
      title: "t",
      head_sha: "abc",
      stale_recheck: 0,
    };
    const out = renderStatus({
      ...base,
      draining: true,
      draining_by: "session",
      draining_until: "2026-09-02T10:30:00.000Z",
      prs: [
        {
          ...pr,
          paused: 1,
          pause: {
            issuer: "session",
            reason: "flaky CI",
            since: null,
            expires_at: "2026-09-02T11:00:00.000Z",
          },
        },
      ],
    });
    expect(out).toContain("held by a SESSION, lapses 2026-09-02T10:30:00.000Z");
    expect(out).toContain("#31 paused by a session, lapses 2026-09-02T11:00:00.000Z — flaky CI");
    const op = renderStatus({
      ...base,
      draining: true,
      draining_by: "operator",
      prs: [
        {
          ...pr,
          paused: 1,
          pause: { issuer: "operator", reason: null, since: null, expires_at: null },
        },
      ],
    });
    expect(op).toContain("held by the operator until lifted");
    expect(op).toContain("#31 paused by the operator until resumed");
    const old = renderStatus({ ...base, draining: true, prs: [{ ...pr, paused: 1 }] });
    expect(old).toContain("holder unknown (older daemon)");
    expect(old).toContain("#31 paused (holder unknown — older daemon)");
  });

  it("the board's top bar and the PR detail name the holder and the lapse", () => {
    expect(leverHolderLabel("session", "2026-09-02T10:30:00.000Z")).toBe(
      "held by a session, lapses 10:30:00Z",
    );
    expect(leverHolderLabel("operator", undefined)).toBe("held by the operator until lifted");
    expect(leverHolderLabel(undefined, undefined)).toBe("holder unknown (older daemon)");
    const view: BoardView = {
      health: { kind: "ok", heartbeatAgeS: 5 },
      dryRun: false,
      snapshot: {
        written_at: "x",
        dry_run: false,
        prs: [],
        running_rounds: 1,
        total_spend_usd: 0,
        draining: true,
        draining_by: "session",
        draining_until: "2026-09-02T10:30:00.000Z",
        heartbeat: "x",
      },
      events: [],
      selected: 0,
      eventsFocus: false,
      eventsScroll: 0,
      help: false,
    };
    expect(stripAnsi(topBar(view, 200))).toContain(
      "DRAINING — 1 round finishing · 0 failed loud · 0 dropped · held by a session, lapses 10:30:00Z",
    );
    const pr = {
      number: 31,
      state: "queued" as const,
      title: "t",
      head_sha: "abc",
      stale_recheck: 0,
      paused: 1,
      pause: {
        issuer: "session" as const,
        reason: "flaky CI",
        since: null,
        expires_at: "2026-09-02T11:00:00.000Z",
      },
    };
    const lines = detailLines(
      { pr: 31, known: true, spend_usd: 0, rounds: [], threads: { open: 0, total: 0 } },
      pr,
      120,
      T0,
    ).map(stripAnsi);
    expect(
      lines.some((l) => l.includes("PAUSED · held by a session, lapses 11:00:00Z · flaky CI")),
    ).toBe(true);
  });
});

// ---- the operator's own path is unchanged where it matters ------------------

describe("qcr drain — the operator channel", () => {
  const ok = (stdout = ""): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });

  it("writes into commands/operator/ as root, and the manual fallback does the same", async () => {
    const writes: string[][] = [];
    const ssh = async (
      _h: string,
      argv: string[],
      opts?: { stdin?: string },
    ): Promise<RemoteResult> => {
      if (opts?.stdin !== undefined) {
        writes.push(argv);
        return ok();
      }
      return ok(
        JSON.stringify({ ok: true, draining: true, running_rounds: 0, issuer: "operator" }),
      );
    };
    const lines: string[] = [];
    expect(
      await runDrain(true, { cfg, ssh, log: (l) => lines.push(l), sleep: async () => {} }),
    ).toBe(0);
    expect(writes[0]!.slice(0, 7)).toEqual([
      "sudo",
      "docker",
      "exec",
      "-i",
      "-u",
      "0",
      cfg.tui.container,
    ]);
    expect(writes[0]![writes[0]!.length - 1]).toContain(
      `cd -P '${cfg.tui.remote_sandbox_root}/commands/operator'`,
    );
    expect(lines.join("\n")).not.toContain("NOT an operator drain");
    const manual = drainManualSshCommand(cfg.tui, true, new Date("2026-08-31T12:00:00Z"));
    expect(manual).toContain("docker exec -i -u 0");
    expect(manual).toContain("2026-08-31T12-00-00-000Z-manual-drain.json");
    expect(manual).toContain("/commands/operator'");
  });

  it("says so, loudly, when the daemon bounded the drain because the channel was unsealed", async () => {
    const ssh = async (
      _h: string,
      _a: string[],
      opts?: { stdin?: string },
    ): Promise<RemoteResult> =>
      opts?.stdin !== undefined
        ? ok()
        : ok(
            JSON.stringify({
              ok: true,
              draining: true,
              running_rounds: 0,
              issuer: "session",
              expires_at: "2026-09-02T10:30:00.000Z",
            }),
          );
    const lines: string[] = [];
    expect(
      await runDrain(true, { cfg, ssh, log: (l) => lines.push(l), sleep: async () => {} }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("NOT an operator drain");
    expect(lines.join("\n")).toContain("lapses 2026-09-02T10:30:00.000Z");
  });
});

// ---- the operator write script, RUN (a claim about what a program does is
// not reviewable by reading it) ------------------------------------------------

describe("operatorCommandWriteScript under sh", () => {
  let tmp: string;
  let fakebin: string;
  /** Runs the exact script the TUI ships, with `chown` shimmed on PATH (this
   * test is not root); the shim records what it was asked to own. */
  function runScript(
    root: string,
    name: string,
    payload: string,
    chownHook = "",
  ): { code: number; stderr: string; chown: string[] } {
    const log = join(fakebin, "chown.log");
    rmSync(log, { force: true });
    const script = operatorCommandWriteScript({ ...cfg.tui, remote_sandbox_root: root }, name);
    const res = spawnSync("sh", ["-c", script], {
      input: payload,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakebin}:${process.env["PATH"] ?? ""}`,
        CHOWN_LOG: log,
        CHOWN_HOOK: chownHook,
      },
    });
    const chown = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
    return { code: res.status ?? -1, stderr: res.stderr, chown };
  }

  beforeEach(() => {
    // Physical path: the script compares its working directory to the
    // configured one, and a symlinked TMPDIR would read as a swapped directory.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "qcr-opscript-")));
    fakebin = join(tmp, "bin");
    mkdirSync(fakebin);
    // The shim logs what it was asked AND where it stood (the script works
    // relative to the directory it verified), then runs an optional hook — the
    // racing session, acting in the window between two root operations.
    writeFileSync(
      join(fakebin, "chown"),
      '#!/bin/sh\necho "$@ @ $(pwd -P)" >> "$CHOWN_LOG"\n[ -z "$CHOWN_HOOK" ] || sh -c "$CHOWN_HOOK"\n',
    );
    chmodSync(join(fakebin, "chown"), 0o755);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("refuses when the daemon's commands/ root does not exist", () => {
    const root = join(tmp, "sandbox");
    mkdirSync(root);
    const r = runScript(root, "a.json", "{}");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing");
    expect(existsSync(join(root, "commands"))).toBe(false);
    expect(r.chown).toEqual([]);
  });

  it("refuses when commands/operator is a SYMLINK a session could have planted — nothing is chowned, nothing written", () => {
    const root = join(tmp, "sandbox");
    const target = join(tmp, "elsewhere");
    mkdirSync(join(root, "commands"), { recursive: true });
    mkdirSync(target);
    symlinkSync(target, join(root, "commands", "operator"));
    // MUTATION: drop the `[ ! -L dir ]` guard — the write lands in `target`
    // and chown is asked to take it over.
    const r = runScript(root, "b.json", "{}");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("symlink");
    expect(r.chown).toEqual([]);
    expect(existsSync(join(target, "b.json"))).toBe(false);
  });

  it("creates the directory, claims it for root, and lands the file 0644 by tmp+mv", () => {
    const root = join(tmp, "sandbox");
    mkdirSync(join(root, "commands"), { recursive: true });
    const r = runScript(root, "c.json", '{"command":"drain","on":true}');
    expect(r.code).toBe(0);
    const dir = join(root, "commands", "operator");
    // MUTATION: drop `chown -h 0:0` from the script — the first line fails;
    // drop `chmod 0644` — the mode line fails (the shell's umask decides).
    expect(r.chown).toEqual([`-h 0:0 . @ ${dir}`]);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, "c.json"), "utf8")).toBe('{"command":"drain","on":true}');
    expect(statSync(join(dir, "c.json")).mode & 0o777).toBe(0o644);
    expect(existsSync(join(dir, ".c.json.tmp"))).toBe(false);
  });

  it("takes over a plain directory a session pre-made instead of refusing", () => {
    const root = join(tmp, "sandbox");
    const dir = join(root, "commands", "operator");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    const r = runScript(root, "d.json", "{}");
    expect(r.code).toBe(0);
    expect(r.chown).toEqual([`-h 0:0 . @ ${dir}`]);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(existsSync(join(dir, "d.json"))).toBe(true);
  });

  it("a session swapping operator/ for a symlink MID-SCRIPT gets neither the chmod nor the write", () => {
    // commands/ is the session uid's, so it can rename the directory the
    // script just checked and put a link in its place. The script is bound to
    // the directory it verified, so root's chmod and write never follow.
    const root = join(tmp, "sandbox");
    const cmds = join(root, "commands");
    const dir = join(cmds, "operator");
    const target = join(tmp, "elsewhere");
    mkdirSync(cmds, { recursive: true });
    mkdirSync(target);
    chmodSync(target, 0o700);
    const swap = `mv '${dir}' '${cmds}/moved' && ln -s '${target}' '${dir}'`;
    runScript(root, "f.json", "{}", swap);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(existsSync(join(target, "f.json"))).toBe(false);
    expect(existsSync(join(target, ".f.json.tmp"))).toBe(false);
  });

  it("a symlink pre-planted at the temp-file name is never written through", () => {
    // A session pre-makes operator/ holding `.<name>.tmp` -> a root-writable
    // file. Taking the directory over keeps its entries, so the script must
    // not open that name before clearing it.
    const root = join(tmp, "sandbox");
    const dir = join(root, "commands", "operator");
    mkdirSync(dir, { recursive: true });
    const victim = join(tmp, "victim");
    writeFileSync(victim, "precious");
    symlinkSync(victim, join(dir, ".g.json.tmp"));
    const r = runScript(root, "g.json", '{"command":"drain","on":false}');
    expect(r.code).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(lstatSync(join(dir, "g.json")).isFile()).toBe(true);
    expect(readFileSync(join(dir, "g.json"), "utf8")).toBe('{"command":"drain","on":false}');
  });

  it("the printed manual ssh fallback runs the same script intact through both shells", () => {
    // The fallback wraps the script in a local double-quoted string, so every
    // `$`, `"` and backslash in it must survive the LOCAL shell untouched.
    const root = join(tmp, "sandbox");
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(fakebin, "ssh"), '#!/bin/sh\nshift\nexec sh -c "$*"\n');
    writeFileSync(
      join(fakebin, "docker"),
      '#!/bin/sh\nwhile [ "$1" != sh ]; do shift; done\nexec "$@"\n',
    );
    chmodSync(join(fakebin, "ssh"), 0o755);
    chmodSync(join(fakebin, "docker"), 0o755);
    const tui = { ...cfg.tui, sudo_docker: false, remote_sandbox_root: root };
    const manual = drainManualSshCommand(tui, true, new Date("2026-08-31T12:00:00Z"));
    const res = spawnSync("sh", ["-c", manual], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakebin}:${process.env["PATH"] ?? ""}`,
        CHOWN_LOG: join(fakebin, "chown.log"),
        CHOWN_HOOK: "",
      },
    });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    const file = join(root, "commands", "operator", "2026-08-31T12-00-00-000Z-manual-drain.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ command: "drain", on: true });
  });
});

// ---- helpers ----------------------------------------------------------------

function bootAdapter(): DaemonAdapter {
  const pr: PrRef = {
    number: 101,
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
  } as unknown as DaemonAdapter;
}
