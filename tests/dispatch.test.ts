import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { ALL_PASSES, buildPassPlan, capacity, dispatchOnce, queuedInOrder, roundTypeFor, validatorTier, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { StateStore } from "../src/state.js";
import { applyEvent } from "../src/statemachine.js";
import { PASS_TIER_ORDER } from "../src/types.js";
import { renderRoundPrompt, roundTemplateFile } from "../src/templates.js";
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
  /** PR → base branch; absent means "master". Set to throw via failGetPrOn. */
  baseRefs = new Map<number, string>();
  failGetPrOn = new Set<number>();

  async getPr(n: number): Promise<{ base_ref: string }> {
    this.calls.push({ fn: "getPr", pr: n });
    if (this.failGetPrOn.has(n)) throw new Error("500 boom");
    return { base_ref: this.baseRefs.get(n) ?? "master" };
  }
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
  async createReview(n: number, payload: { event: string; body: string }): Promise<GateResult> {
    this.calls.push({ fn: "createReview", pr: n, arg: payload.event });
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

  // the audit trail — which tier held the veto in this round.
  it("records the validator's tier on the round row and the dispatch event", async () => {
    queue(23, "2026-08-13T09:00:00Z");
    adapter.files.set(23, [file("auth/permissions.py", 10, 2)]);
    const { hooks, orders } = recordingHooks();

    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });

    const round = store.roundsFor(23)[0]!;
    const planned = orders[0]!.order.pass_plan.find((p) => p.lens === "pass-validate")!;
    expect(round.validate_tier).toBe(planned.tier);
    expect(round.validate_tier).toBe("sol-high");
    const dispatched = store.recentEvents(50).find((e) => e.kind === "round_dispatched")!;
    expect(JSON.parse(dispatched.payload ?? "{}").validate_tier).toBe("sol-high");
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

  it("a failed (cancelled, verdict-less) round does not age the PR — next round is still 'first' with review_no 1", async () => {
    // Live 2026-08-18, #5313: two rounds died before posting anything and the
    // PR was dispatched as "round 3 (re-review)" with the nit cap active,
    // despite zero posted reviews. Failed rounds advance round_no (the audit
    // sequence) but must not advance the review age.
    queue(31, "2026-08-13T09:00:00Z");
    const { hooks, orders } = recordingHooks();
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    store.markRoundCancelled(store.runningRounds()[0]!.id, "session lost");
    expect(store.priorRoundCount(31)).toBe(0);

    queue(31, "2026-08-13T10:00:00Z");
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    const order = orders[1]!.order;
    expect(order.round_no).toBe(2); // audit sequence keeps counting
    expect(order.round_type).toBe("first"); // review age does not
    expect(order.review_no).toBe(1);
  });
});

