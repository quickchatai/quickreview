// stuck-round self-requeue. A round that is overdue, has no verdict
// on disk and whose session is DEAD is requeued by the daemon itself (through
// the normal dispatch path), capped per PR head; past the cap the round
// terminalizes through the existing overdue-anomaly park. Failed/self-requeued
// rounds never age the PR (verdicted-only priorRoundCount discipline), and the
// restart orphan-requeue path and this one can never double-dispatch a round.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { roundPromptMarker } from "../src/types.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";

const baseCfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"));

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

function reviewingRound(pr: number, head = "abc123", opts: { stampMarker?: boolean } = {}): number {
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
  const id = store.startRound(pr, "first", ["pass-baseline", "pass-validate"], baseCfg.daemon.round_deadline_min);
  // Dispatch stamps the receipt token (#5362); a round without one was
  // dispatched by an older build and is deliberately unjudgeable.
  if (opts.stampMarker !== false) store.stampPromptMarker(id, roundPromptMarker(pr, store.roundsFor(pr).length));
  return id;
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

function silentSince(id: number): string | null {
  return (store.db.prepare("SELECT silent_since FROM rounds WHERE id = ?").get(id) as { silent_since: string | null }).silent_since;
}

describe("bounded infrastructure-stage recovery", () => {
  it("reuses the ordinary capped self-requeue path without producing a merits verdict", async () => {
    const roundId = reviewingRound(290);
    const { hooks, overseer } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => { killed.push(pr); };
    const v = watcher(hooks);

    expect(await v.recoverInfrastructureFailure(290, 1, "settled_without_verdict", "parent settled with no verdict")).toBe("requeued");

    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(290)).toMatchObject({ state: "queued" });
    expect(killed).toEqual([]); // a fully settled sticky session is healthy and retained
    expect(events("round_self_requeued")[0]?.payload).toMatchObject({ mode: "infrastructure_settled", cancel_cause: "infrastructure_failure" });
    expect(store.roundsFor(290)[0]?.verdict).toBeNull();
    expect(adapter.calls).toEqual([]);
    expect(overseer.some((m) => m.includes("SELF-REQUEUE (recovery)"))).toBe(true);
  });

  it("strictly stops an active timed-out session before requeueing", async () => {
    reviewingRound(292);
    const { hooks } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => { killed.push(pr); };
    const v = watcher(hooks);

    expect(await v.recoverInfrastructureFailure(292, 1, "running_hard_bound", "fixed bound exhausted")).toBe("requeued");
    expect(killed).toEqual([292]);
    expect(events("round_self_requeued")[0]?.payload).toMatchObject({ mode: "infrastructure_active" });
  });

  it("lets a verdict that wins during strict stop go to the verdict sweep", async () => {
    reviewingRound(293);
    const { hooks } = hooksWith(true);
    hooks.killSession = async () => {
      writeFileSync(join(dir, "pr-293-round-1.json"), "{}");
    };
    const v = watcher(hooks);

    expect(await v.recoverInfrastructureFailure(293, 1, "running_hard_bound", "fixed bound exhausted")).toBe("retryable");
    expect(store.roundsFor(293)[0]?.status).toBe("running");
    expect(events("round_stage_verdict_won")).toHaveLength(1);
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("returns exhausted at the ordinary recovery cap, stops Pi, and frees round capacity", async () => {
    reviewingRound(291);
    const { hooks } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => { killed.push(pr); };
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      store.logEvent("round_self_requeued", 291, { head_sha: "abc123" });
    }
    const v = watcher(hooks);

    expect(await v.recoverInfrastructureFailure(291, 1, "running_hard_bound", "fixed bound exhausted")).toBe("exhausted");
    expect(killed).toEqual([291]);
    expect(store.roundsFor(291)[0]).toMatchObject({ status: "cancelled", cancel_cause: "infrastructure_failure", verdict: null });
    expect(store.getPr(291)?.state).toBe("queued");
    expect(store.openReviewFailure(291)).toMatchObject({
      work_owed: 1,
      stage: "running_hard_bound",
      attempts: DEFAULT_MAX_SELF_REQUEUES,
      next_action: "operator_unwedge",
    });
  });
});

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
    expect(store.getPr(301)!.state).toBe("queued"); // FAILED_LOUD hold: work remains owed
    expect(store.openReviewFailure(301)?.stage).toBe("round_deadline");
    expect(overseer.some((m) => m.startsWith("ANOMALY (overdue)"))).toBe(true);
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("degrades to the anomaly park when no liveness signal exists (stub hooks)", async () => {
    reviewingRound(302);
    pastDeadline();
    const { hooks } = hooksWith(undefined);

    expect(await watcher(hooks).checkDeadlines()).toEqual([302]);
    expect(store.getPr(302)!.state).toBe("queued");
    expect(store.openReviewFailure(302)?.work_owed).toBe(1);
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
    expect(store.getPr(303)!.state).toBe("queued");
    expect(store.openReviewFailure(303)?.work_owed).toBe(1);
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
    expect(store.getPr(310)!.state).toBe("queued"); // FAILED_LOUD, not an ordinary standing state
    expect(store.openReviewFailure(310)?.work_owed).toBe(1);
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
      readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8").replace(/^max_self_requeues.*$/m, ""),
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
    expect(store.getPr(312)!.state).toBe("queued");
    expect(store.openReviewFailure(312)?.work_owed).toBe(1);
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

// ---- / #5362: the lost-prompt net, rebuilt on a receipt ------------
//
// The original net inferred loss from a session-JSONL mtime and fired ZERO
// times in the eight days it was live. Two independent reasons, the second
// structural: it refused to act once the head had spent a self-requeue (and a
// `head_moved` requeue spends one four seconds before dispatching the round
// most likely to be lost), and it required "no activity since the round
// started" — but a prompt is dropped precisely BECAUSE the agent is busy, and
// a busy agent always has activity after round start.
//
// `roundPromptAccepted` replaces the inference with a fact: the dispatched
// receipt token is echoed into the session JSONL only when pi accepted the
// message. false = provably never arrived, true = the session owns it, null =
// no evidence. And because a missing prompt is a DELIVERY fault, recovery is
// cheap first: re-deliver the same order to the same session, and escalate to
// a cancelled round only when redelivery is spent or impossible.

describe("lost-prompt net (#5362) — a round with no prompt receipt", () => {
  const GRACE_MIN = baseCfg.daemon.round_stall_grace_min ?? 10;

  /** hooksWith + the observation hooks, with redelivery ALWAYS failing so the
   * escalation half can be exercised on its own. `accepted` mirrors what
   * `roundPromptAccepted` reports. */
  function netHooks(opts: { pending: boolean; accepted: boolean | null }): ReturnType<typeof hooksWith> & {
    redelivered: number[];
  } {
    const h = hooksWith(true);
    const redelivered: number[] = [];
    h.hooks.injectPending = async () => opts.pending;
    h.hooks.roundPromptAccepted = async () => opts.accepted;
    h.hooks.redeliverRound = async (pr) => {
      redelivered.push(pr);
      return false; // no saved prompt — the caller must escalate
    };
    return { ...h, redelivered };
  }

  /** The same, but redelivery succeeds — the cheap recovery. */
  function netHooksDelivering(opts: { accepted: boolean | null }): ReturnType<typeof hooksWith> & {
    redelivered: Array<{ pr: number; round: number }>;
  } {
    const h = hooksWith(true);
    const redelivered: Array<{ pr: number; round: number }> = [];
    h.hooks.injectPending = async () => false;
    h.hooks.roundPromptAccepted = async () => opts.accepted;
    h.hooks.redeliverRound = async (pr, roundNo) => {
      redelivered.push({ pr, round: roundNo });
      return true;
    };
    return { ...h, redelivered };
  }

  function pastGrace(): void {
    clock = new Date(clock.getTime() + (GRACE_MIN + 5) * 60_000); // grace blown, deadline not
  }

  it("RE-DELIVERS on the second sweep — the round, the session and the conversation all survive", async () => {
    const roundId = reviewingRound(310);
    pastGrace();
    const { hooks, redelivered } = netHooksDelivering({ accepted: false });
    const w = watcher(hooks);

    // Sweep 1: no receipt — the mark is stamped, nothing acts yet.
    expect(await w.checkDeadlines()).toEqual([]);
    expect(roundStatus(roundId)).toBe("running");
    expect(silentSince(roundId)).not.toBeNull();
    expect(redelivered).toHaveLength(0);

    // Sweep 2: still no receipt — the order goes out again.
    clock = new Date(clock.getTime() + 60_000);
    expect(await w.checkDeadlines()).toEqual([]);
    expect(redelivered).toEqual([{ pr: 310, round: 1 }]);
    expect(events("round_prompt_lost")).toHaveLength(1);
    expect(events("round_prompt_redelivered")[0]!.payload).toMatchObject({ attempt: 1, round_no: 1 });

    // THE POINT: this is a delivery fault, so nothing expensive happened.
    expect(roundStatus(roundId)).toBe("running");
    expect(store.getPr(310)!.state).toBe("reviewing");
    expect(events("round_self_requeued")).toHaveLength(0);
    // …and the window resets, so the next escalation must be re-earned.
    expect(silentSince(roundId)).toBeNull();
  });

  it("escalates to a self-requeue only once redelivery is exhausted", async () => {
    const roundId = reviewingRound(320);
    pastGrace();
    const { hooks } = netHooksDelivering({ accepted: false });
    const w = watcher(hooks);
    const cap = baseCfg.daemon.max_prompt_redeliveries ?? 2;

    for (let attempt = 1; attempt <= cap; attempt++) {
      await w.checkDeadlines(); // marks
      clock = new Date(clock.getTime() + 60_000);
      await w.checkDeadlines(); // redelivers
      clock = new Date(clock.getTime() + 60_000);
    }
    expect(events("round_prompt_redelivered")).toHaveLength(cap);
    expect(events("round_self_requeued")).toHaveLength(0);

    // The budget is spent: the next confirmed loss is a real failure.
    await w.checkDeadlines();
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines();
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(320)!.state).toBe("queued");
    expect(events("round_self_requeued")[0]!.payload).toMatchObject({ mode: "lost_prompt" });
  });

  it("escalates immediately when there is no saved prompt to re-deliver", async () => {
    const roundId = reviewingRound(321);
    pastGrace();
    const { hooks, redelivered } = netHooks({ pending: false, accepted: false });
    const w = watcher(hooks);

    await w.checkDeadlines();
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines();

    expect(redelivered).toEqual([321]);
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(events("round_self_requeued")).toHaveLength(1);
  });

  it("a HEAD_MOVED requeue no longer disarms the net — the #5362 regression", async () => {
    // This is the interaction that wedged #5362 for its full deadline. The old
    // net gave up once the head had spent a self-requeue, and `head_moved`
    // spends one FOUR SECONDS before dispatching the round whose delivery
    // races the session's still-running turn. The most loss-prone dispatch in
    // the system was the one dispatch the net refused to watch.
    const pr = 322;
    const first = reviewingRound(pr);
    store.markRoundCancelled(first, "self-requeue 1/2 — head_moved");
    // The head_moved requeue, exactly as verdicts.ts records it — this is the
    // event the old net read as "budget spent, stand down".
    store.logEvent("round_self_requeued", pr, { head_sha: "abc123", mode: "head_moved", attempt: 1 });
    const second = reviewingRound(pr); // the redispatch, whose prompt is lost
    pastGrace();
    const { hooks, redelivered } = netHooksDelivering({ accepted: false });
    const w = watcher(hooks);

    await w.checkDeadlines();
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines();

    expect(redelivered).toEqual([{ pr, round: 2 }]);
    expect(roundStatus(second)).toBe("running"); // recovered without cancelling
  });

  it("does nothing while the inject file is still pending — the bridge is retrying, not losing", async () => {
    const roundId = reviewingRound(311);
    pastGrace();
    const { hooks, redelivered } = netHooks({ pending: true, accepted: false });

    await watcher(hooks).checkDeadlines();
    expect(roundStatus(roundId)).toBe("running");
    expect(redelivered).toHaveLength(0);
    expect(silentSince(roundId)).toBeNull();
  });

  it("does nothing when the receipt IS there — a busy session is not a lost prompt", async () => {
    // The case the old net could not express. #5362's session had activity
    // after round start (it was finishing the previous turn), which the mtime
    // inference read as "alive, so not lost". The receipt separates the two:
    // activity is irrelevant, presence of the token is the whole question.
    const roundId = reviewingRound(312);
    pastGrace();
    const { hooks, redelivered } = netHooksDelivering({ accepted: true });

    await watcher(hooks).checkDeadlines();
    expect(roundStatus(roundId)).toBe("running");
    expect(redelivered).toHaveLength(0);
    expect(silentSince(roundId)).toBeNull();
  });

  it("does nothing when the receipt is UNKNOWN, or when the hooks are absent (stubs)", async () => {
    const roundIdA = reviewingRound(313);
    pastGrace();
    const unknown = netHooks({ pending: false, accepted: null });
    await watcher(unknown.hooks).checkDeadlines();
    expect(roundStatus(roundIdA)).toBe("running");
    expect(unknown.redelivered).toHaveLength(0);

    const roundIdB = reviewingRound(314);
    const { hooks } = hooksWith(true); // no roundPromptAccepted / injectPending
    await watcher(hooks).checkDeadlines();
    expect(roundStatus(roundIdB)).toBe("running");
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("never acts on a round dispatched before receipts existed (NULL marker)", async () => {
    // A round with no stamped marker cannot be judged: its prompt carried no
    // token, so absence proves nothing. Every reader must fall back rather
    // than conclude loss — otherwise the first deploy would recover every
    // in-flight round at once.
    const roundId = reviewingRound(324, "abc123", { stampMarker: false });
    pastGrace();
    const { hooks, redelivered } = netHooksDelivering({ accepted: false });
    const w = watcher(hooks);

    await w.checkDeadlines();
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines();

    expect(roundStatus(roundId)).toBe("running");
    expect(redelivered).toHaveLength(0);
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("a receipt appearing between two sweeps clears the mark — the loss must be consecutive", async () => {
    const roundId = reviewingRound(323);
    pastGrace();
    let accepted: boolean | null = false;
    const h = hooksWith(true);
    const redelivered: number[] = [];
    h.hooks.injectPending = async () => false;
    h.hooks.roundPromptAccepted = async () => accepted;
    h.hooks.redeliverRound = async (pr) => {
      redelivered.push(pr);
      return true;
    };
    const w = watcher(h.hooks);

    await w.checkDeadlines(); // sweep 1: no receipt — marked
    expect(silentSince(roundId)).not.toBeNull();

    accepted = true; // the prompt landed after all (a slow JSONL flush)
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines(); // sweep 2: receipt present — mark cleared
    expect(silentSince(roundId)).toBeNull();
    expect(redelivered).toHaveLength(0);

    accepted = false; // gone again: the count restarts at one
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines(); // sweep 3: re-marked only
    expect(silentSince(roundId)).not.toBeNull();
    expect(redelivered).toHaveLength(0);

    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines(); // sweep 4: second consecutive loss — acts
    expect(redelivered).toEqual([323]);
  });

  it("never fires when the session is dead — the deadline path owns dead sessions", async () => {
    const roundId = reviewingRound(318);
    pastGrace();
    const h = netHooksDelivering({ accepted: false });
    h.hooks.sessionAlive = async () => false;
    const w = watcher(h.hooks);

    await w.checkDeadlines();
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines();
    // A dead session cannot be recovered by re-sending a file: the deadline
    // path rebirths it. (The receipt says "not delivered" either way, so this
    // guard has to be explicit.)
    expect(roundStatus(roundId)).toBe("running");
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("never fires when sessionAlive is absent (stub hooks) even with both signals present", async () => {
    const roundId = reviewingRound(319);
    pastGrace();
    const h = hooksWith(undefined); // no sessionAlive at all
    h.hooks.injectPending = async () => false;
    h.hooks.roundPromptAccepted = async () => false;
    const w = watcher(h.hooks);

    await w.checkDeadlines();
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines();
    expect(roundStatus(roundId)).toBe("running");
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("waits out the grace window before judging", async () => {
    const roundId = reviewingRound(315);
    clock = new Date(clock.getTime() + 2 * 60_000); // inside the grace window
    const { hooks, redelivered } = netHooksDelivering({ accepted: false });

    await watcher(hooks).checkDeadlines();
    expect(roundStatus(roundId)).toBe("running");
    expect(redelivered).toHaveLength(0);
    expect(silentSince(roundId)).toBeNull();
  });

  it("a pending verdict file always wins over the net", async () => {
    const roundId = reviewingRound(316);
    pastGrace();
    writeFileSync(join(dir, "pr-316-round-1.json"), "{}");
    const { hooks, redelivered } = netHooksDelivering({ accepted: false });

    await watcher(hooks).checkDeadlines();
    expect(roundStatus(roundId)).toBe("running");
    expect(redelivered).toHaveLength(0);
  });
});

// ---- guard-5 landing: outcome "head_moved" (follow-up) -----

describe("head_moved outcome — a guard-5 refusal lands cheaply, session survives", () => {
  function headMovedFile(pr: number, roundNo: number, extra: Record<string, unknown> = {}): void {
    writeFileSync(
      join(dir, `pr-${pr}-round-${roundNo}.json`),
      JSON.stringify({
        pr,
        round_no: roundNo,
        outcome: "head_moved",
        head_sha: "stale-head",
        finished_at: clock.toISOString(),
        ...extra,
      }),
    );
  }

  it("cancels the round and self-requeues at the fresh head — session NOT killed, nothing stamped or labelled", async () => {
    const roundId = reviewingRound(340, "fresh-head");
    const { hooks, overseer } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    headMovedFile(340, 1);

    await watcher(hooks).sweep();

    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(340)!.state).toBe("queued");
    expect(killed).toEqual([]); // the session is healthy — it did the right thing
    expect(events("head_moved_reported")).toHaveLength(1);
    const requeued = events("round_self_requeued");
    expect(requeued).toHaveLength(1);
    expect(requeued[0]!.payload).toMatchObject({ mode: "head_moved", head_sha: "fresh-head" }); // SAME counter, fresh head
    expect(store.selfRequeueCount(340, "fresh-head")).toBe(1);
    expect(overseer.some((m) => m.startsWith("SELF-REQUEUE (recovery) — PR #340"))).toBe(true);
    // No verdict applied: no reviewed-head mark, in-progress label off,
    // reviewed label NOT added.
    expect(store.reviewedHead(340)).toBeUndefined();
    expect(adapter.calls.some((c) => c.startsWith("removeLabel:340"))).toBe(true);
    expect(adapter.calls.some((c) => c.startsWith("addLabel:340"))).toBe(false);
    // Consumed: the file is archived, not reprocessed.
    expect(existsSync(join(dir, "pr-340-round-1.json"))).toBe(false);
  });

  it("respects the cap: past it the round terminalizes through the anomaly path, never loops", async () => {
    const { hooks } = hooksWith(true);
    const w = watcher(hooks);
    const latestRoundNo = () =>
      (store.db.prepare("SELECT round_no FROM rounds WHERE pr = 341 ORDER BY id DESC LIMIT 1").get() as { round_no: number }).round_no;
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      reviewingRound(341);
      headMovedFile(341, latestRoundNo());
      await w.sweep();
      expect(store.getPr(341)!.state).toBe("queued");
    }
    reviewingRound(341);
    headMovedFile(341, latestRoundNo());
    await w.sweep();
    expect(store.getPr(341)!.state).toBe("queued"); // FAILED_LOUD, never an approve
    expect(store.openReviewFailure(341)?.work_owed).toBe(1);
    expect(events("self_requeue_cap_exhausted")).toHaveLength(1);
    expect(events("round_self_requeued")).toHaveLength(DEFAULT_MAX_SELF_REQUEUES);
    expect(events("round_overdue")).toHaveLength(1); // the anomaly landing
  });

  it("belt-and-braces: verdict spelled HEAD_MOVED maps the same way", async () => {
    const roundId = reviewingRound(342);
    const { hooks } = hooksWith(true);
    writeFileSync(
      join(dir, "pr-342-round-1.json"),
      JSON.stringify({ pr: 342, round_no: 1, verdict: "HEAD_MOVED", head_sha: "stale", finished_at: clock.toISOString() }),
    );
    await watcher(hooks).sweep();
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(342)!.state).toBe("queued");
    expect(events("round_self_requeued")).toHaveLength(1);
  });
});

// ---- #5362 W3: held wakes with no round left to flush them -----------------

describe("stranded held wakes (#5362 W3)", () => {
  // `flushWakes` runs from exactly two places: a verdict landing and the
  // anomaly path. Three cancellations reach neither — `superseded`, a startup
  // orphan that is NOT requeued, and a self-requeue whose successor is
  // cancelled the same way — so the wakes held while that round was in flight,
  // author replies included, sat in `pending_wakes` forever. That table has no
  // expiry and nothing swept it.
  it("flushes wakes held behind a round that was cancelled without a verdict", async () => {
    const roundId = reviewingRound(700);
    store.holdWake(700, "the author replied", "author_reply");
    // Cancelled as `superseded`/orphaned would: no verdict, no anomaly.
    store.markRoundCancelled(roundId, "superseded");
    store.setPrState(700, "awaiting_author");
    const { hooks, injects } = hooksWith(true);

    await watcher(hooks).checkDeadlines();

    expect(injects).toEqual(["700:the author replied"]);
    expect(store.heldWakes(700)).toHaveLength(0);
    expect(events("wakes_stranded")).toHaveLength(1);
  });

  it("never flushes while the round is still running — that hold is the point (S4)", async () => {
    reviewingRound(701);
    store.holdWake(701, "mid-round reply", "author_reply");
    const { hooks, injects } = hooksWith(true);

    await watcher(hooks).checkDeadlines();

    expect(injects).toHaveLength(0);
    expect(store.heldWakes(701)).toHaveLength(1);
  });

  it("drops wakes on a closed PR rather than waking an archived session", async () => {
    const roundId = reviewingRound(702);
    store.holdWake(702, "too late", "author_reply");
    store.markRoundCancelled(roundId, "superseded");
    store.setPrState(702, "closed");
    const { hooks, injects } = hooksWith(true);

    await watcher(hooks).checkDeadlines();

    expect(injects).toHaveLength(0);
    expect(store.heldWakes(702)).toHaveLength(0);
    expect(events("wakes_dropped_closed")[0]!.payload).toMatchObject({ dropped: 1 });
  });
});

// ---- #5362 W4: the operator's unwedge levers actually clear the round ------

describe("cancelRunningRounds — the missing half of rerun-round (#5362 W4)", () => {
  it("cancels the phantom round so a requeued PR can actually dispatch", async () => {
    // Both `rerun-round` and `restart-session` set the PR to `queued` and
    // pump — but the pump skips a PR whose round is still `running`, so
    // neither could clear a phantom round. The state flipped, nothing
    // dispatched, and the PR sat queued behind a round that would never end.
    // The anomaly message told the overseer to run `rerun-round` for exactly
    // the case `rerun-round` could not fix.
    const roundId = reviewingRound(710);
    expect(store.runningRounds().map((r) => r.id)).toContain(roundId);

    const cancelled = store.cancelRunningRounds(710, "rerun-round");

    expect(cancelled).toEqual([roundId]);
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.runningRounds().map((r) => r.id)).not.toContain(roundId);
    expect(events("round_cancelled_by_operator")[0]!.payload).toMatchObject({
      round_id: roundId,
      reason: "rerun-round",
    });
  });

  it("leaves no verdict, so a cancelled round never ages the PR", () => {
    const roundId = reviewingRound(711);
    store.cancelRunningRounds(711, "restart-session");
    const round = store.roundsFor(711).find((r) => r.id === roundId)!;
    expect(round.verdict).toBeNull();
    expect(store.priorRoundCount(711)).toBe(0);
  });

  it("is a no-op on a PR with nothing running", () => {
    expect(store.cancelRunningRounds(712, "rerun-round")).toEqual([]);
  });

  it("declares its cause — an operator lever, not a defect", () => {
    const roundId = reviewingRound(713);
    store.cancelRunningRounds(713, "rerun-round");
    expect(store.roundsFor(713).find((r) => r.id === roundId)!.cancel_cause).toBe("operator");
    expect(store.cancellationsByCause()).toEqual([{ cause: "operator", count: 1, loud: false }]);
  });
});

// ---------------------------------------------------------------------------
// every cancelling path declares WHY, and only one of them is loud.
//
// 55 silent cancellations against 5 loud `overdue`s. The split that
// matters is 70% boot orphan sweep (a redeploy artefact, by construction) vs
// the residual real defect — a round that stopped dead inside its deadline.
// ---------------------------------------------------------------------------

describe("cancellation causes on the live paths", () => {
  function anomalies(): Array<{ kind: string; pr: number | null; round_no: number | null }> {
    return store.anomalies().map((a) => ({ kind: a.kind, pr: a.pr, round_no: a.round_no }));
  }

  it("a dead session past the deadline records `deadline_overrun` — and raises the anomaly row", async () => {
    const roundId = reviewingRound(800);
    pastDeadline();
    const { hooks, overseer } = hooksWith(false);
    await watcher(hooks).checkDeadlines();

    expect(store.roundsFor(800).find((r) => r.id === roundId)!.cancel_cause).toBe("deadline_overrun");
    expect(store.cancellationsByCause()).toEqual([{ cause: "deadline_overrun", count: 1, loud: true }]);
    // The durable record found missing…
    expect(anomalies()).toEqual([{ kind: "round_stopped_dead", pr: 800, round_no: 1 }]);
    // …beside exactly ONE overseer wake, the bespoke self-requeue text. The
    // anomaly kind is deliberately not a WAKE class, or this would double.
    expect(overseer.filter((m) => m.startsWith("SELF-REQUEUE"))).toHaveLength(1);
    expect(overseer.filter((m) => m.startsWith("ANOMALY (round_stopped_dead)"))).toHaveLength(0);
    expect(events("round_self_requeued")[0]!.payload).toMatchObject({ cancel_cause: "deadline_overrun" });
  });

  it("a superseded round is cancelled as `superseded` and raises nothing", async () => {
    const oldRound = reviewingRound(801);
    pastDeadline();
    store.startRound(801, "re-review", ["pass-baseline"], baseCfg.daemon.round_deadline_min);
    const { hooks } = hooksWith(false);
    await watcher(hooks).checkDeadlines();

    expect(store.roundsFor(801).find((r) => r.id === oldRound)!.cancel_cause).toBe("superseded");
    expect(store.loudCancellations()).toEqual([]);
    expect(anomalies()).toEqual([]);
  });

  it("the boot orphan sweep records `orphan_sweep` and stays SILENT, at any volume", () => {
    for (let pr = 810; pr < 830; pr++) reviewingRound(pr);
    const { cancelled } = reconcileOrphanedRounds(store, [], { botLogin: "bot", now: () => clock });

    expect(cancelled).toHaveLength(20);
    expect(store.cancellationsByCause()).toEqual([{ cause: "orphan_sweep", count: 20, loud: false }]);
    // The whole point of the grouping: twenty of these is a redeploy, not an
    // incident. Nothing is raised, and none of them is loud.
    expect(anomalies()).toEqual([]);
    expect(store.loudCancellations()).toEqual([]);
  });
});
