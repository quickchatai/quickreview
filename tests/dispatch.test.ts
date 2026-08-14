import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { capacity, dispatchOnce, queuedInOrder, roundTypeFor, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { StateStore } from "../src/state.js";
import { applyEvent } from "../src/statemachine.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";

const baseCfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));

interface Call {
  fn: string;
  pr: number;
  arg?: string;
}

class FakeAdapter implements DispatchAdapter {
  calls: Call[] = [];
  files = new Map<number, PrFileEntry[]>();
  failLabelOn = new Set<number>();
  goneLabelOn = new Set<number>();

  async listPrFiles(n: number): Promise<PrFileEntry[]> {
    this.calls.push({ fn: "listPrFiles", pr: n });
    return this.files.get(n) ?? [];
  }
  async addLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push({ fn: "addLabel", pr: n, arg: label });
    return { executed: false, dryRunFile: "x" };
  }
  async removeLabel(n: number, label: string): Promise<GateResult> {
    this.calls.push({ fn: "removeLabel", pr: n, arg: label });
    if (this.failLabelOn.has(n)) throw new Error("404 label not present");
    if (this.goneLabelOn.has(n))
      throw new Error(`DELETE /repos/o/r/issues/${n}/labels/AI%20review%20requested → 404: {"message":"Label does not exist","status":"404"}`);
    return { executed: false, dryRunFile: "x" };
  }
  async deleteTeamReviewRequest(n: number): Promise<GateResult> {
    this.calls.push({ fn: "deleteTeamReviewRequest", pr: n });
    return { executed: false, dryRunFile: "x" };
  }
}

function recordingHooks(): { hooks: SessionHooks; orders: Array<{ order: RoundOrder; prompt: string }> } {
  const orders: Array<{ order: RoundOrder; prompt: string }> = [];
  return {
    orders,
    hooks: {
      async dispatchRound(order, prompt) {
        orders.push({ order, prompt });
      },
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    },
  };
}

function file(filename: string, additions = 10, deletions = 0): PrFileEntry {
  return { filename, additions, deletions, status: "modified" };
}

let store: StateStore;
let adapter: FakeAdapter;

beforeEach(() => {
  store = new StateStore(":memory:");
  adapter = new FakeAdapter();
});

function queue(pr: number, triggerTs: string | null, over: Partial<{ title: string; head: string }> = {}): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: over.head ?? `sha${pr}`,
    title: over.title ?? `PR ${pr}`,
    author: "alice",
    trigger_ts: triggerTs,
    stale_recheck: 0,
    escalation_worthy: 0,
    migration_gate: 0,
  });
}

describe("queue ordering and capacity", () => {
  it("is FIFO by trigger_ts, nulls last, PR number as tiebreak", () => {
    queue(3, "2026-08-13T10:00:00Z");
    queue(1, "2026-08-13T09:00:00Z");
    queue(2, null);
    queue(4, "2026-08-13T09:00:00Z");
    expect(queuedInOrder(store).map((p) => p.number)).toEqual([1, 4, 3, 2]);
  });

  it("skips overseer-paused PRs entirely", () => {
    queue(1, "2026-08-13T09:00:00Z");
    queue(2, "2026-08-13T10:00:00Z");
    store.setPaused(1, true);
    expect(queuedInOrder(store).map((p) => p.number)).toEqual([2]);
    store.setPaused(1, false);
    expect(queuedInOrder(store).map((p) => p.number)).toEqual([1, 2]);
  });

  it("counts running rounds against max_concurrent_rounds", () => {
    const cap = baseCfg.daemon.max_concurrent_rounds;
    expect(capacity(store, baseCfg)).toBe(cap);
    for (let i = 0; i < cap; i++) store.startRound(100 + i, "first", ["pass-baseline"], 45);
    expect(capacity(store, baseCfg)).toBe(0);
  });
});