describe("buildPassPlan", () => {
  // Deterministic knobs regardless of config.toml churn.
  const planCfg: Config = {
    ...baseCfg,
    models: {
      ...baseCfg.models,
      risk_passes: ["pass-security", "pass-prod-risk", "pass-data-safety"],
      validate_tier: "terra-med",
      small_diff_lines: 150,
    },
  };

  it("pins risk passes to sol-high with no raise ladder", () => {
    const { pass_plan } = buildPassPlan(planCfg, [
      file("infra/main.tf", 120, 5),
      file("auth/permissions.py", 10, 2),
      file("app/migrations/0007_add_index.py", 30, 0),
    ]);
    for (const lens of ["pass-security", "pass-prod-risk", "pass-data-safety"]) {
      const entry = pass_plan.find((p) => p.lens === lens)!;
      expect(entry).toEqual({ lens, agent: `${lens}--sol-high`, tier: "sol-high", raisable_to: [] });
    }
  });

  it("runs pass-validate at cfg.models.validate_tier when nothing outranks it, never raisable", () => {
    // A tiny quiet diff: every lens is terra-med, so the floor stands.
    const { pass_plan } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
    expect(pass_plan[pass_plan.length - 1]).toEqual({
      lens: "pass-validate",
      agent: "pass-validate--terra-med",
      tier: "terra-med",
      raisable_to: [],
    });
    const solValidate = buildPassPlan(
      { ...planCfg, models: { ...planCfg.models, validate_tier: "sol-high" } },
      [file("README.md", 3, 1)],
    ).pass_plan;
    expect(solValidate[solValidate.length - 1]!.agent).toBe("pass-validate--sol-high");
    expect(solValidate[solValidate.length - 1]!.raisable_to).toEqual([]);
  });

  // the validator vetoes every finding in the round, so it may never
  // run below the model that produced them.
  it("raises pass-validate to the round's highest lens tier", () => {
    // A risk lens (sol-high) alongside a terra-med floor.
    const risky = buildPassPlan(planCfg, [file("auth/permissions.py", 10, 2)]).pass_plan;
    const validate = risky.find((p) => p.lens === "pass-validate")!;
    expect(risky.find((p) => p.lens === "pass-security")!.tier).toBe("sol-high");
    expect(validate).toEqual({
      lens: "pass-validate",
      agent: "pass-validate--sol-high",
      tier: "sol-high",
      raisable_to: [],
    });
    // A big non-risk diff lands the lenses on sol-med — the validator follows.
    const medium = buildPassPlan(planCfg, [file("app/service.py", 200, 0)]).pass_plan;
    expect(medium.find((p) => p.lens === "pass-validate")!.tier).toBe("sol-med");
  });

  it("never runs the validator below any lens, whatever the plan", () => {
    const sets: PrFileEntry[][] = [
      [file("README.md", 3, 1)],
      [file("app/service.py", 200, 0)],
      [file("auth/permissions.py", 10, 2)],
      [file("infra/main.tf", 120, 5), file("app/migrations/0007_add_index.py", 30, 0)],
      [file("frontend/App.tsx", 40, 4), file("app/api/routes.py", 10, 1)],
    ];
    for (const files of sets) {
      const { pass_plan } = buildPassPlan(planCfg, files);
      const validate = pass_plan.find((p) => p.lens === "pass-validate")!;
      for (const p of pass_plan) {
        expect(PASS_TIER_ORDER.indexOf(validate.tier)).toBeGreaterThanOrEqual(PASS_TIER_ORDER.indexOf(p.tier));
      }
    }
  });

  it("the shipped config pins the validator at the top tier", () => {
    expect(baseCfg.models.validate_tier).toBe("sol-high");
  });

  it("validatorTier is the floor raised by the highest lens tier, never lowered", () => {
    expect(validatorTier("terra-med", [])).toBe("terra-med");
    expect(validatorTier("terra-med", ["terra-med", "sol-med"])).toBe("sol-med");
    expect(validatorTier("terra-med", ["sol-high", "terra-med"])).toBe("sol-high");
    expect(validatorTier("sol-high", ["terra-med", "sol-med"])).toBe("sol-high");
    expect(validatorTier("sol-med", ["terra-med"])).toBe("sol-med");
  });

  it("gives non-risk lenses the heuristic tier with an ascending raise ladder", () => {
    // Small quiet diff → terra-med, raisable through sol-med to sol-high.
    const small = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
    expect(small.pass_plan[0]).toEqual({
      lens: "pass-baseline",
      agent: "pass-baseline--terra-med",
      tier: "terra-med",
      raisable_to: ["pass-baseline--sol-med", "pass-baseline--sol-high"],
    });
    // Diff at/over small_diff_lines → sol-med, only sol-high above it.
    const big = buildPassPlan(planCfg, [file("app/service.py", 200, 0)]);
    expect(big.pass_plan[0]).toEqual({
      lens: "pass-baseline",
      agent: "pass-baseline--sol-med",
      tier: "sol-med",
      raisable_to: ["pass-baseline--sol-high"],
    });
    // Migration gate forces sol-med even on a tiny diff (for non-risk lenses).
    const gated = buildPassPlan(planCfg, [file("app/migrations/0001_init.py", 5, 0)]);
    expect(gated.pass_plan[0]!.tier).toBe("sol-med");
  });

  it("addable_lenses = every known pass not already planned", () => {
    const { pass_plan, addable_lenses } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
    expect(pass_plan.map((p) => p.lens)).toEqual(["pass-baseline", "pass-validate"]);
    expect(addable_lenses).toEqual(ALL_PASSES.filter((l) => l !== "pass-baseline" && l !== "pass-validate"));
    expect(addable_lenses).not.toContain("pass-validate");
  });

  // pass-intent: selected on the PR body's substance, priced at the
  // cheapest tier whatever the round's default, raisable like any other lens.
  describe("pass-intent", () => {
    const body =
      "This PR introduces a token-bucket rate limiter for the public API. " +
      "Requests over the limit receive a 429 with a Retry-After header, and " +
      "the bucket refills once per second per client key.";

    it("starts at terra-med even when the round's default tier is sol-med", () => {
      // 200 changed lines ⇒ defaultTier sol-med; intent stays terra-med.
      const { pass_plan } = buildPassPlan(planCfg, [file("app/service.py", 200, 0)], { body });
      const intent = pass_plan.find((p) => p.lens === "pass-intent")!;
      expect(intent).toEqual({
        lens: "pass-intent",
        agent: "pass-intent--terra-med",
        tier: "terra-med",
        raisable_to: ["pass-intent--sol-med", "pass-intent--sol-high"],
      });
      // Its terra-med never DRAGS the validator below the round's highest lens.
      const validate = pass_plan.find((p) => p.lens === "pass-validate")!;
      expect(validate.tier).toBe("sol-med");
    });

    it("is skipped (and stays addable) when the body is thin or absent", () => {
      for (const intentArg of [undefined, {}, { body: "fixes the bug" }] as const) {
        const { pass_plan, addable_lenses } = buildPassPlan(planCfg, [file("app/service.py", 200, 0)], intentArg);
        expect(pass_plan.map((p) => p.lens)).not.toContain("pass-intent");
        expect(addable_lenses).toContain("pass-intent");
      }
    });
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
      { fn: "getPr", pr: 21 }, // base branch, for the worktree fetch
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

  it("builds the round order from the files API: lenses and the migration gate", async () => {
    queue(31, "2026-08-13T09:00:00Z", { title: "Terraform the ingest cluster", head: "abc123" });
    adapter.files.set(31, [
      file("infra/main.tf", 120, 5),
      file("app/migrations/0007_add_index.py", 30, 0),
      file("app/serializers/routes.py", 40, 2),
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
    expect(order!.migration_gate).toBe(true);
    // The escalation heuristic is gone: an infra-shaped diff carries no flag.
    expect((order as unknown as Record<string, unknown>).escalation_worthy).toBeUndefined();
    expect((order as unknown as Record<string, unknown>).escalation_reasons).toBeUndefined();
    // pass_plan mirrors lenses in order; addable = the known passes not planned.
    expect(order!.pass_plan.map((p) => p.lens)).toEqual(order!.lenses);
    expect(order!.addable_lenses).toEqual(ALL_PASSES.filter((l) => !order!.lenses.includes(l)));

    const row = store.getPr(31)!;
    expect(row.migration_gate).toBe(1);
    expect(orders[0]!.prompt).toContain('"pr": 31'); // default renderer = JSON
  });

  it("leaves a small tidy PR ungated", async () => {
    queue(32, "2026-08-13T09:00:00Z");
    adapter.files.set(32, [file("README.md", 3, 1)]);
    const { hooks } = recordingHooks();
    const [order] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(order!.migration_gate).toBe(false);
    expect(order!.lenses).toEqual(["pass-baseline", "pass-validate"]);
    // Small quiet diff: baseline starts terra-med and can be raised up the ladder.
    expect(order!.pass_plan[0]).toEqual({
      lens: "pass-baseline",
      agent: "pass-baseline--terra-med",
      tier: "terra-med",
      raisable_to: ["pass-baseline--sol-med", "pass-baseline--sol-high"],
    });
  });

  // ---- worktree facts in the order (2026-08-18) ---------------------------

  it("carries the prepared tree's base facts into the order", async () => {
    queue(60, "2026-08-13T09:00:00Z", { head: "snapshot-sha" });
    adapter.baseRefs.set(60, "release/2026-08");
    const asked: Array<[number, string]> = [];
    const { hooks } = recordingHooks();
    const [order] = await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      prepareWorktree: async (pr, baseRef) => {
        asked.push([pr, baseRef]);
        return { head_sha: "snapshot-sha", base_ref: baseRef, base_sha: "base-tip", merge_base: "fork-point" };
      },
    });
    // The PR's OWN base branch is what gets fetched, not a hardcoded master.
    expect(asked).toEqual([[60, "release/2026-08"]]);
    expect(order!.base_ref).toBe("release/2026-08");
    expect(order!.base_sha).toBe("base-tip");
    expect(order!.merge_base).toBe("fork-point");
  });

  it("prefers the tree's real sha over the PR row snapshot and logs the drift", async () => {
    queue(61, "2026-08-13T09:00:00Z", { head: "stale-snapshot" });
    const { hooks } = recordingHooks();
    const [order] = await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      // A push landed between the reconcile snapshot and the fetch.
      prepareWorktree: async () => ({ head_sha: "pushed-sha", base_ref: "master", base_sha: "b", merge_base: "m" }),
    });
    expect(order!.head_sha).toBe("pushed-sha");
    const drift = store.db.prepare("SELECT payload FROM events WHERE kind = 'head_drift'").all() as Array<{ payload: string }>;
    expect(drift).toHaveLength(1);
    expect(JSON.parse(drift[0]!.payload)).toMatchObject({ expected: "stale-snapshot", actual: "pushed-sha" });
  });

  it("logs no drift when the tree matches the snapshot", async () => {
    queue(62, "2026-08-13T09:00:00Z", { head: "same-sha" });
    const { hooks } = recordingHooks();
    await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      prepareWorktree: async () => ({ head_sha: "same-sha", base_ref: "master", base_sha: "b", merge_base: "m" }),
    });
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'head_drift'").get()).toMatchObject({ c: 0 });
  });

  it("still dispatches when the base-ref lookup fails — degraded, not blocked", async () => {
    queue(63, "2026-08-13T09:00:00Z", { head: "abc" });
    adapter.failGetPrOn.add(63);
    const { hooks } = recordingHooks();
    const [order] = await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      prepareWorktree: async (_pr, baseRef) => ({ head_sha: "abc", base_ref: baseRef, base_sha: "", merge_base: "" }),
    });
    expect(order).toBeDefined();
    expect(order!.base_ref).toBe("");
  });

  it("falls back to the row sha with empty base facts when there is no worktree seam", async () => {
    queue(64, "2026-08-13T09:00:00Z", { head: "row-sha" });
    const { hooks } = recordingHooks();
    const [order] = await dispatchOnce({ cfg: baseCfg, store, adapter, hooks });
    expect(order!.head_sha).toBe("row-sha");
    expect(order!.base_ref).toBe("");
    expect(order!.merge_base).toBe("");
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

  // the nit treadmill's stopping rule must reach the passes through
  // their task strings, and passes are blank slates — so the dispatched round
  // prompt itself must carry the verbatim NIT SCOPE block from round 3 onward,
  // rendered through the REAL shipped templates.
  it("arms the NIT SCOPE task-string block in the dispatched prompt from round 3, not before", async () => {
    const templates = new Map(
      (["first", "re-review", "staleness"] as const).map((rt) => [
        rt,
        readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile(rt)), "utf8"),
      ]),
    );
    const renderPrompt = (o: RoundOrder) => renderRoundPrompt(templates.get(o.round_type)!, o);
    const { hooks, orders } = recordingHooks();
    queue(89, "2026-08-13T09:00:00Z", { head: "h1" });
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, renderPrompt });
    store.finishRound(store.runningRounds()[0]!.id, "REQUEST_CHANGES", 1);
    queue(89, "2026-08-13T10:00:00Z", { head: "h2" });
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, renderPrompt });
    store.finishRound(store.runningRounds()[0]!.id, "REQUEST_CHANGES", 1);
    queue(89, "2026-08-13T11:00:00Z", { head: "h3" });
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, renderPrompt });

    expect(orders.map((o) => [o.order.round_no, o.order.round_type])).toEqual([
      [1, "first"],
      [2, "re-review"],
      [3, "re-review"],
    ]);
    // Rounds 1–2: no armed block in what the session was handed.
    expect(orders[0]!.prompt).not.toContain("NIT SCOPE: this is round");
    expect(orders[1]!.prompt).not.toContain("NIT SCOPE: this is round");
    // Round 3: the verbatim block, round number stated, rule + exemption whole.
    const p3 = orders[2]!.prompt;
    expect(p3).toContain("fenced block below VERBATIM into every lens pass's task string");
    expect(p3).toContain("NIT SCOPE: this is round 3 of this PR's review");
    expect(p3).toContain("inside the current delta");
    expect(p3).toContain("P0–P2 findings are exempt");
    expect(p3).toContain("running non-blocking thread");
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

