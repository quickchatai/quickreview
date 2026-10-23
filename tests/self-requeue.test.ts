// Stuck-round self-requeue. A round that is overdue, has no verdict on disk
// and whose session is dead is requeued by the daemon itself (through the
// normal dispatch path), capped per PR head; past the cap the round ends
// `overdue` through the overdue-anomaly path. Failed/self-requeued
// rounds never age the PR (verdicted-only priorRoundCount discipline), and the
// restart orphan-requeue path and this one can never double-dispatch a round.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_WHITELIST, OPERATOR_COMMANDS, validateCommand } from "../src/commands.js";
import { DEFAULT_MAX_SELF_REQUEUES, parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, roundTypeFor, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { reconcileOrphanedRounds } from "../src/reconcile.js";
import { StateStore } from "../src/state.js";
import { roundPromptMarker } from "../src/types.js";
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import type { InboxWriter } from "../src/companioninbox.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const baseCfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

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

/** The inbox writer each `hooksWith` hooks object collects into. */
const inboxWriters = new WeakMap<SessionHooks, InboxWriter>();

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
    async archiveAndClose() {},
  };
  inboxWriters.set(hooks, async (msg) => void overseer.push(msg));
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
  const id = store.startRound(
    pr,
    "first",
    ["pass-baseline", "pass-validate"],
    baseCfg.daemon.round_deadline_min,
  );
  // Dispatch stamps the receipt token; a round without one predates the
  // receipt and is deliberately unjudgeable.
  if (opts.stampMarker !== false)
    store.stampPromptMarker(id, roundPromptMarker(pr, store.roundsFor(pr).length));
  return id;
}

function watcher(hooks: SessionHooks, cfg: Config = baseCfg): VerdictWatcher {
  // Mirror daemon.ts's wiring: anomaly wakes flow store → sink → hooks.
  const writeInbox = inboxWriters.get(hooks) ?? (async () => {});
  const policy = new AnomalyWakePolicy({ writeInbox });
  store.setAnomalySink((sig) => policy.onAnomaly(sig));
  return new VerdictWatcher({
    cfg,
    store,
    adapter,
    hooks,
    writeInbox,
    verdictDir: dir,
    root: dir,
    usage: {},
    partialWrite: { windowMs: 0 },
    now: () => clock,
  });
}

function pastDeadline(): void {
  clock = new Date(clock.getTime() + (baseCfg.daemon.round_deadline_min + 5) * 60_000);
}

function events(kind: string): Array<{ pr: number | null; payload: any }> {
  return (
    store.db
      .prepare("SELECT pr, payload FROM events WHERE kind = ? ORDER BY id")
      .all(kind) as Array<{ pr: number | null; payload: string | null }>
  ).map((r) => ({ pr: r.pr, payload: r.payload ? JSON.parse(r.payload) : null }));
}

function commandForRound(pr: number, roundNo: number, id = `cmd-${pr}-${roundNo}`): string {
  store.createSessionCommand({
    id,
    pr,
    session: `pr-${pr}`,
    kind: "round",
    round_no: roundNo,
    payload_sha256: "a".repeat(64),
    payload_path: join(dir, "state", "session-commands", `${id}.md`),
    inject_path: join(dir, "inject", `pr-${pr}`, `wake--cmd-${id}.md`),
    next_check_at: clock.toISOString(),
  });
  store.claimSessionCommand(id, "bridge", clock.toISOString());
  store.markSessionCommandStarted(id, "bridge", clock.toISOString());
  return id;
}

function roundStatus(id: number): string {
  return (store.db.prepare("SELECT status FROM rounds WHERE id = ?").get(id) as { status: string })
    .status;
}

function silentSince(id: number): string | null {
  return (
    store.db.prepare("SELECT silent_since FROM rounds WHERE id = ?").get(id) as {
      silent_since: string | null;
    }
  ).silent_since;
}