describe("roundTypeFor", () => {
  it("first → staleness → re-review", () => {
    const row = { stale_recheck: 0 } as any;
    expect(roundTypeFor(row, 0)).toBe("first");
    expect(roundTypeFor(row, 2)).toBe("re-review");
    expect(roundTypeFor({ stale_recheck: 1 } as any, 2)).toBe("staleness");
  });
});

describe("recording at round start", () => {
  it("stamps the diffstat off the files list and the pr_state trigger_ts", async () => {
    queue(21, "2026-08-13T09:00:00Z");
    adapter.files.set(21, [file("a.ts", 12, 3), file("b.ts", 4, 40)]);
    const { hooks } = recordingHooks();

    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

    const round = store.roundsFor(21)[0]!;
    expect(round).toMatchObject({ additions: 16, deletions: 43, changed_files: 2, backfilled: 0 });
    // trigger_ts survives even though the dispatch transition clears pr_state's.
    expect(round.trigger_ts).toBe("2026-08-13T09:00:00Z");
    expect(store.getPr(21)!.trigger_ts).toBeNull();
    // No extra GitHub call: the diffstat comes off the one files fetch.
    expect(adapter.calls.filter((c) => c.fn === "listPrFiles")).toHaveLength(1);
  });

  it("counts only daemon-run rounds when choosing first vs re-review", async () => {
    // A backfilled (imported) round must not flip the next live round to
    // "re-review" — its template references a settled digest that never existed.
    store.db
      .prepare(
        `INSERT INTO rounds (pr, round_no, round_type, lenses, verdict, started_at, deadline_at, finished_at, status, backfilled)
         VALUES (?, 0, 'backfill', '', 'REQUEST_CHANGES', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z', 'done', 1)`,
      )
      .run(22);
    expect(store.priorRoundCount(22)).toBe(0);

    queue(22, "2026-08-13T09:00:00Z");
    const { hooks, orders } = recordingHooks();
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

    expect(orders[0]!.order.round_type).toBe("first");
    // …and a real prior round still yields a re-review.
    store.finishRound(store.runningRounds()[0]!.id, "REQUEST_CHANGES", 1);
    expect(store.priorRoundCount(22)).toBe(1);
    queue(22, "2026-08-13T11:00:00Z");
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(orders[1]!.order.round_type).toBe("re-review");
  });
});