describe("first-party directive escalation pick", () => {
  const tree = { head_sha: "sha70", base_ref: "master", base_sha: "basetip", merge_base: "forkpoint" };

  it("puts the directive files and the git-picked mention on the order, deterministically and logged", async () => {
    queue(70, "2026-08-13T10:00:00Z", { head: "sha70" });
    adapter.files.set(70, [file(".claude/skills/uja/SKILL.md"), file("src/app.py")]);
    const { hooks, orders } = recordingHooks();
    const lookups: Array<{ sha: string; paths: string[] }> = [];
    await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      prepareWorktree: async () => tree,
      directiveAuthor: async (sha, paths) => {
        lookups.push({ sha, paths });
        return { login: "alex", name: "Alex", email: "7+alex@users.noreply.github.com" };
      },
    });
    // The lookup runs at the MERGE BASE over the directive files only — the
    // PR's own commits can never elect the PR author as their own approver.
    expect(lookups).toEqual([{ sha: "forkpoint", paths: [".claude/skills/uja/SKILL.md"] }]);
    expect(orders[0]!.order.first_party_directives).toEqual({
      files: [".claude/skills/uja/SKILL.md"],
      mention: "alex",
    });
    const ev = store.db.prepare("SELECT payload FROM events WHERE kind = 'escalation_mention_selected'").get() as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ mention: "alex", source: "git-log", sha: "forkpoint" });
  });

  it("falls back to config [review].escalation_mention_default when git yields no login", async () => {
    queue(71, "2026-08-13T10:00:00Z", { head: "sha70" });
    adapter.files.set(71, [file("CLAUDE.md")]);
    const { hooks, orders } = recordingHooks();
    await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      prepareWorktree: async () => tree,
      directiveAuthor: async () => null,
    });
    expect(orders[0]!.order.first_party_directives).toEqual({
      files: ["CLAUDE.md"],
      mention: baseCfg.review.escalation_mention_default,
    });
    const ev = store.db.prepare("SELECT payload FROM events WHERE kind = 'escalation_mention_selected'").get() as { payload: string };
    expect(JSON.parse(ev.payload)).toMatchObject({ source: "config-default" });
  });

  it("degrades to the fallback — never a lost round — when the author lookup throws or is absent", async () => {
    queue(72, "2026-08-13T10:00:00Z", { head: "sha70" });
    adapter.files.set(72, [file("prompts/system.md")]);
    const { hooks, orders } = recordingHooks();
    const dispatched = await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      prepareWorktree: async () => tree,
      directiveAuthor: async () => {
        throw new Error("git exploded");
      },
    });
    expect(dispatched).toHaveLength(1);
    expect(orders[0]!.order.first_party_directives!.mention).toBe(baseCfg.review.escalation_mention_default);

    // No seam at all (stub-wired core): same fallback.
    queue(73, "2026-08-13T11:00:00Z", { head: "sha70" });
    adapter.files.set(73, [file("AGENTS.md")]);
    const second = recordingHooks();
    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks: second.hooks });
    expect(second.orders[0]!.order.first_party_directives!.mention).toBe(baseCfg.review.escalation_mention_default);
  });

  it("a PR touching no directive file carries no field and logs no pick", async () => {
    queue(74, "2026-08-13T10:00:00Z", { head: "sha70" });
    adapter.files.set(74, [file("src/app.py"), file("backend/prompts/nested.md"), file("node_modules/x/CLAUDE.md")]);
    const { hooks, orders } = recordingHooks();
    await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      prepareWorktree: async () => tree,
      directiveAuthor: async () => ({ login: "alex", name: "Alex", email: "e" }),
    });
    expect(orders[0]!.order.first_party_directives).toBeUndefined();
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'escalation_mention_selected'").get()).toMatchObject({ c: 0 });
  });
});