describe("bounded infrastructure-stage recovery", () => {
  it("reuses the ordinary capped self-requeue path without producing a merits verdict", async () => {
    const roundId = reviewingRound(290);
    const { hooks, overseer } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    const v = watcher(hooks);

    expect(
      await v.recoverInfrastructureFailure(
        290,
        1,
        "settled_without_verdict",
        "parent settled with no verdict",
      ),
    ).toBe("requeued");

    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(290)).toMatchObject({ state: "queued" });
    expect(killed).toEqual([]); // a fully settled sticky session is healthy and retained
    expect(events("round_self_requeued")[0]?.payload).toMatchObject({
      mode: "infrastructure_settled",
      cancel_cause: "infrastructure_failure",
    });
    expect(store.roundsFor(290)[0]?.verdict).toBeNull();
    expect(adapter.calls).toEqual([]);
    expect(overseer.some((m) => m.includes("SELF-REQUEUE (recovery)"))).toBe(true);
  });

  it("changes an immediate first-pass retry by binding a fanout-first instruction to its exact successor", async () => {
    reviewingRound(294);
    const commandId = commandForRound(294, 1);
    const { hooks } = hooksWith(true);
    hooks.killSession = async () => {};
    const v = watcher(hooks);

    expect(
      await v.recoverInfrastructureFailure(
        294,
        1,
        "first_pass_start",
        "accepted and preparing; no fanout",
      ),
    ).toBe("requeued");

    expect(store.roundRecoveryInstruction(294, 2)).toMatchObject({
      target_head_sha: "abc123",
      stage: "first_pass_start",
      source_command_id: commandId,
      source_round_no: 1,
      immediate_attempt: 1,
      retry_epoch: 0,
    });
    expect(store.getPr(294)?.state).toBe("queued");
  });

  it("strictly stops an active timed-out session before requeueing", async () => {
    reviewingRound(292);
    const { hooks } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    const v = watcher(hooks);

    expect(
      await v.recoverInfrastructureFailure(292, 1, "running_hard_bound", "fixed bound exhausted"),
    ).toBe("requeued");
    expect(killed).toEqual([292]);
    expect(events("round_self_requeued")[0]?.payload).toMatchObject({
      mode: "infrastructure_active",
    });
  });

  it("lets a verdict that wins during strict stop go to the verdict sweep", async () => {
    reviewingRound(293);
    const { hooks } = hooksWith(true);
    hooks.killSession = async () => {
      writeFileSync(join(dir, "pr-293-round-1.json"), "{}");
    };
    const v = watcher(hooks);

    expect(
      await v.recoverInfrastructureFailure(293, 1, "running_hard_bound", "fixed bound exhausted"),
    ).toBe("retryable");
    expect(store.roundsFor(293)[0]?.status).toBe("running");
    expect(events("round_stage_verdict_won")).toHaveLength(1);
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  it("turns exhausted exact first-pass work into a durable automatic retry instead of an operator-only park", async () => {
    const roundId = reviewingRound(295);
    store.stampPostingKey(roundId, "v1:295:1:abc123");
    const commandId = commandForRound(295, 1);
    const { hooks } = hooksWith(true);
    hooks.killSession = async () => {};
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      store.logEvent("round_self_requeued", 295, { head_sha: "abc123" });
    }
    const v = watcher(hooks);

    expect(
      await v.recoverInfrastructureFailure(
        295,
        1,
        "first_pass_start",
        "accepted and preparing; no fanout",
      ),
    ).toBe("exhausted");
    store.failActiveSessionCommand(commandId, "first-pass recovery exhausted");
    const failure = store.openReviewFailure(295)!;
    expect(failure).toMatchObject({
      next_action: "retry_wait",
      retry_epoch: 0,
      next_retry_at: new Date(clock.getTime() + 15 * 60_000).toISOString(),
    });

    clock = new Date(failure.next_retry_at!);
    expect(store.activateDueReviewFailureRetries(clock.toISOString())).toEqual([
      expect.objectContaining({ pr: 295, target_round_no: 2, retry_epoch: 1 }),
    ]);
    expect(store.openReviewFailure(295)).toBeUndefined();
    expect(store.getPr(295)?.state).toBe("queued");
  });

  it("returns non-prepass exhaustion to the ordinary operator recovery path, stops Pi, and frees round capacity", async () => {
    reviewingRound(291);
    commandForRound(291, 1);
    const { hooks } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++) {
      store.logEvent("round_self_requeued", 291, { head_sha: "abc123" });
    }
    const v = watcher(hooks);

    expect(
      await v.recoverInfrastructureFailure(291, 1, "running_hard_bound", "fixed bound exhausted"),
    ).toBe("exhausted");
    expect(killed).toEqual([291]);
    expect(store.roundsFor(291)[0]).toMatchObject({
      status: "cancelled",
      cancel_cause: "infrastructure_failure",
      verdict: null,
    });
    expect(store.getPr(291)?.state).toBe("queued");
    expect(store.openReviewFailure(291)).toMatchObject({
      work_owed: 1,
      stage: "running_hard_bound",
      attempts: DEFAULT_MAX_SELF_REQUEUES,
      next_action: "operator_unwedge",
    });
  });
});

