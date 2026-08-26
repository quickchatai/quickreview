import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { ALL_PASSES, buildPassPlan, capacity, dispatchOnce, queuedInOrder, roundTypeFor, validatorTier, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { recheckFingerprint } from "../src/recheck.js";
import { StateStore } from "../src/state.js";
import { applyEvent } from "../src/statemachine.js";
import { PASS_TIER_ORDER } from "../src/types.js";
import { renderRoundPrompt, roundTemplateFile } from "../src/templates.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import type { ContextAssembler } from "../src/memory/context.js";

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
  /** `${base}..${head}` → delta files. Absent range ⇒ empty delta. */
  compares = new Map<string, PrFileEntry[]>();
  failCompare = false;

  async compareFiles(base: string, head: string): Promise<PrFileEntry[]> {
    this.calls.push({ fn: "compareFiles", pr: 0, arg: `${base}..${head}` });
    if (this.failCompare) throw new Error("compare boom");
    return this.compares.get(`${base}..${head}`) ?? [];
  }

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

function queue(
  pr: number,
  triggerTs: string | null,
  over: Partial<{ title: string; head: string; provenance: "human" | "system" | null }> = {},
): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: over.head ?? `sha${pr}`,
    title: over.title ?? `PR ${pr}`,
    author: "alice",
    trigger_ts: triggerTs,
    trigger_provenance: over.provenance ?? null,
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
    expect(JSON.parse(round.pass_plan!)).toEqual(orders[0]!.order.pass_plan);
    const addable = JSON.parse(round.addable_passes!) as Array<{ lens: string; tier: string }>;
    expect(addable).toContainEqual({ lens: "pass-concurrency", tier: "sol-med" });
    expect(addable.filter((p) => baseCfg.models.risk_passes.includes(p.lens as never)).every((p) => p.tier === "sol-high")).toBe(true);
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

  // the concurrency lens is ADDABLE-ONLY: a read-modify-write race
  // has no filename (the 29 corpus findings span eight unrelated modules), so
  // no path predicate may plan it. It reaches a round only through the add
  // protocol, when the session names the read-then-write it suspects.
  describe("pass-concurrency", () => {
    it("is a known pass, so it is always in the addable set", () => {
      expect(ALL_PASSES).toContain("pass-concurrency");
      const { addable_lenses } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
      expect(addable_lenses).toContain("pass-concurrency");
    });

    it("is NEVER planned by path selection — not on any surface", () => {
      const surfaces: PrFileEntry[][] = [
        [file("app/messages_update.py", 200, 10)],
        [file("app/chat.py", 40, 3)],
        [file("app/models.py", 200, 0)],
        [file("app/shopping_handler.py", 120, 5)],
        [file("app/scraper.py", 80, 2)],
        [file("app/router.py", 200, 0)],
        [file("app/article_update.py", 60, 1)],
        [file("app/views.py", 300, 20)],
        [file("app/migrations/0042_add_col.py", 5, 0)],
        [file("app/tasks/retrain.py", 200, 0)],
        [file("src/components/Thing.tsx", 90, 4)],
        [file("app/serializers/user.py", 200, 0), file("project/settings_prod.py", 12, 1)],
        [file("README.md", 3, 1)],
      ];
      for (const files of surfaces) {
        const { pass_plan, addable_lenses } = buildPassPlan(planCfg, files, {
          body:
            "This PR introduces a token-bucket rate limiter for the public API. " +
            "Requests over the limit receive a 429 with a Retry-After header, and " +
            "the bucket refills once per second per client key.",
        });
        const label = files.map((f) => f.filename).join(",");
        expect(pass_plan.map((p) => p.lens), label).not.toContain("pass-concurrency");
        expect(addable_lenses, label).toContain("pass-concurrency");
      }
    });

    it("is not a risk pass — it needs no config entry and stays tier-laddered", () => {
      expect(planCfg.models.risk_passes).not.toContain("pass-concurrency");
      expect(baseCfg.models.risk_passes).not.toContain("pass-concurrency");
    });
  });

  // the ask-your-human lens is ADDABLE-ONLY too: no path predicate
  // finds "code whose intent was never written down", and whether the answer
  // is in the repo at all is only visible once the diff has been read.
  describe("pass-ask-human", () => {
    const body =
      "This PR introduces a token-bucket rate limiter for the public API. " +
      "Requests over the limit receive a 429 with a Retry-After header, and " +
      "the bucket refills once per second per client key.";

    it("is a known pass, so it is always in the addable set", () => {
      expect(ALL_PASSES).toContain("pass-ask-human");
      const { addable_lenses } = buildPassPlan(planCfg, [file("README.md", 3, 1)]);
      expect(addable_lenses).toContain("pass-ask-human");
    });

    it("is NEVER planned by path selection — not on any surface, thin body or thick", () => {
      const surfaces: PrFileEntry[][] = [
        [file("app/service.py", 200, 0)],
        [file("app/views.py", 300, 20)],
        [file("app/migrations/0042_add_col.py", 5, 0)],
        [file("src/components/Thing.tsx", 90, 4)],
        [file("project/settings_prod.py", 12, 1)],
        [file("README.md", 3, 1)],
      ];
      for (const files of surfaces) {
        for (const intent of [{ body }, { body: "" }, undefined]) {
          const { pass_plan, addable_lenses } = buildPassPlan(planCfg, files, intent);
          const label = `${files.map((f) => f.filename).join(",")} / body=${intent?.body?.length ?? "none"}`;
          expect(pass_plan.map((p) => p.lens), label).not.toContain("pass-ask-human");
          expect(addable_lenses, label).toContain("pass-ask-human");
        }
      }
    });

    it("is not a risk pass — it needs no config entry and stays tier-laddered", () => {
      expect(planCfg.models.risk_passes).not.toContain("pass-ask-human");
      expect(baseCfg.models.risk_passes).not.toContain("pass-ask-human");
    });
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

  // the judgment lenses ride the default tier ladder and stay
  // raisable, exactly like any non-risk lens; pin the plan entries so a
  // future tier change cannot ship silently.
  describe("judgment lenses", () => {
    it("plans simplicity + backcompat at the round's default tier, raisable", () => {
      // 200 changed serializer lines ⇒ default sol-med; selects contracts,
      // backcompat (wire surface) and simplicity (size).
      const { pass_plan } = buildPassPlan(planCfg, [file("app/serializers/user.py", 200, 0)]);
      expect(pass_plan.find((p) => p.lens === "pass-backcompat")).toEqual({
        lens: "pass-backcompat",
        agent: "pass-backcompat--sol-med",
        tier: "sol-med",
        raisable_to: ["pass-backcompat--sol-high"],
      });
      expect(pass_plan.find((p) => p.lens === "pass-simplicity")).toEqual({
        lens: "pass-simplicity",
        agent: "pass-simplicity--sol-med",
        tier: "sol-med",
        raisable_to: ["pass-simplicity--sol-high"],
      });
    });

    it("plans placement at terra-med on a small new-file diff", () => {
      const added = { ...file("src/tools/new_helper.py", 20, 0), status: "added" };
      const { pass_plan } = buildPassPlan(planCfg, [added]);
      expect(pass_plan.find((p) => p.lens === "pass-placement")).toEqual({
        lens: "pass-placement",
        agent: "pass-placement--terra-med",
        tier: "terra-med",
        raisable_to: ["pass-placement--sol-med", "pass-placement--sol-high"],
      });
      // A tiny added helper does not buy the size-keyed lenses.
      expect(pass_plan.map((p) => p.lens)).not.toContain("pass-simplicity");
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
    expect(orders[0]!.prompt).not.toContain("NIT SCOPE: this is review");
    expect(orders[1]!.prompt).not.toContain("NIT SCOPE: this is review");
    // Round 3: the verbatim block, round number stated, rule + exemption whole.
    const p3 = orders[2]!.prompt;
    expect(p3).toContain("fenced block below VERBATIM into every lens pass's task string");
    expect(p3).toContain("NIT SCOPE: this is review 3 of this PR");
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

describe("system re-trigger short-circuit", () => {
  const OLD = "aaa1111111111111111111111111111111111111";
  const NEW = "bbb2222222222222222222222222222222222222";

  /** A prior VERDICTED round + the reviewed-head mark — the re-review shape. */
  function reviewed(pr: number, head: string, verdict = "APPROVE"): void {
    const id = store.startRound(pr, "first", ["pass-baseline"], 60);
    store.finishRound(id, verdict, null);
    store.recordReviewedHead(pr, { head_sha: head, verdict, round_no: 1 });
  }

  /** skip_unchanged_head OFF so the daemon skip cannot mask the
   * short-circuit under test. */
  const cfg: Config = { ...baseCfg, guards: { ...baseCfg.guards, skip_unchanged_head: false } };

  function shortCircuitEvents(pr: number): Array<{ reason: string; delta_class: string; standing_verdict: string }> {
    return (store.db.prepare("SELECT payload FROM events WHERE pr = ? AND kind = 'dispatch_short_circuit'").all(pr) as Array<{ payload: string }>).map(
      (r) => JSON.parse(r.payload) as { reason: string; delta_class: string; standing_verdict: string },
    );
  }

  it("unchanged-head system re-trigger short-circuits — the #5308 r2 case", async () => {
    queue(41, "2026-08-19T10:00:00Z", { head: OLD, provenance: "system" });
    reviewed(41, OLD, "APPROVE");
    const { hooks, orders } = recordingHooks();

    expect(await dispatchOnce({ cfg, store, adapter, hooks })).toEqual([]);

    expect(orders).toEqual([]);
    expect(store.priorRoundCount(41)).toBe(1); // no new round
    expect(store.getPr(41)!.state).toBe("tracked"); // as the APPROVE uphold leaves it
    expect(shortCircuitEvents(41)).toMatchObject([{ reason: "unchanged-head", delta_class: "empty", standing_verdict: "APPROVE" }]);
    // The trigger is consumed but the PR is never painted "in progress".
    const fns = adapter.calls.map((c) => `${c.fn}:${c.pr}`);
    expect(fns).toContain("removeLabel:41");
    expect(fns).toContain("deleteTeamReviewRequest:41");
    expect(adapter.calls.filter((c) => c.fn === "addLabel")).toEqual([]);
  });

  it("a clean base merge touching no PR-owned files short-circuits — the #5308 r6 case", async () => {
    queue(42, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(42, OLD, "APPROVE");
    adapter.files.set(42, [file("mine.ts")]);
    adapter.compares.set(`${OLD}..${NEW}`, [file("base/other.py", 30, 4), file("base/second.py", 8, 1)]);
    const { hooks, orders } = recordingHooks();

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);

    expect(orders).toEqual([]);
    expect(store.priorRoundCount(42)).toBe(1);
    expect(store.getPr(42)!.state).toBe("tracked");
    const [ev] = shortCircuitEvents(42);
    expect(ev).toMatchObject({ reason: "trivial-delta", delta_class: "trivial", standing_verdict: "APPROVE" });
    // Terminal for this head: the reconcile push-backstop's exact fingerprint
    // is claimed, so the same question is never re-asked every sweep.
    expect(store.hasRecheck(42, recheckFingerprint({ trigger: "push" }, NEW))).toBe(true);
  });

  it("a significant delta dispatches the full round as today", async () => {
    queue(43, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(43, OLD, "APPROVE");
    adapter.files.set(43, [file("mine.ts")]);
    adapter.compares.set(`${OLD}..${NEW}`, [file("mine.ts", 12, 3)]); // PR-owned content change
    const { hooks, orders } = recordingHooks();

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
    expect(orders).toHaveLength(1);
    expect(shortCircuitEvents(43)).toEqual([]);
  });

  it("human provenance never short-circuits, even on an empty delta", async () => {
    queue(44, "2026-08-19T10:00:00Z", { head: NEW, provenance: "human" });
    reviewed(44, OLD, "APPROVE");
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
    expect(shortCircuitEvents(44)).toEqual([]);
  });

  it("legacy null provenance never short-circuits (full round is the safe default)", async () => {
    queue(45, "2026-08-19T10:00:00Z", { head: NEW, provenance: null });
    reviewed(45, OLD, "APPROVE");
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
  });

  it("first reviews never short-circuit", async () => {
    queue(46, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
    expect(shortCircuitEvents(46)).toEqual([]);
  });

  it("a withheld approval at this head still dispatches —'s retry must post", async () => {
    queue(47, "2026-08-19T10:00:00Z", { head: OLD, provenance: "system" });
    reviewed(47, OLD, "APPROVE");
    store.recordApprovalWithheld(47, { head_sha: OLD });
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg, store, adapter, hooks })).toHaveLength(1);
    expect(shortCircuitEvents(47)).toEqual([]);
  });

  it("an author reply pending on the mark blocks the unchanged-head skip", async () => {
    queue(48, "2026-08-19T10:00:00Z", { head: OLD, provenance: "system" });
    reviewed(48, OLD, "APPROVE");
    store.noteAuthorReply(48, "2099-01-01T00:00:00.000Z");
    const { hooks } = recordingHooks();
    expect(await dispatchOnce({ cfg, store, adapter, hooks })).toHaveLength(1);
    expect(shortCircuitEvents(48)).toEqual([]);
  });

  it("standing REQUEST_CHANGES short-circuits back to awaiting_author and claims no recheck", async () => {
    queue(49, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(49, OLD, "REQUEST_CHANGES");
    const { hooks } = recordingHooks();

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
    expect(store.getPr(49)!.state).toBe("awaiting_author");
    expect(shortCircuitEvents(49)).toMatchObject([{ reason: "empty-delta", standing_verdict: "REQUEST_CHANGES" }]);
    // The rechecks table is the APPROVE path's guard — untouched here.
    expect(store.rechecksFor(49)).toEqual([]);
  });

  it("carries a withheld approval to the new head on a trivial short-circuit (amendment 3)", async () => {
    queue(50, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(50, OLD, "APPROVE");
    store.recordApprovalWithheld(50, { head_sha: OLD, ci_state: "red", reason: "red-ci" });
    const { hooks } = recordingHooks();

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
    expect(store.approvalWithheld(50)).toMatchObject({ head_sha: NEW });
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE pr = 50 AND kind = 'approval_withheld_carried'").get()).toEqual({ c: 1 });
  });

  it("an existing recheck claim is left untouched — no double-claim against", async () => {
    queue(51, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(51, OLD, "APPROVE");
    const fp = recheckFingerprint({ trigger: "push" }, NEW);
    store.claimRecheck(51, fp, { head_sha: NEW, trigger: "push", reason: "real-recheck" });
    const { hooks } = recordingHooks();

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toEqual([]);
    const claims = store.rechecksFor(51);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ fingerprint: fp, reason: "real-recheck" });
  });

  it("a failed compare read falls back to the full round", async () => {
    queue(52, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(52, OLD, "APPROVE");
    adapter.failCompare = true;
    const { hooks } = recordingHooks();

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter, hooks })).toHaveLength(1);
    expect(shortCircuitEvents(52)).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE pr = 52 AND kind = 'dispatch_classifier_failed'").get()).toEqual({ c: 1 });
  });

  it("an adapter without the compare seam never short-circuits a moved head", async () => {
    queue(53, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(53, OLD, "APPROVE");
    const legacy = new FakeAdapter();
    (legacy as { compareFiles?: unknown }).compareFiles = undefined;
    const { hooks } = recordingHooks();

    expect(await dispatchOnce({ cfg: baseCfg, store, adapter: legacy, hooks })).toHaveLength(1);
    expect(shortCircuitEvents(53)).toEqual([]);
  });

  it("a hand-resolved merge conflict in the delta classifies significant — full round", async () => {
    queue(54, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(54, OLD, "APPROVE");
    adapter.files.set(54, [file("mine.ts")]);
    adapter.compares.set(`${OLD}..${NEW}`, [file("base/other.py", 30, 4)]);
    const { hooks } = recordingHooks();

    const orders = await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      resolvedFilesInMerges: async () => ({ files: ["base/other.py"], degraded: false }),
    });
    expect(orders).toHaveLength(1);
    expect(shortCircuitEvents(54)).toEqual([]);
  });

  it("a degraded merge-verify keeps the delta-only classification but is never quiet", async () => {
    queue(55, "2026-08-19T10:00:00Z", { head: NEW, provenance: "system" });
    reviewed(55, OLD, "APPROVE");
    adapter.files.set(55, [file("mine.ts")]);
    adapter.compares.set(`${OLD}..${NEW}`, [file("base/other.py", 30, 4)]);
    const { hooks } = recordingHooks();

    const orders = await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      resolvedFilesInMerges: async () => ({ files: [], degraded: true }),
    });
    expect(orders).toEqual([]); // delta-only classification: trivial base-merge
    expect(shortCircuitEvents(55)).toMatchObject([{ reason: "trivial-delta" }]);
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE pr = 55 AND kind = 'recheck_merge_verify_degraded'").get(),
    ).toEqual({ c: 1 });
  });
});

// round-memory seeding at dispatch: the pinned head and ONE budgeted
// context block reach the prompt, the call happens exactly once per round, and
// a memory outage can neither block nor delay a review.
describe("round-memory seeding", () => {
  class Assembler implements ContextAssembler {
    heads = 0;
    contexts = 0;
    queries: string[] = [];
    constructor(
      private readonly head = "STANDING: approvals are final.",
      private readonly block = "PRECEDENT: #4000 settled the retry budget.",
    ) {}
    async pinnedHead(): Promise<string> {
      this.heads += 1;
      return this.head;
    }
    async contextBlock(query: string, _opts: { maxTokens: number }): Promise<string> {
      this.contexts += 1;
      this.queries.push(query);
      return this.block;
    }
  }

  function memoryEvents(pr: number): Array<Record<string, unknown>> {
    return (
      store.db.prepare("SELECT payload FROM events WHERE pr = ? AND kind = 'round_memory_seeded'").all(pr) as Array<{
        payload: string;
      }>
    ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  }

  it("seeds the dispatched prompt with the head and the block, through the real template", async () => {
    queue(70, "2026-08-20T09:00:00Z", { title: "Cap the retry budget" });
    adapter.files.set(70, [file("api/retries.py")]);
    const assembler = new Assembler();
    const { hooks, orders } = recordingHooks();
    const tpl = readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile("first")), "utf8");

    await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      memory: { assembler },
      renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
    });

    expect(orders).toHaveLength(1);
    expect(orders[0]!.prompt).toContain("STANDING: approvals are final.");
    expect(orders[0]!.prompt).toContain("PRECEDENT: #4000 settled the retry budget.");
    // The query is derived from the PR's title and diff shape, at the sha the
    // worktree was prepared to.
    expect(assembler.queries[0]).toContain("Cap the retry budget");
    expect(assembler.queries[0]).toContain("api");
    expect(memoryEvents(70)).toMatchObject([{ degraded: false, round_no: 1 }]);
  });

  it("makes EXACTLY one context call per round — never one per pass, never two per round", async () => {
    queue(71, "2026-08-20T09:00:00Z");
    queue(72, "2026-08-20T09:30:00Z");
    adapter.files.set(71, [file("a.ts"), file("b.ts"), file("ui/c.tsx"), file("migrations/0001_x.py")]);
    adapter.files.set(72, [file("d.ts")]);
    const assembler = new Assembler();
    const { hooks, orders } = recordingHooks();

    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, memory: { assembler } });

    expect(orders).toHaveLength(2);
    // Two rounds — two calls, whatever the pass plan looked like.
    expect(orders[0]!.order.pass_plan.length).toBeGreaterThan(2);
    expect(assembler.contexts).toBe(2);
    expect(assembler.heads).toBe(2);
  });

  // The acceptance criterion: with the store unreachable the round still
  // renders and dispatches, memory-less, and it is not delayed while it waits.
  it("dispatches memory-less and on time when the store never answers", async () => {
    queue(73, "2026-08-20T09:00:00Z");
    adapter.files.set(73, [file("a.ts")]);
    const hung: ContextAssembler = {
      pinnedHead: () => new Promise(() => {}),
      contextBlock: () => new Promise(() => {}),
    };
    const { hooks, orders } = recordingHooks();
    const tpl = readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile("first")), "utf8");

    const started = Date.now();
    const dispatched = await dispatchOnce({
      cfg: baseCfg,
      store,
      adapter,
      hooks,
      memory: { assembler: hung, timeoutMs: 25 },
      renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem),
    });
    const elapsed = Date.now() - started;

    // Dispatched, complete, and bounded by the memory deadline — not by the
    // store's silence.
    expect(dispatched).toHaveLength(1);
    expect(elapsed).toBeLessThan(2000);
    expect(orders[0]!.prompt).toContain("MEMORY UNAVAILABLE THIS ROUND");
    expect(orders[0]!.prompt).toContain("Run the full 7-step round");
    expect(store.getPr(73)!.state).toBe("reviewing");
    // Logged AND alerted: the gap is never silent.
    expect(memoryEvents(73)).toMatchObject([{ degraded: true }]);
    const anomaly = store.db
      .prepare("SELECT payload FROM events WHERE pr = 73 AND kind = 'anomaly'")
      .get() as { payload: string };
    expect(JSON.parse(anomaly.payload).kind).toBe("round_memory_degraded");
  });

  it("a store that breaks its contract and throws still costs nothing but memory", async () => {
    queue(74, "2026-08-20T09:00:00Z");
    adapter.files.set(74, [file("a.ts")]);
    const broken: ContextAssembler = {
      pinnedHead: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:1933")),
      contextBlock: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:1933")),
    };
    const { hooks, orders } = recordingHooks();

    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, memory: { assembler: broken } });

    expect(orders).toHaveLength(1);
    expect(memoryEvents(74)).toMatchObject([{ degraded: true }]);
    expect(JSON.stringify(memoryEvents(74)[0]!["gaps"])).toContain("ECONNREFUSED");
  });

  it("keeps alerting bounded while the store stays down — the per-round record does not thin", async () => {
    const down = new Assembler("", "");
    const { hooks } = recordingHooks();
    for (const [pr, ts] of [[75, "2026-08-20T09:00:00Z"], [76, "2026-08-20T09:10:00Z"]] as const) {
      queue(pr, ts);
      adapter.files.set(pr, [file("a.ts")]);
    }

    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, memory: { assembler: down, alertCooldownMin: 60 } });

    expect(memoryEvents(75)).toHaveLength(1);
    expect(memoryEvents(76)).toHaveLength(1);
    expect(
      store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'anomaly'").get(),
    ).toEqual({ c: 1 });
  });

  it("with no memory wired at all, dispatch behaves exactly as before", async () => {
    queue(77, "2026-08-20T09:00:00Z");
    adapter.files.set(77, [file("a.ts")]);
    const { hooks, orders } = recordingHooks();
    const tpl = readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile("first")), "utf8");

    await dispatchOnce({ cfg: baseCfg, store, adapter, hooks, renderPrompt: (o, mem) => renderRoundPrompt(tpl, o, mem) });

    expect(orders).toHaveLength(1);
    expect(orders[0]!.prompt).not.toContain("STANDING INSTRUCTIONS");
    expect(orders[0]!.prompt).not.toContain("MEMORY UNAVAILABLE");
    expect(memoryEvents(77)).toEqual([]);
  });
});
