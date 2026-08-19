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

  it("a live session keeps the legacy overdue-anomaly park", async () => {
    const roundId = reviewingRound(301);
    pastDeadline();
    const { hooks, overseer } = hooksWith(true);

    expect(await watcher(hooks).checkDeadlines()).toEqual([301]);
    expect(roundStatus(roundId)).toBe("overdue");
    expect(store.getPr(301)!.state).toBe("awaiting_human");
    expect(overseer.some((m) => m.startsWith("ANOMALY (overdue)"))).toBe(true);
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("degrades to the anomaly park when no liveness signal exists (stub hooks)", async () => {
    reviewingRound(302);
    pastDeadline();
    const { hooks } = hooksWith(undefined);

    expect(await watcher(hooks).checkDeadlines()).toEqual([302]);
    expect(store.getPr(302)!.state).toBe("awaiting_human");
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
    expect(store.getPr(303)!.state).toBe("awaiting_human");
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
  it("past the cap the round terminalizes through the anomaly park, with its own event", async () => {
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
    expect(store.getPr(310)!.state).toBe("awaiting_human");
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