describe("infrastructure recovery acts only for the round it read, and leaves no stale label", () => {
  // MUTATION: drop the still-running check after receiptAwareStage — the
  // replacement round's session is killed over a round the operator ended.
  it("a round an operator ended during the posting proof is not recovered and its session is not killed", async () => {
    const roundId = reviewingRound(296);
    store.stampPostingKey(roundId, roundPostingKey(296, 1, "abc123"));
    const { hooks } = hooksWith(true);
    const killed: number[] = [];
    hooks.killSession = async (pr) => {
      killed.push(pr);
    };
    (adapter as FakeVerdictAdapter & VerdictAdapter).listReviewsFull = async () => {
      store.cancelRunningRounds(296, "rerun-round");
      store.startRound(296, "first", ["pass-baseline"], baseCfg.daemon.round_deadline_min);
      return [];
    };
    const v = watcher(hooks, { ...baseCfg, dry_run: false });

    expect(
      await v.recoverInfrastructureFailure(296, 1, "running_hard_bound", "fixed bound exhausted"),
    ).toBe("requeued");
    expect(killed).toEqual([]);
    expect(store.roundsFor(296).map((r) => r.status)).toEqual(["cancelled", "running"]);
    expect(events("round_self_requeued")).toHaveLength(0);
  });

  // MUTATION: drop the label removal from the exhausted path — the PR keeps
  // advertising a review in progress that FAILED_LOUD ended.
  it("exhausted recovery takes the in-progress label off", async () => {
    reviewingRound(297);
    commandForRound(297, 1);
    const { hooks } = hooksWith(true);
    hooks.killSession = async () => {};
    for (let i = 0; i < DEFAULT_MAX_SELF_REQUEUES; i++)
      store.logEvent("round_self_requeued", 297, { head_sha: "abc123" });

    expect(
      await watcher(hooks).recoverInfrastructureFailure(
        297,
        1,
        "running_hard_bound",
        "fixed bound exhausted",
      ),
    ).toBe("exhausted");
    expect(adapter.calls).toEqual([`removeLabel:297:${baseCfg.github.in_progress_label}`]);
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
    expect(
      overseer.some((m) => m.startsWith("SELF-REQUEUE (recovery) — PR #300 round 1, attempt 1/")),
    ).toBe(true);
    // Never the anomaly park, never awaiting_human, no round_overdue event.
    expect(events("round_overdue")).toHaveLength(0);
    expect(row.state).not.toBe("awaiting_human");
    // Session-side only: no gate/adapter mutation at all (dry-run safe by construction).
    expect(adapter.calls).toEqual([]);
  });

  it("a live session with no killSession hook keeps the overdue-anomaly path (no park)", async () => {
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
    expect(events("self_requeue_cap_exhausted")[0]!.payload).toMatchObject({
      head_sha: "abc123",
      attempts: cap,
      cap,
    });
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
    expect(store.selfRequeueSpend(311, "head-two")).toEqual({ at_head: 1, unattributed: 0 });
    expect(store.selfRequeueSpend(311, "head-one")).toEqual({ at_head: 1, unattributed: 0 });
  });

  it("max_self_requeues is config-knobbed and defaults to 2", () => {
    expect(DEFAULT_MAX_SELF_REQUEUES).toBe(2);
    const noKnob = parseConfig(
      readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8").replace(
        /^max_self_requeues.*$/m,
        "",
      ),
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
    return (
      this.files.get(n) ?? [{ filename: "a.py", additions: 5, deletions: 1, status: "modified" }]
    );
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
      async archiveAndClose() {},
    },
  };
}

describe("self-requeued rounds do not age the PR", () => {
  it(
    "priorRoundCount ignores the cancelled round; the fresh dispatch is still round_type 'first', review_no 1",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      reviewingRound(320);
      pastDeadline();
      const { hooks } = hooksWith(false);
      await watcher(hooks).checkDeadlines();

      expect(store.priorRoundCount(320)).toBe(0); // verdicted-only discipline intact
      expect(roundTypeFor(store.getPr(320)!, store.priorRoundCount(320))).toBe("first");

      const d = dispatchHooks();
      const orders = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter: new FakeDispatchAdapter(),
        hooks: d.hooks,
      });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.round_type).toBe("first");
      expect(orders[0]!.review_no).toBe(1);
      expect(orders[0]!.round_no).toBe(2); // round_no advances; review age does not
    },
  );
});