describe("dispatchOnce", () => {
  it("dispatches in FIFO order and stops at the concurrency cap", async () => {
    const cfg = { ...baseCfg, daemon: { ...baseCfg.daemon, max_concurrent_rounds: 2 } };
    queue(11, "2026-08-13T09:00:00Z");
    queue(12, "2026-08-13T09:30:00Z");
    queue(13, "2026-08-13T10:00:00Z");
    const { hooks, orders } = recordingHooks();

    const dispatched = await dispatchOnce({ cfg, store, adapter, hooks });
    expect(dispatched.map((o) => o.pr)).toEqual([11, 12]);
    expect(orders.map((o) => o.order.pr)).toEqual([11, 12]);
    expect(store.getPr(11)!.state).toBe("reviewing");
    expect(store.getPr(13)!.state).toBe("queued");
    expect(store.runningRounds()).toHaveLength(2);

    // The cap holds on the next pump until a round finishes.
    expect(await dispatchOnce({ cfg, store, adapter, hooks })).toHaveLength(0);
    store.finishRound(store.runningRounds()[0]!.id, "APPROVE", 1.5);
    const next = await dispatchOnce({ cfg, store, adapter, hooks });
    expect(next.map((o) => o.pr)).toEqual([13]);
  });

  it("consumes both triggers and flags the round in progress", async () => {
    queue(21, "2026-08-13T09:00:00Z");
    const { hooks } = recordingHooks();
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(adapter.calls).toEqual([
      { fn: "removeLabel", pr: 21, arg: baseCfg.github.trigger_label },
      { fn: "deleteTeamReviewRequest", pr: 21 },
      { fn: "addLabel", pr: 21, arg: baseCfg.github.in_progress_label },
      { fn: "listPrFiles", pr: 21 },
    ]);
  });

  it("still dispatches when trigger consumption partially fails", async () => {
    queue(22, "2026-08-13T09:00:00Z");
    adapter.failLabelOn.add(22);
    const { hooks, orders } = recordingHooks();
    const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(dispatched).toHaveLength(1);
    expect(orders).toHaveLength(1);
    const logged = store.db.prepare("SELECT payload FROM events WHERE kind = 'trigger_consume_failed'").all() as Array<{ payload: string }>;
    expect(JSON.parse(logged[0]!.payload).which).toBe("label");
  });

  it("treats a GitHub 404 on label removal as already-consumed, not a failure", async () => {
    queue(23, "2026-08-13T09:00:00Z");
    adapter.goneLabelOn.add(23);
    const { hooks, orders } = recordingHooks();
    const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(dispatched).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'trigger_consume_failed'").get()).toEqual({ c: 0 });
    const already = store.db.prepare("SELECT payload FROM events WHERE kind = 'trigger_already_consumed'").all() as Array<{ payload: string }>;
    expect(JSON.parse(already[0]!.payload).which).toBe("label");
    const round = store.db.prepare("SELECT payload FROM events WHERE kind = 'round_dispatched'").get() as { payload: string };
    expect(JSON.parse(round.payload).triggers_consumed).toContain("label");
  });

  it("never dispatches a PR that already has a running round (one worktree, one round)", async () => {
    queue(24, "2026-08-13T09:00:00Z");
    queue(25, "2026-08-13T09:01:00Z");
    store.startRound(24, "first", ["pass-baseline"], 45); // round in flight, PR requeued behind it
    const { hooks, orders } = recordingHooks();
    const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(dispatched.map((o) => o.pr)).toEqual([25]);
    expect(orders.map((o) => o.order.pr)).toEqual([25]);
    expect(adapter.calls.filter((c) => c.pr === 24)).toHaveLength(0);
  });

  it("builds the round order from the files API: lenses, escalation, migration gate", async () => {
    queue(31, "2026-08-13T09:00:00Z", { title: "Terraform the ingest cluster", head: "abc123" });
    adapter.files.set(31, [
      file("infra/main.tf", 120, 5),
      file("app/migrations/0007_add_index.py", 30, 0),
      file("app/api/routes.py", 40, 2),
      file("tests/test_routes.py", 400, 0), // test file: excluded from prod stats
    ]);
    const { hooks, orders } = recordingHooks();
    const [order] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

    expect(order).toBeDefined();
    expect(order!.pr).toBe(31);
    expect(order!.round_no).toBe(1);
    expect(order!.round_type).toBe("first");
    expect(order!.head_sha).toBe("abc123");
    expect(order!.title).toBe("Terraform the ingest cluster");
    expect(order!.worktree).toBe("wt/pr-31");
    expect(order!.lenses).toContain("pass-baseline");
    expect(order!.lenses).toContain("pass-prod-risk");
    expect(order!.lenses).toContain("pass-data-safety");
    expect(order!.lenses).toContain("pass-contracts");
    expect(order!.lenses[order!.lenses.length - 1]).toBe("pass-validate");
    expect(order!.escalation_worthy).toBe(true);
    expect(order!.escalation_reasons.join(" ")).toContain("infra/main.tf");
    expect(order!.migration_gate).toBe(true);

    const row = store.getPr(31)!;
    expect(row.escalation_worthy).toBe(1);
    expect(row.migration_gate).toBe(1);
    expect(orders[0]!.prompt).toContain('"pr": 31'); // default renderer = JSON
  });

  it("leaves a small tidy PR unescalated and ungated", async () => {
    queue(32, "2026-08-13T09:00:00Z");
    adapter.files.set(32, [file("README.md", 3, 1)]);
    const { hooks } = recordingHooks();
    const [order] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(order!.escalation_worthy).toBe(false);
    expect(order!.migration_gate).toBe(false);
    expect(order!.lenses).toEqual(["pass-baseline", "pass-validate"]);
  });

  it("uses the injected prompt renderer and settled digest", async () => {
    queue(33, "2026-08-13T09:00:00Z");
    const { hooks, orders } = recordingHooks();
    await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      renderPrompt: (o) => `ROUND ${o.round_no} for #${o.pr}`,
      settledDigest: () => "SETTLED: thread 12 (perf, conceded)",
    });
    expect(orders[0]!.prompt).toBe("ROUND 1 for #33");
    expect(orders[0]!.order.settled_digest).toBe("SETTLED: thread 12 (perf, conceded)");
  });

  it("numbers rounds per PR and marks a stale recheck", async () => {
    queue(41, "2026-08-13T09:00:00Z");
    const { hooks } = recordingHooks();
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    store.finishRound(store.runningRounds()[0]!.id, "APPROVE", 0.5);
    applyEvent(store, 41, { type: "verdict", verdict: "APPROVE" }, {}, {});
    applyEvent(store, 41, { type: "stale_detected" }, {}, {});
    expect(store.getPr(41)!.stale_recheck).toBe(1);

    const [second] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(second!.round_no).toBe(2);
    expect(second!.round_type).toBe("staleness");
    expect(store.getPr(41)!.stale_recheck).toBe(0);
  });

  it("never dispatches a PR that is not queued", async () => {
    store.upsertPr({
      number: 51,
      state: "awaiting_author",
      head_sha: "x",
      title: "t",
      author: "alice",
      trigger_ts: "2026-08-13T09:00:00Z",
      stale_recheck: 0,
      escalation_worthy: 0,
      migration_gate: 0,
    });
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(0);
    expect(adapter.calls).toHaveLength(0);
  });

  it("serializes concurrent pumps so one PR gets one round and the cap holds", async () => {
    const cfg = { ...baseCfg, daemon: { ...baseCfg.daemon, max_concurrent_rounds: 1 } };
    queue(58, "2026-08-13T09:00:00Z");
    queue(59, "2026-08-13T09:01:00Z");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { hooks, orders } = recordingHooks();
    const original = hooks.dispatchRound;
    hooks.dispatchRound = async (order, prompt) => {
      await blocked;
      await original(order, prompt);
    };

    const first = dispatchOnce({ cfg, store, adapter, hooks });
    const joined = dispatchOnce({ cfg, store, adapter, hooks });
    release();
    expect((await first).map((o) => o.pr)).toEqual([58]);
    expect(await joined).toEqual([]);
    expect(orders.map((o) => o.order.pr)).toEqual([58]);
    expect(store.runningRounds()).toHaveLength(1);
    expect(store.getPr(59)!.state).toBe("queued");
    expect(adapter.calls.filter((c) => c.fn === "removeLabel" && c.pr === 58)).toHaveLength(1);
  });

  it("discards a provisional round and leaves the PR queued when session dispatch fails", async () => {
    queue(60, "2026-08-13T09:00:00Z");
    const hooks = recordingHooks().hooks;
    hooks.dispatchRound = async () => { throw new Error("worktree index.lock"); };

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
    expect(store.getPr(60)!.state).toBe("queued");
    expect(store.runningRounds()).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE pr = 60").get()).toMatchObject({ c: 0 });
    const failure = store.db.prepare("SELECT payload FROM events WHERE kind = 'dispatch_failed' AND pr = 60").get() as { payload: string };
    expect(JSON.parse(failure.payload)).toMatchObject({ round_id: 1, error: expect.stringContaining("index.lock") });
  });

  it("one failing PR does not stall the pump", async () => {
    queue(61, "2026-08-13T09:00:00Z");
    queue(62, "2026-08-13T09:30:00Z");
    const bad = new (class extends FakeAdapter {
      override async listPrFiles(n: number): Promise<PrFileEntry[]> {
        if (n === 61) throw new Error("files API 502");
        return [];
      }
    })();
    const { hooks } = recordingHooks();
    const dispatched = await dispatchOnce({ cfg: baseCfg, store, adapter: bad, hooks });
    expect(dispatched.map((o) => o.pr)).toEqual([62]);
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatch_failed'").get()).toMatchObject({ c: 1 });
  });
});
