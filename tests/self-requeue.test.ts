// stuck-round self-requeue. A round that is overdue, has no verdict
// on disk and whose session is DEAD is requeued by the daemon itself (through
// the normal dispatch path), capped per PR head; past the cap the round
// terminalizes through the existing overdue-anomaly park. Failed/self-requeued
// rounds never age the PR (verdicted-only priorRoundCount discipline), and the
// restart orphan-requeue path and this one can never double-dispatch a round.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_SELF_REQUEUES, parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, roundTypeFor, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { reconcileOrphanedRounds } from "../src/reconcile.js";
import { StateStore } from "../src/state.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";

const baseCfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));

class FakeVerdictAdapter implements VerdictAdapter {
  calls: string[] = [];
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`addLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push(`removeLabel:${n}:${label}`);
    return { executed: false, dryRunFile: "d" };
  }
}

/** SessionHooks with a controllable liveness signal. `alive === undefined`
 * models a stub with no signal at all (the hook is absent). */
function hooksWith(alive?: boolean | (() => boolean)): {
  hooks: SessionHooks;
  overseer: string[];
  injects: string[];
} {
  const overseer: string[] = [];
  const injects: string[] = [];
  const hooks: SessionHooks = {
    async dispatchRound() {},
    async inject(pr, msg) {
      injects.push(`${pr}:${msg}`);
    },
    async injectOverseer(msg) {
      overseer.push(msg);
    },
    async archiveAndClose() {},
  };
  if (alive !== undefined) {
    hooks.sessionAlive = async () => (typeof alive === "function" ? alive() : alive);
  }
  return { hooks, overseer, injects };
}

let dir: string;
let store: StateStore;
let adapter: FakeVerdictAdapter;
let clock: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-selfrequeue-"));
  clock = new Date("2026-08-19T12:00:00Z");
  store = new StateStore(":memory:", () => clock);
  adapter = new FakeVerdictAdapter();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function reviewingRound(pr: number, head = "abc123"): number {
  store.upsertPr({
    number: pr,
    state: "reviewing",
    head_sha: head,
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  return store.startRound(pr, "first", ["pass-baseline", "pass-validate"], baseCfg.daemon.round_deadline_min);
}

function watcher(hooks: SessionHooks, cfg: Config = baseCfg): VerdictWatcher {
  // Mirror daemon.ts's wiring: anomaly wakes flow store → sink → hooks.
  const policy = new AnomalyWakePolicy({ injectOverseer: (m) => hooks.injectOverseer(m) });
  store.setAnomalySink((sig) => policy.onAnomaly(sig));
  return new VerdictWatcher({
    cfg,
    store,
    adapter,
    hooks,
    verdictDir: dir,
    root: dir,
    usage: { globalStoreDir: null },
    parseRetries: 0,
    retryDelayMs: 1,
    now: () => clock,
  });
}

function pastDeadline(): void {
  clock = new Date(clock.getTime() + (baseCfg.daemon.round_deadline_min + 5) * 60_000);
}

function events(kind: string): Array<{ pr: number | null; payload: any }> {
  return (store.db.prepare("SELECT pr, payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Array<{ pr: number | null; payload: string | null }>).map(
    (r) => ({ pr: r.pr, payload: r.payload ? JSON.parse(r.payload) : null }),
  );
}

function roundStatus(id: number): string {
  return (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(id) as { status: string }).status;
}

describe("stuck-round detection + self-requeue", () => {
  it("requeues an overdue round with no verdict and a dead session — no restart needed", async () => {
    const roundId = reviewingRound(300);
    pastDeadline();
    const { hooks, overseer } = hooksWith(false);

    expect(await watcher(hooks).checkDeadlines()).toEqual([]); // not an anomaly

    // Round terminalized administratively (cancelled, verdict NULL), PR re-queued.
    expect(roundStatus(roundId)).toBe("cancelled");
    const row = store.getPr(300)!;
    expect(row.state).toBe("queued");
    expect(row.trigger_ts).toBe(clock.toISOString());
    // Loud: event log carries pr/round/attempt/reason, overseer told.
    const requeued = events("round_self_requeued");
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.pr).toBe(300);
    expect(requeued[0]!.payload).toMatchObject({ round_no: 1, attempt: 1, head_sha: "abc123" });
    expect(String(requeued[0]!.payload.reason)).toContain("session is dead");
    expect(overseer.some((m) => m.startsWith("SELF-REQUEUE (recovery) — PR #300 round 1, attempt 1/"))).toBe(true);
    // Never the anomaly park, never awaiting_human, no round_overdue event.
    expect(events("round_overdue")).toHaveLength(0);
    expect(row.state).not.toBe("awaiting_human");
    // Session-side only: no gate/adapter mutation at all (dry-run safe by construction).
    expect(adapter.calls).toEqual([]);
  });

  it("a live session with no killSession hook keeps the legacy overdue-anomaly path (no park since 2026-08-19)", async () => {
    const roundId = reviewingRound(301);
    pastDeadline();
    const { hooks, overseer } = hooksWith(true);

    expect(await watcher(hooks).checkDeadlines()).toEqual([301]);
    expect(roundStatus(roundId)).toBe("overdue");
    expect(store.getPr(301)!.state).toBe("tracked"); // no park (retired 2026-08-19): returned to standing state
    expect(overseer.some((m) => m.startsWith("ANOMALY (overdue)"))).toBe(true);
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("degrades to the anomaly park when no liveness signal exists (stub hooks)", async () => {
    reviewingRound(302);
    pastDeadline();
    const { hooks } = hooksWith(undefined);

    expect(await watcher(hooks).checkDeadlines()).toEqual([302]);
    expect(store.getPr(302)!.state).toBe("tracked");
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("degrades to the anomaly park when the liveness probe throws", async () => {
    reviewingRound(303);
    pastDeadline();
    const { hooks } = hooksWith(undefined);
    hooks.sessionAlive = async () => {
      throw new Error("tmux exploded");
    };

    expect(await watcher(hooks).checkDeadlines()).toEqual([303]);
    expect(store.getPr(303)!.state).toBe("tracked");
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("a pending verdict file wins: no requeue, no anomaly — the sweep owns it", async () => {
    const roundId = reviewingRound(304);
    pastDeadline();
    writeFileSync(join(dir, "pr-304-round-1.json"), "{}"); // present is enough; the sweep validates
    const { hooks } = hooksWith(false);

    expect(await watcher(hooks).checkDeadlines()).toEqual([]);
    expect(roundStatus(roundId)).toBe("running");
    expect(store.getPr(304)!.state).toBe("reviewing");
    expect(events("round_self_requeued")).toHaveLength(0);
    expect(events("round_overdue")).toHaveLength(0);
  });

  it("a superseded round is still cancelled silently, never self-requeued", async () => {
    const oldRound = reviewingRound(305);
    pastDeadline();
    store.startRound(305, "re-review", ["pass-baseline"], baseCfg.daemon.round_deadline_min); // newer round, inside deadline
    const { hooks } = hooksWith(false);

    expect(await watcher(hooks).checkDeadlines()).toEqual([]);
    expect(roundStatus(oldRound)).toBe("cancelled");
    expect(events("round_self_requeued")).toHaveLength(0);
    expect(events("round_superseded")).toHaveLength(1);
  });
});

describe("the per-head cap", () => {
  it("past the cap the round terminalizes through the anomaly path, with its own event", async () => {
    const cap = baseCfg.daemon.max_self_requeues ?? DEFAULT_MAX_SELF_REQUEUES;
    const { hooks, overseer } = hooksWith(false);
    const w = watcher(hooks);

    let lastRoundId = 0;
    for (let i = 0; i < cap; i++) {
      lastRoundId = reviewingRound(310); // re-queue resets state; new running round each time
      pastDeadline();
      expect(await w.checkDeadlines()).toEqual([]);
      expect(roundStatus(lastRoundId)).toBe("cancelled");
    }
    expect(events("round_self_requeued")).toHaveLength(cap);

    // Attempt cap+1 at the SAME head: no more requeues.
    lastRoundId = reviewingRound(310);
    pastDeadline();
    expect(await w.checkDeadlines()).toEqual([310]);
    expect(roundStatus(lastRoundId)).toBe("overdue");
    expect(store.getPr(310)!.state).toBe("tracked"); // no park: returned to standing state, anomaly raised
    expect(events("round_self_requeued")).toHaveLength(cap); // unchanged
    expect(events("self_requeue_cap_exhausted")).toHaveLength(1);
    expect(events("self_requeue_cap_exhausted")[0]!.payload).toMatchObject({ head_sha: "abc123", attempts: cap, cap });
    const anomaly = overseer.find((m) => m.startsWith("ANOMALY (overdue)"));
    expect(anomaly).toContain("self-requeue cap is exhausted");
  });

  it("a new head resets the budget", async () => {
    const cap = 1;
    const cfg: Config = { ...baseCfg, daemon: { ...baseCfg.daemon, max_self_requeues: cap } };
    const { hooks } = hooksWith(false);
    const w = watcher(hooks, cfg);

    reviewingRound(311, "head-one");
    pastDeadline();
    expect(await w.checkDeadlines()).toEqual([]);
    expect(events("round_self_requeued")).toHaveLength(1);

    // Cap spent at head-one…
    reviewingRound(311, "head-one");
    pastDeadline();
    expect(await w.checkDeadlines()).toEqual([311]);
    expect(events("self_requeue_cap_exhausted")).toHaveLength(1);

    // …but a push to head-two starts a fresh budget.
    const atNewHead = reviewingRound(311, "head-two");
    pastDeadline();
    expect(await w.checkDeadlines()).toEqual([]);
    expect(roundStatus(atNewHead)).toBe("cancelled");
    expect(events("round_self_requeued")).toHaveLength(2);
    expect(store.selfRequeueCount(311, "head-two")).toBe(1);
    expect(store.selfRequeueCount(311, "head-one")).toBe(1);
  });

  it("max_self_requeues is config-knobbed and defaults to 2", () => {
    expect(DEFAULT_MAX_SELF_REQUEUES).toBe(2);
    const noKnob = parseConfig(
      readFileSync(resolve(process.cwd(), "config.toml"), "utf8").replace(/^max_self_requeues.*$/m, ""),
    );
    expect(noKnob.daemon.max_self_requeues).toBe(2);
    expect(baseCfg.daemon.max_self_requeues).toBe(2); // the shipped knob
  });
});

// ---- review_no discipline + no double-dispatch with the orphan path --------

class FakeDispatchAdapter implements DispatchAdapter {
  files = new Map<number, PrFileEntry[]>();
  async getPr(): Promise<{ base_ref: string }> {
    return { base_ref: "master" };
  }
  async listPrFiles(n: number): Promise<PrFileEntry[]> {
    return this.files.get(n) ?? [{ filename: "a.py", additions: 5, deletions: 1, status: "modified" }];
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

function dispatchHooks(): { hooks: SessionHooks; orders: RoundOrder[] } {
  const orders: RoundOrder[] = [];
  return {
    orders,
    hooks: {
      async dispatchRound(order) {
        orders.push(order);
      },
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    },
  };
}

describe("self-requeued rounds do not age the PR", () => {
  it("priorRoundCount ignores the cancelled round; the fresh dispatch is still round_type 'first', review_no 1", async () => {
    reviewingRound(320);
    pastDeadline();
    const { hooks } = hooksWith(false);
    await watcher(hooks).checkDeadlines();

    expect(store.priorRoundCount(320)).toBe(0); // verdicted-only discipline intact
    expect(roundTypeFor(store.getPr(320)!, store.priorRoundCount(320))).toBe("first");

    const d = dispatchHooks();
    const orders = await dispatchOnce({ cfg: baseCfg, store, adapter: new FakeDispatchAdapter(), hooks: d.hooks });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.round_type).toBe("first");
    expect(orders[0]!.review_no).toBe(1);
    expect(orders[0]!.round_no).toBe(2); // round_no advances; review age does not
  });
});

describe("idempotency against the restart orphan-requeue", () => {
  it("self-requeue first: the orphan sweep finds nothing running and dispatch runs exactly once", async () => {
    reviewingRound(330);
    pastDeadline();
    const { hooks } = hooksWith(false);
    await watcher(hooks).checkDeadlines(); // self-requeue wins the race

    // A restart lands right after: no session adopted for #330.
    const report = reconcileOrphanedRounds(store, [], { botLogin: "bot[bot]", now: () => clock });
    expect(report.cancelled).toEqual([]);
    expect(report.requeued).toEqual([]);
    expect(events("orphaned_round_requeued")).toHaveLength(0);

    const d = dispatchHooks();
    const orders = await dispatchOnce({ cfg: baseCfg, store, adapter: new FakeDispatchAdapter(), hooks: d.hooks });
    expect(orders).toHaveLength(1); // one queued row ⇒ one round, ever
    expect(store.runningRounds()).toHaveLength(1);
  });

  it("orphan-requeue first: the deadline checker has nothing left to self-requeue", async () => {
    reviewingRound(331);
    pastDeadline();
    const report = reconcileOrphanedRounds(store, [], { botLogin: "bot[bot]", now: () => clock });
    expect(report.requeued).toEqual([331]);

    const { hooks } = hooksWith(false);
    expect(await watcher(hooks).checkDeadlines()).toEqual([]); // no running round to act on
    expect(events("round_self_requeued")).toHaveLength(0);

    const d = dispatchHooks();
    const orders = await dispatchOnce({ cfg: baseCfg, store, adapter: new FakeDispatchAdapter(), hooks: d.hooks });
    expect(orders).toHaveLength(1);
  });

  it("a requeued PR whose replacement round is already running is not dispatched again", async () => {
    // The queued-while-running guard in dispatch: requeue raced a running round.
    reviewingRound(332);
    store.upsertPr({ ...store.getPr(332)!, state: "queued", trigger_ts: clock.toISOString() });
    const d = dispatchHooks();
    const orders = await dispatchOnce({ cfg: baseCfg, store, adapter: new FakeDispatchAdapter(), hooks: d.hooks });
    expect(orders).toHaveLength(0);
  });
});


// 2026-08-19 (the owner): recover, don't park — a live-but-wedged session is
// killed and its round requeued through the same capped path, and a
// NEEDS_HUMAN verdict with no executed-pass evidence is an unfinished review
// that gets redone instead of handed to a person.
describe("live-but-stuck recovery", () => {
  it("kills the wedged live session and self-requeues the round", async () => {
    const roundId = reviewingRound(310);
    pastDeadline();
    const { hooks, overseer } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };

    expect(await watcher(hooks).checkDeadlines()).toEqual([]);
    expect(killed).toEqual([310]);
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(310)!.state).toBe("queued");
    const requeued = events("round_self_requeued");
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.payload).toMatchObject({ mode: "alive_stuck" });
    expect(String(requeued[0]!.payload.reason)).toContain("wedged");
    expect(overseer.some((m) => m.startsWith("SELF-REQUEUE (recovery) — PR #310"))).toBe(true);
    expect(events("round_overdue")).toHaveLength(0);
  });

  it("a live session with a pending verdict file is left to the sweep, never killed", async () => {
    reviewingRound(311);
    pastDeadline();
    const { hooks } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    writeFileSync(join(dir, "pr-311-round-1.json"), "{}");

    expect(await watcher(hooks).checkDeadlines()).toEqual([]);
    expect(killed).toEqual([]);
    expect(events("round_self_requeued")).toHaveLength(0);
    expect(events("round_overdue")).toHaveLength(0);
  });

  it("past the cap a wedged live round still terminalizes through the anomaly path", async () => {
    const { hooks } = hooksWith(true);
    hooks.killSession = async () => {};
    const w = watcher(hooks);
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      reviewingRound(312);
      pastDeadline();
      await w.checkDeadlines();
    }
    const roundId = reviewingRound(312);
    pastDeadline();
    expect(await w.checkDeadlines()).toEqual([312]);
    expect(roundStatus(roundId)).toBe("overdue");
    expect(store.getPr(312)!.state).toBe("tracked");
  });
});

describe("NEEDS_HUMAN requires a finished review", () => {
  function needsHumanFile(pr: number, roundNo: number, extra: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, `pr-${pr}-round-${roundNo}.json`),
      JSON.stringify({
        pr,
        round_no: roundNo,
        verdict: "NEEDS_HUMAN",
        ai_approved: true,
        head_sha: "abc123",
        finished_at: clock.toISOString(),
        ...extra,
      }),
    );
  }

  it("no executed passes ⇒ the round is redone (self-requeue), never parked, no reviewed-head mark", async () => {
    const roundId = reviewingRound(320);
    const { hooks } = hooksWith();
    needsHumanFile(320, 1);

    await watcher(hooks).sweep();

    expect(roundStatus(roundId)).toBe("cancelled");
    const row = store.getPr(320)!;
    expect(row.state).toBe("queued");
    expect(events("needs_human_incomplete")).toHaveLength(1);
    const requeued = events("round_self_requeued");
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.payload).toMatchObject({ mode: "needs_human_incomplete" });
    // No mark: the redo round must be dispatchable and postable at this head.
    expect(store.reviewedHead(320)).toBeUndefined();
    // The in-progress label came off; the reviewed label was NOT applied.
    expect(adapter.calls.some((c) => c.startsWith("removeLabel:320"))).toBe(true);
    expect(adapter.calls.some((c) => c.startsWith("addLabel:320"))).toBe(false);
  });

  it("with executed passes a legacy NEEDS_HUMAN lands tracked (park retired), not requeued", async () => {
    reviewingRound(321);
    const { hooks } = hooksWith();
    needsHumanFile(321, 1, { passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }] });

    await watcher(hooks).sweep();

    expect(store.getPr(321)!.state).toBe("tracked");
    expect(events("round_self_requeued")).toHaveLength(0);
    expect(store.reviewedHead(321)).toBeDefined();
  });

  it("past the cap an incomplete NEEDS_HUMAN applies like any verdict (tracked, no park)", async () => {
    const { hooks } = hooksWith();
    const w = watcher(hooks);
    const latestRoundNo = () =>
      (store.db.prepare("SELECT round_no FROM rounds WHERE pr = 322 ORDER BY id DESC LIMIT 1").get() as { round_no: number }).round_no;
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      reviewingRound(322);
      needsHumanFile(322, latestRoundNo());
      await w.sweep();
      expect(store.getPr(322)!.state).toBe("queued");
    }
    reviewingRound(322);
    needsHumanFile(322, latestRoundNo());
    await w.sweep();
    expect(store.getPr(322)!.state).toBe("tracked");
    expect(events("self_requeue_cap_exhausted")).toHaveLength(1);
  });
});