describe("idempotency against the restart orphan-requeue", () => {
  it(
    "self-requeue first: the orphan sweep finds nothing running and dispatch runs exactly once",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      reviewingRound(330);
      pastDeadline();
      const { hooks } = hooksWith(false);
      await watcher(hooks).checkDeadlines(); // self-requeue wins the race

      // A restart lands right after: no session adopted for #330.
      const report = reconcileOrphanedRounds(store, [], { now: () => clock });
      expect(report.cancelled).toEqual([]);
      expect(report.requeued).toEqual([]);
      expect(events("orphaned_round_requeued")).toHaveLength(0);

      const d = dispatchHooks();
      const orders = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter: new FakeDispatchAdapter(),
        hooks: d.hooks,
      });
      expect(orders).toHaveLength(1); // one queued row ⇒ one round, ever
      expect(store.runningRounds()).toHaveLength(1);
    },
  );

  it(
    "orphan-requeue first: the deadline checker has nothing left to self-requeue",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      reviewingRound(331);
      pastDeadline();
      const report = reconcileOrphanedRounds(store, [], { now: () => clock });
      expect(report.requeued).toEqual([331]);

      const { hooks } = hooksWith(false);
      expect(await watcher(hooks).checkDeadlines()).toEqual([]); // no running round to act on
      expect(events("round_self_requeued")).toHaveLength(0);

      const d = dispatchHooks();
      const orders = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter: new FakeDispatchAdapter(),
        hooks: d.hooks,
      });
      expect(orders).toHaveLength(1);
    },
  );

  it(
    "a requeued PR whose replacement round is already running is not dispatched again",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // The queued-while-running guard in dispatch: requeue raced a running round.
      reviewingRound(332);
      store.upsertPr({ ...store.getPr(332)!, state: "queued", trigger_ts: clock.toISOString() });
      const d = dispatchHooks();
      const orders = await dispatchOnce({
        cfg: baseCfg,
        store,
        adapter: new FakeDispatchAdapter(),
        hooks: d.hooks,
      });
      expect(orders).toHaveLength(0);
    },
  );
});

// Recover, don't park: a live-but-wedged session is
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

  it("an overdue anomaly after a session that could not be stopped does not claim the cap is exhausted", async () => {
    const roundId = reviewingRound(314);
    pastDeadline();
    const { hooks, overseer } = hooksWith(true);
    hooks.killSession = async () => {
      throw new Error("tmux gone");
    };

    expect(await watcher(hooks).checkDeadlines()).toEqual([314]);
    expect(roundStatus(roundId)).toBe("overdue");
    expect(events("self_requeue_cap_exhausted")).toHaveLength(0);
    const anomaly = overseer.find((m) => m.startsWith("ANOMALY (overdue)"));
    expect(anomaly).toBeDefined();
    expect(anomaly).not.toContain("cap is exhausted");
  });

  // MUTATION: keep the post-kill verdict check infrastructure-only — the
  // round is cancelled and requeued under a verdict that won the race.
  it("a verdict committed while the wedged session is being stopped wins: no requeue, no anomaly", async () => {
    const roundId = reviewingRound(313);
    pastDeadline();
    const { hooks } = hooksWith(true);
    hooks.killSession = async () => {
      writeFileSync(
        join(dir, "pr-313-round-1.json"),
        JSON.stringify({
          pr: 313,
          round_no: 1,
          verdict: "REQUEST_CHANGES",
          head_sha: "abc123",
          finished_at: clock.toISOString(),
          passes: [{ name: "pass-baseline", tier: "sol-med", findings: 1 }],
        }),
      );
    };
    const w = watcher(hooks);

    expect(await w.checkDeadlines()).toEqual([]);
    expect(roundStatus(roundId)).toBe("running");
    expect(events("round_self_requeued")).toHaveLength(0);
    expect(events("round_overdue")).toHaveLength(0);
    expect(events("round_stage_verdict_won")[0]!.payload).toMatchObject({ mode: "alive_stuck" });

    await w.sweep();
    expect(roundStatus(roundId)).toBe("done");
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

  // MUTATION: requeue before looking at the posting receipt — the round whose
  // COMMENT is already on GitHub is redone and posts a second review.
  it("no executed passes but its review already posted ⇒ applied through the receipt, never redone", async () => {
    const roundId = reviewingRound(323);
    const key = roundPostingKey(323, 1, "abc123");
    store.stampPostingKey(roundId, key);
    const receiptDir = join(dir, "state", "posting-receipts");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(
      join(receiptDir, "pr-323-round-1.json"),
      JSON.stringify({
        version: 1,
        posting_key: key,
        marker: postingMarker(key),
        pr: 323,
        round_no: 1,
        head_sha: "abc123",
        intended_event: "COMMENT",
        actual_event: "COMMENT",
        status: "confirmed",
        payload_sha256: "a".repeat(64),
        prepared_at: clock.toISOString(),
        confirmed_at: clock.toISOString(),
        gh_review_id: 991,
        gh_commit_id: "abc123",
        gh_state: "COMMENTED",
      }),
    );
    const { hooks } = hooksWith();
    needsHumanFile(323, 1);

    await watcher(hooks).sweep();

    expect(events("round_self_requeued")).toHaveLength(0);
    expect(events("needs_human_incomplete")[0]!.payload).toMatchObject({
      posting_receipt: "confirmed",
    });
    expect(roundStatus(roundId)).toBe("done");
    expect(store.getPr(323)!.state).toBe("tracked");
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
      (
        store.db
          .prepare("SELECT round_no FROM rounds WHERE pr = 322 ORDER BY id DESC LIMIT 1")
          .get() as { round_no: number }
      ).round_no;
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

// ---- the lost-prompt net, built on a receipt --------------------------------
//
// Loss cannot be inferred from session activity: a prompt is dropped precisely
// because the agent is busy, and a busy agent always has activity after round
// start. Nor may the net stand down once the head has spent a self-requeue — a
// `head_moved` requeue spends one seconds before dispatching the round most
// likely to be lost.
//
// `roundPromptAccepted` is the fact the net acts on: the dispatched
// receipt token is echoed into the session JSONL only when pi accepted the
// message. false = provably never arrived, true = the session owns it, null =
// no evidence. And because a missing prompt is a DELIVERY fault, recovery is
// cheap first: re-deliver the same order to the same session, and escalate to
// a cancelled round only when redelivery is spent or impossible.

describe("lost-prompt net — a round with no prompt receipt", () => {
  const GRACE_MIN = baseCfg.daemon.round_stall_grace_min ?? 10;

  /** hooksWith + the observation hooks, with redelivery ALWAYS failing so the
   * escalation half can be exercised on its own. `accepted` mirrors what
   * `roundPromptAccepted` reports. */
  function netHooks(opts: { accepted: boolean | null }): ReturnType<typeof hooksWith> & {
    redelivered: number[];
  } {
    const h = hooksWith(true);
    const redelivered: number[] = [];
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
    expect(events("round_prompt_redelivered")[0]!.payload).toMatchObject({
      attempt: 1,
      round_no: 1,
    });

    // THE POINT: this is a delivery fault, so nothing expensive happened.
    expect(roundStatus(roundId)).toBe("running");
    expect(store.getPr(310)!.state).toBe("reviewing");
    expect(events("round_self_requeued")).toHaveLength(0);
    // …and the window resets, so the next escalation must be re-earned.
    expect(silentSince(roundId)).toBeNull();
  });

  // MUTATION: drop the deadline extension from the pre-deadline redelivery —
  // the round caught near its deadline is judged overdue minutes later.
  it("a prompt redelivered just before the deadline gets a fresh deadline, as one caught at it does", async () => {
    const roundId = reviewingRound(315);
    const deadlineOf = (): number =>
      Date.parse(
        (
          store.db.prepare("SELECT deadline_at FROM rounds WHERE id = ?").get(roundId) as {
            deadline_at: string;
          }
        ).deadline_at,
      );
    // Three minutes before the original deadline, the grace long blown.
    clock = new Date(deadlineOf() - 3 * 60_000);
    const { hooks, redelivered } = netHooksDelivering({ accepted: false });
    const w = watcher(hooks);

    await w.checkDeadlines(); // marks
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines(); // redelivers
    expect(redelivered).toEqual([{ pr: 315, round: 1 }]);
    expect(deadlineOf()).toBe(clock.getTime() + baseCfg.daemon.round_deadline_min * 60_000);
    expect(events("round_prompt_redelivered")[0]!.payload).toMatchObject({
      at: "before_deadline",
      deadline_extended_min: baseCfg.daemon.round_deadline_min,
    });

    // Past the ORIGINAL deadline the redelivered round is still reviewing.
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await w.checkDeadlines()).toEqual([]);
    expect(roundStatus(roundId)).toBe("running");
    expect(events("round_self_requeued")).toHaveLength(0);
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
    const { hooks, redelivered } = netHooks({ accepted: false });
    const w = watcher(hooks);

    await w.checkDeadlines();
    clock = new Date(clock.getTime() + 60_000);
    await w.checkDeadlines();

    expect(redelivered).toEqual([321]);
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(events("round_self_requeued")).toHaveLength(1);
  });

  it("a HEAD_MOVED requeue no longer disarms the net", async () => {
    // `head_moved` spends a self-requeue seconds before dispatching the round
    // whose delivery races the session's still-running turn — the most
    // loss-prone dispatch there is, so a spent requeue must not disarm the net.
    const pr = 322;
    const first = reviewingRound(pr);
    store.markRoundCancelled(first, "self-requeue 1/2 — head_moved");
    // The head_moved requeue, exactly as verdicts.ts records it — an event
    // that must not read as "budget spent, stand down".
    store.logEvent("round_self_requeued", pr, {
      head_sha: "abc123",
      mode: "head_moved",
      attempt: 1,
    });
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

  it("does nothing when the receipt IS there — a busy session is not a lost prompt", async () => {
    // A session finishing its previous turn has activity after round start
    // whether or not the prompt arrived. The receipt separates the two:
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
    const unknown = netHooks({ accepted: null });
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

// ---- guard-5 landing: outcome "head_moved" --------------------------------

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
    expect(requeued[0]!.payload).toMatchObject({ mode: "head_moved", head_sha: "fresh-head" }); // SAME self-requeue counter, fresh head
    expect(store.selfRequeueSpend(340, "fresh-head")).toEqual({ at_head: 1, unattributed: 0 });
    expect(overseer.some((m) => m.startsWith("SELF-REQUEUE (recovery) — PR #340"))).toBe(true);
    // No verdict applied: no reviewed-head mark, in-progress label off,
    // reviewed label NOT added.
    expect(store.reviewedHead(340)).toBeUndefined();
    expect(adapter.calls.some((c) => c.startsWith("removeLabel:340"))).toBe(true);
    expect(adapter.calls.some((c) => c.startsWith("addLabel:340"))).toBe(false);
    // Consumed: the file is archived, not reprocessed.
    expect(existsSync(join(dir, "pr-340-round-1.json"))).toBe(false);
  });

  // MUTATION: drop apply's cancelled-round guard and the head_moved replay
  // check — the replay opens FAILED_LOUD debt over the queued replacement.
  it("a replay of a handled head_moved file is inert: no failure, the requeue stands", async () => {
    const roundId = reviewingRound(343, "fresh-head");
    const { hooks } = hooksWith(true);
    const w = watcher(hooks);
    headMovedFile(343, 1);
    await w.sweep();
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(343)!.state).toBe("queued");

    // The archive failed (or a restart cut the apply short): the file is back.
    headMovedFile(343, 1);
    await w.sweep();

    expect(existsSync(join(dir, "pr-343-round-1.json"))).toBe(false);
    expect(store.getPr(343)!.state).toBe("queued");
    expect(store.openReviewFailure(343)).toBeUndefined();
    expect(events("round_overdue")).toHaveLength(0);
    expect(events("round_self_requeued")).toHaveLength(1);
  });

  // MUTATION: restore the "investigate why its sessions die mid-round" line
  // — a healthy head_moved requeue sends the overseer after dying sessions.
  it("the overseer's note names the requeue's own cause, never dying sessions, for a healthy session", async () => {
    reviewingRound(344, "fresh-head");
    const { hooks, overseer } = hooksWith(true);
    headMovedFile(344, 1);
    await watcher(hooks).sweep();
    const note = overseer.find((m) => m.startsWith("SELF-REQUEUE (recovery) — PR #344"))!;
    expect(note).toContain("the session is healthy and was not killed");
    expect(note).not.toMatch(/die mid-round|dead round|reborn/);
  });

  // MUTATION: log head_moved_reported before the not-running check — a
  // replay on a round that ended reports a movement nobody handled.
  it("a head_moved file reaching a round that already ended reports nothing new", async () => {
    const roundId = reviewingRound(345, "fresh-head");
    store.finishRound(roundId, "APPROVE", null);
    const { hooks } = hooksWith(true);
    headMovedFile(345, 1);
    await watcher(hooks).sweep();
    expect(events("head_moved_reported")).toHaveLength(0);
    expect(events("verdict_replay_ignored")).toHaveLength(1);
  });

  it("respects the self-requeue cap: past it the round terminalizes through the anomaly path, never loops", async () => {
    const { hooks } = hooksWith(true);
    const w = watcher(hooks);
    const latestRoundNo = () =>
      (
        store.db
          .prepare("SELECT round_no FROM rounds WHERE pr = 341 ORDER BY id DESC LIMIT 1")
          .get() as { round_no: number }
      ).round_no;
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
      JSON.stringify({
        pr: 342,
        round_no: 1,
        verdict: "HEAD_MOVED",
        head_sha: "stale",
        finished_at: clock.toISOString(),
      }),
    );
    await watcher(hooks).sweep();
    expect(roundStatus(roundId)).toBe("cancelled");
    expect(store.getPr(342)!.state).toBe("queued");
    expect(events("round_self_requeued")).toHaveLength(1);
  });
});

// ---- held wakes with no round left to flush them ----------------------------

describe("stranded held wakes", () => {
  // A verdict landing and the anomaly path flush held wakes, but three
  // cancellations reach neither — `superseded`, a startup orphan that is NOT
  // requeued, and a self-requeue whose successor is cancelled the same way.
  // `pending_wakes` has no expiry, so without a flush on those paths the wakes
  // held while that round was in flight, author replies included, would sit
  // there forever.
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

  it("never flushes while the round is still running — that hold is the point", async () => {
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

// ---- the operator's unwedge levers actually clear the round -----------------

describe("cancelRunningRounds — the missing half of rerun-round", () => {
  it("cancels the phantom round so a requeued PR can actually dispatch", async () => {
    // Both `rerun-round` and `restart-session` set the PR to `queued` and
    // pump — but the pump skips a PR whose round is still `running`, so
    // without cancelling the round the PR would sit queued behind a round
    // that never ends.
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
// Every cancelling path declares WHY, and only one of them is loud: a boot
// orphan sweep is a redeploy artefact by construction, while a round that
// stopped dead inside its deadline is a real defect.
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

    expect(store.roundsFor(800).find((r) => r.id === roundId)!.cancel_cause).toBe(
      "deadline_overrun",
    );
    expect(store.cancellationsByCause()).toEqual([
      { cause: "deadline_overrun", count: 1, loud: true },
    ]);
    // The durable anomaly record…
    expect(anomalies()).toEqual([{ kind: "round_stopped_dead", pr: 800, round_no: 1 }]);
    // …beside exactly ONE overseer wake, the bespoke self-requeue text. The
    // anomaly kind is deliberately not a WAKE class, or this would double.
    expect(overseer.filter((m) => m.startsWith("SELF-REQUEUE"))).toHaveLength(1);
    expect(overseer.filter((m) => m.startsWith("ANOMALY (round_stopped_dead)"))).toHaveLength(0);
    expect(events("round_self_requeued")[0]!.payload).toMatchObject({
      cancel_cause: "deadline_overrun",
    });
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
    const { cancelled } = reconcileOrphanedRounds(store, [], { now: () => clock });

    expect(cancelled).toHaveLength(20);
    expect(store.cancellationsByCause()).toEqual([
      { cause: "orphan_sweep", count: 20, loud: false },
    ]);
    // The whole point of the grouping: twenty of these is a redeploy, not an
    // incident. Nothing is raised, and none of them is loud.
    expect(anomalies()).toEqual([]);
    expect(store.loudCancellations()).toEqual([]);
  });
});

// A `round_self_requeued` row whose payload cannot be read is still a requeue
// that happened, so it is spent against the cap. Dropping it would let a
// corrupt row buy a requeue past the cap; counting it can only tighten the
// budget (ending in FAILED_LOUD and `u` — the recoverable side).
describe("a self-requeue row whose head cannot be read still counts", () => {
  const tornRow = (pr: number, payload: string | null): void => {
    store.db
      .prepare("INSERT INTO events (ts, kind, pr, payload) VALUES (?, 'round_self_requeued', ?, ?)")
      .run(clock.toISOString(), pr, payload);
  };

  it("the store splits attributed from unattributed rows rather than dropping the unreadable ones", () => {
    store.logEvent("round_self_requeued", 350, { head_sha: "h1", mode: "dead" });
    tornRow(350, "{torn");
    tornRow(350, null);
    tornRow(350, JSON.stringify({ mode: "dead" })); // no head_sha at all
    expect(store.selfRequeueSpend(350, "h1")).toEqual({ at_head: 1, unattributed: 3 });
    expect(store.selfRequeueSpend(350, "h2")).toEqual({ at_head: 0, unattributed: 3 });
    expect(store.selfRequeueSpend(351, "h1")).toEqual({ at_head: 0, unattributed: 0 });
  });

  it("the watcher spends the unreadable row against the cap — it can tighten the budget, never widen it", async () => {
    const cap = 2;
    const cfg: Config = { ...baseCfg, daemon: { ...baseCfg.daemon, max_self_requeues: cap } };
    const { hooks } = hooksWith(false);
    const w = watcher(hooks, cfg);
    // One requeue this PR certainly spent, at a head nobody can read back.
    tornRow(352, "{torn");

    // Budget 2, spent 1 (unattributed): one real requeue is still allowed…
    let id = reviewingRound(352, "head-a");
    pastDeadline();
    expect(await w.checkDeadlines()).toEqual([]);
    expect(roundStatus(id)).toBe("cancelled");

    // …and the next is refused: 1 unattributed + 1 at this head = the cap.
    // Ignoring the corrupt row would let a third requeue through — a loop
    // past the budget.
    id = reviewingRound(352, "head-a");
    pastDeadline();
    expect(await w.checkDeadlines()).toEqual([352]);
    expect(roundStatus(id)).toBe("overdue");
    expect(events("self_requeue_cap_exhausted")).toHaveLength(1);
    expect(events("self_requeue_cap_exhausted")[0]!.payload).toMatchObject({
      head_sha: "head-a",
      attempts: cap,
      cap,
    });
  });
});

describe("the operator's abort-round is not a session's way to requeue", () => {
  it("rerun-round and restart-session stay session-writable (the recovery verbs); abort-round is sealed to the operator", () => {
    expect(COMMAND_WHITELIST).toEqual(expect.arrayContaining(["rerun-round", "restart-session"]));
    expect(COMMAND_WHITELIST).not.toContain("abort-round");
    expect(OPERATOR_COMMANDS).toContain("abort-round");
    // A stuck session cannot stop its own round by writing the operator's verb.
    const v = validateCommand({ command: "abort-round", pr: 7 }, { issuer: "session" });
    expect(v.ok).toBe(false);
    expect(validateCommand({ command: "abort-round", pr: 7 }, { issuer: "operator" }).ok).toBe(
      true,
    );
  });
});
