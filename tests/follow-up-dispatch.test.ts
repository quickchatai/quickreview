// slice D — follow-up rounds at dispatch (docs/follow-up-rounds.md):
// the delta scope is chosen for a later round with a reviewed head and a
// computable delta; every doubt falls back to today's full re-review with a
// `followup_full_round {reason}` event; the pre-approval sweep is owed only
// while the standing verdict is not APPROVE and no full look happened since
// round 1; the first round is untouched; every per-PR fact keeps the WHOLE
// PR's file list.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  buildPassPlan,
  decideFollowUp,
  followUpSweepOwed,
  leanFollowUpPlan,
  LEAN_ADDABLE_PASSES,
  sweepStartOf,
  dispatchOnce,
  renderDeltaPatch,
  type DispatchAdapter,
  type DispatchDeps,
} from "../src/dispatch.js";
import { DJANGO_ECOSYSTEM } from "../src/ecosystem.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import type { PriorFinding, PriorFindingsList } from "../src/priorfindings.js";
import { StateStore } from "../src/state.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import type { PrOwnedDelta, PrOwnedDeltaFile } from "../src/worktrees.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const baseCfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const OLD = "aaa1111111111111111111111111111111111111";
const NEW = "bbb2222222222222222222222222222222222222";
const BASE = "ccc3333333333333333333333333333333333333";
const MB = "ddd4444444444444444444444444444444444444";
const TREE = "eee5555555555555555555555555555555555555";

class FakeAdapter implements DispatchAdapter {
  files = new Map<number, PrFileEntry[]>();
  async getPr(): Promise<{ base_ref: string; body?: string }> {
    return { base_ref: "master", body: "" };
  }
  async listPrFiles(n: number): Promise<PrFileEntry[]> {
    return this.files.get(n) ?? [];
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

function hooksRecording(): { hooks: SessionHooks; orders: RoundOrder[] } {
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

function file(filename: string, additions = 10, deletions = 0): PrFileEntry {
  return { filename, additions, deletions, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" };
}

function deltaFile(path: string, additions = 3, deletions = 1): PrOwnedDeltaFile {
  return {
    path,
    status: "modified",
    additions,
    deletions,
    ranges: [[5, additions]],
    whole_file: false,
    patch: `@@ -5,${deletions} +5,${additions} @@\n-old\n+new\n+new\n+new\n`,
  };
}

let store: StateStore;
let adapter: FakeAdapter;
let deltaCalls: Array<Record<string, unknown>>;
let pinned: Array<[number, string]>;

beforeEach(() => {
  store = new StateStore(":memory:");
  adapter = new FakeAdapter();
  deltaCalls = [];
  pinned = [];
});

function queue(pr: number, head = NEW): void {
  store.upsertPr({
    number: pr,
    state: "queued",
    head_sha: head,
    title: `PR ${pr}`,
    author: "alice",
    trigger_ts: "2026-10-08T10:00:00Z",
    trigger_provenance: "human",
    stale_recheck: 0,
    migration_gate: 0,
  });
}

/** A delivered first round + the reviewed-head mark at OLD. */
function reviewed(pr: number, verdict = "REQUEST_CHANGES", mark = true): void {
  const id = store.startRound(pr, "first", ["pass-baseline"], 60);
  store.finishRound(id, verdict, null);
  if (mark) store.recordReviewedHead(pr, { head_sha: OLD, verdict, round_no: 1 });
}

function okDelta(files: PrOwnedDeltaFile[]): PrOwnedDelta {
  return {
    ok: true,
    tree: TREE,
    files,
    lines: files.reduce((n, f) => n + f.additions + f.deletions, 0),
    conflicted: [],
  };
}

function deps(over: Partial<DispatchDeps> & { delta?: PrOwnedDelta | (() => never) } = {}): {
  d: DispatchDeps;
  orders: RoundOrder[];
} {
  const { hooks, orders } = hooksRecording();
  const { delta, ...rest } = over;
  const d: DispatchDeps = {
    cfg: baseCfg,
    store,
    adapter,
    hooks,
    prepareWorktree: async () => ({
      head_sha: NEW,
      base_ref: "master",
      base_sha: BASE,
      merge_base: MB,
    }),
    ...(delta !== undefined
      ? {
          prOwnedDelta: async (q) => {
            deltaCalls.push(q);
            return typeof delta === "function" ? delta() : delta;
          },
        }
      : {}),
    pinReviewedHead: async (pr, sha) => {
      pinned.push([pr, sha]);
      return true;
    },
    ...rest,
  };
  return { d, orders };
}

function events(pr: number, kind: string): Array<Record<string, unknown>> {
  return (
    store.db
      .prepare("SELECT payload FROM events WHERE pr = ? AND kind = ? ORDER BY id")
      .all(pr, kind) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function lastRound(pr: number) {
  return store.roundsFor(pr).at(-1)!;
}

const PR_FILES = [
  file("app/api/views.py", 300, 40),
  file("app/web/page.tsx", 200, 20),
  file("app/models.py", 100, 10),
];

describe("follow-up rounds: the delta scope", () => {
  it(
    "a later round with a reviewed head and a computable delta is a follow-up round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(10);
      reviewed(10);
      adapter.files.set(10, PR_FILES);
      const dfiles = [deltaFile("app/api/views.py")];
      const { d, orders } = deps({ delta: okDelta(dfiles) });

      await dispatchOnce(d);

      expect(orders).toHaveLength(1);
      const o = orders[0]!;
      expect(deltaCalls).toEqual([{ pr: 10, from: OLD, to: NEW, mergeBase: MB, baseSha: BASE }]);
      expect(o.round_type).toBe("re-review");
      expect(o.scope).toBe("delta");
      expect(o.delta).toMatchObject({
        from_sha: OLD,
        tree: TREE,
        lines: 4,
        files: [{ path: "app/api/views.py", status: "modified", ranges: [[5, 3]] }],
      });
      // The patch file is written and named in the order.
      expect(o.delta!.patch_file).toMatch(/state\/pr-10-round-2-delta\.patch$/);
      expect(existsSync(o.delta!.patch_file)).toBe(true);
      expect(readFileSync(o.delta!.patch_file, "utf8")).toContain(
        "diff --git a/app/api/views.py b/app/api/views.py",
      );
      expect(o.prior_findings_note).toBeTruthy();
      // The plan: built over the delta, intent off, tier from the WHOLE PR.
      const deltaPrFiles: PrFileEntry[] = [
        {
          filename: "app/api/views.py",
          additions: 3,
          deletions: 1,
          status: "modified",
          patch: dfiles[0]!.patch,
        },
      ];
      const expected = buildPassPlan(
        baseCfg,
        deltaPrFiles,
        undefined,
        DJANGO_ECOSYSTEM,
        undefined,
        [],
        [],
        { tierFiles: PR_FILES },
      );
      // A 4-line delta is small: the lean plan of that build.
      expect(o.pass_plan).toEqual(leanFollowUpPlan(expected).pass_plan);
      expect(o.pass_plan.some((p) => p.lens === "pass-baseline")).toBe(true);
      // A 4-line delta would plan its default-tier rows at terra-med on its
      // own; the PR's size keeps them at sol-med.
      const alone = buildPassPlan(baseCfg, deltaPrFiles, undefined);
      const defaultTier = (plan: typeof o.pass_plan) =>
        plan.filter(
          (p) => p.raisable_to.length > 0 && !["pass-sweep", "pass-intent"].includes(p.lens),
        );
      expect(defaultTier(alone.pass_plan).length).toBeGreaterThan(0);
      expect(new Set(defaultTier(alone.pass_plan).map((p) => p.tier))).toEqual(
        new Set(["terra-med"]),
      );
      expect(new Set(defaultTier(o.pass_plan).map((p) => p.tier))).toEqual(new Set(["sol-med"]));
      // The round row records the same plan and the follow-up columns.
      const r = lastRound(10);
      expect(JSON.parse(r.pass_plan!)).toEqual(o.pass_plan);
      expect(r).toMatchObject({
        head_sha: NEW,
        scope: "delta",
        delta_base_sha: OLD,
        delta_lines: 4,
        delta_files: 1,
      });
      // Pinned: the head this round reviews is the next one's baseline.
      expect(pinned).toEqual([[10, NEW]]);
      expect(events(10, "followup_full_round")).toEqual([]);
      expect(events(10, "round_dispatched")[0]).toMatchObject({ scope: "delta", delta_lines: 4 });
    },
  );

  it(
    "an empty delta still runs — pass-baseline verifies the prior findings",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(11);
      reviewed(11);
      adapter.files.set(11, PR_FILES);
      const { d, orders } = deps({ delta: okDelta([]) });
      await dispatchOnce(d);
      expect(orders[0]!.scope).toBe("delta");
      expect(orders[0]!.delta!.files).toEqual([]);
      expect(orders[0]!.pass_plan.map((p) => p.lens)).toContain("pass-baseline");
    },
  );

  it(
    "the migration gate, the diffstat and the coverage check keep their own scopes",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(12);
      reviewed(12);
      const files = [...PR_FILES, file("app/core/migrations/0042_add_field.py", 20)];
      adapter.files.set(12, files);
      const { d, orders } = deps({ delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      const o = orders[0]!;
      expect(o.scope).toBe("delta");
      // The delta touches no migration; the PR does — the gate reads the PR.
      expect(o.migration_gate).toBe(true);
      // …and the lens the gate note names rides the delta plan (a
      // degraded pre-check un-muzzles pass-data-safety, never goes quiet),
      // before the validator.
      const lensesInOrder = o.pass_plan.map((p) => p.lens);
      expect(lensesInOrder).toContain("pass-data-safety");
      expect(o.addable_lenses).not.toContain("pass-data-safety");
      const vi = lensesInOrder.indexOf("pass-validate");
      if (vi >= 0) expect(lensesInOrder.indexOf("pass-data-safety")).toBeLessThan(vi);
      // The carried row takes its launch-order place (`slowestFirst`):
      // a sol-high risk pass right after the baseline, not spliced in last.
      expect(lensesInOrder.slice(0, 2)).toEqual(["pass-baseline", "pass-data-safety"]);
      // The diffstat on the round row is the WHOLE PR's.
      expect(lastRound(12)).toMatchObject({ additions: 620, deletions: 70, changed_files: 4 });
      // The coverage check holds the round to the delta's files only.
      for (const c of o.coverage_files ?? []) expect(c.path).toBe("app/api/views.py");
    },
  );
});

describe("follow-up rounds: every doubt is a full round", () => {
  async function fullRoundReason(
    pr: number,
    setup: () => { d: DispatchDeps; orders: RoundOrder[] },
  ): Promise<{ reason: unknown; order: RoundOrder }> {
    queue(pr);
    adapter.files.set(pr, PR_FILES);
    const { d, orders } = setup();
    await dispatchOnce(d);
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    // Today's full re-review: no follow-up fields, the full plan.
    expect(order.scope).toBeUndefined();
    expect(order.delta).toBeUndefined();
    expect(order.prior_findings_note).toBeUndefined();
    expect(order.sweep_plan).toBeUndefined();
    expect(order.pass_plan).toEqual(
      buildPassPlan(baseCfg, PR_FILES, { title: `PR ${pr}`, body: "" }).pass_plan,
    );
    expect(lastRound(pr).scope).toBe("full");
    const ev = events(pr, "followup_full_round");
    expect(ev).toHaveLength(1);
    return { reason: ev[0]!.reason, order };
  }

  it("[review] follow_up = full", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    reviewed(20);
    const cfg: Config = { ...baseCfg, review: { ...baseCfg.review, follow_up: "full" } };
    const { reason } = await fullRoundReason(20, () => deps({ cfg, delta: okDelta([]) }));
    expect(reason).toBe("follow_up_full");
    expect(deltaCalls).toEqual([]);
  });

  it("no reviewed-head mark", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    reviewed(21, "REQUEST_CHANGES", false);
    const { reason } = await fullRoundReason(21, () => deps({ delta: okDelta([]) }));
    expect(reason).toBe("no-reviewed-head");
  });

  it("no git seam (stub wiring)", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    reviewed(22);
    const { reason } = await fullRoundReason(22, () => deps());
    expect(reason).toBe("no-adapter");
  });

  it("no prepared tree", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    reviewed(23);
    const { reason } = await fullRoundReason(23, () => {
      const r = deps({ delta: okDelta([]) });
      delete r.d.prepareWorktree;
      return r;
    });
    expect(reason).toBe("no-adapter");
  });

  for (const why of [
    "old-head-missing",
    "base-rewound",
    "merge-tree-failed",
    "diff-failed",
  ] as const)
    it(`the delta reader answers ${why}`, { timeout: HEAVY_TIMEOUT_MS }, async () => {
      reviewed(24);
      const { reason } = await fullRoundReason(24, () =>
        deps({ delta: { ok: false, reason: why } }),
      );
      expect(reason).toBe(why);
    });

  it("the delta reader throws", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    reviewed(25);
    const { reason } = await fullRoundReason(25, () =>
      deps({
        delta: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(reason).toBe("delta-threw");
  });

  it(
    "a delta above follow_up_max_delta_ratio of the PR's diff lines",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      reviewed(26);
      // PR = 670 lines; ratio 0.6 → 402 allowed.
      const big = deltaFile("app/api/views.py", 400, 10);
      const { reason } = await fullRoundReason(26, () => deps({ delta: okDelta([big]) }));
      expect(reason).toBe("delta-too-large");
      expect(events(26, "followup_full_round")[0]).toMatchObject({
        delta_lines: 410,
        pr_lines: 670,
      });
    },
  );

  it("a profile that switched pass-baseline off", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    reviewed(27);
    const cfg: Config = {
      ...baseCfg,
      lenses: { ...(baseCfg.lenses ?? {}), "pass-baseline": { enabled: false } },
    } as Config;
    queue(27);
    adapter.files.set(27, PR_FILES);
    const { d, orders } = deps({ cfg, delta: okDelta([deltaFile("app/api/views.py")]) });
    await dispatchOnce(d);
    expect(orders[0]!.scope).toBeUndefined();
    expect(events(27, "followup_full_round")[0]).toMatchObject({ reason: "baseline-unplanned" });
  });
});

describe("follow-up rounds: the pre-approval sweep", () => {
  it(
    "is owed while the PR is not approved and no full look happened since round 1",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(30);
      reviewed(30, "REQUEST_CHANGES");
      adapter.files.set(30, PR_FILES);
      const { d, orders } = deps({ delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      const o = orders[0]!;
      // The sweep's plan is the whole PR's full plan, exactly as a full round's.
      expect(o.sweep_plan).toEqual(
        buildPassPlan(baseCfg, PR_FILES, { title: "PR 30", body: "" }).pass_plan,
      );
      const r = lastRound(30);
      expect(r.sweep_owed).toBe(1);
      expect(JSON.parse(r.sweep_plan!)).toEqual(o.sweep_plan);
      expect(r.sweep_status).toBeNull();
      // Never part of the round's own plan.
      expect(JSON.parse(r.pass_plan!)).toEqual(o.pass_plan);
      if (baseCfg.review.task_files) {
        expect(o.sweep_task_files?.length).toBeGreaterThan(0);
        for (const t of o.sweep_task_files!) {
          expect(t.path).toContain("/tasks-sweep/");
          expect(o.sweep_plan![t.row]!.agent).toBe(t.agent);
        }
      }
      // No findings record for round 1 here: the prior list is incomplete,
      // so the sweep starts late — unknown is never early.
      expect(o.sweep_start).toBe("late");
      expect(events(30, "round_dispatched")[0]).toMatchObject({
        sweep_owed: true,
        sweep_start: "late",
      });
    },
  );

  it(
    "is not owed after an approval for a push under the size floor",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(31);
      reviewed(31, "APPROVE");
      adapter.files.set(31, PR_FILES);
      const { d, orders } = deps({ delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      expect(orders[0]!.scope).toBe("delta");
      expect(orders[0]!.sweep_plan).toBeUndefined();
      expect(orders[0]!.sweep_task_files).toBeUndefined();
      expect(lastRound(31)).toMatchObject({ sweep_owed: 0, sweep_status: "not_owed" });
    },
  );

  it(
    "is owed after an approval when the push reaches the size floor, even after a full look",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(34);
      reviewed(34, "APPROVE");
      const id = store.startRound(34, "re-review", ["pass-baseline"], 60, { scope: "full" });
      store.finishRound(id, "APPROVE", null);
      adapter.files.set(34, PR_FILES);
      // deltaFile is 3 + 1 = 4 lines.
      const cfg: Config = {
        ...baseCfg,
        review: { ...baseCfg.review, follow_up_post_approval_sweep_lines: 4 },
      };
      const { d, orders } = deps({ cfg, delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      expect(orders[0]!.scope).toBe("delta");
      expect(orders[0]!.sweep_plan?.length).toBeGreaterThan(0);
      expect(lastRound(34).sweep_owed).toBe(1);
    },
  );

  it(
    "is not owed after a full look since the first round",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(32);
      reviewed(32, "REQUEST_CHANGES");
      // A delivered full-scope later round.
      const id = store.startRound(32, "re-review", ["pass-baseline"], 60, { scope: "full" });
      store.finishRound(id, "REQUEST_CHANGES", null);
      adapter.files.set(32, PR_FILES);
      const { d, orders } = deps({ delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      expect(orders[0]!.scope).toBe("delta");
      expect(orders[0]!.sweep_plan).toBeUndefined();
    },
  );

  it("[review] follow_up_sweep = false never plans it", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    queue(33);
    reviewed(33, "REQUEST_CHANGES");
    adapter.files.set(33, PR_FILES);
    const cfg: Config = { ...baseCfg, review: { ...baseCfg.review, follow_up_sweep: false } };
    const { d, orders } = deps({ cfg, delta: okDelta([deltaFile("app/api/views.py")]) });
    await dispatchOnce(d);
    expect(orders[0]!.scope).toBe("delta");
    expect(orders[0]!.sweep_plan).toBeUndefined();
  });
});

describe("follow-up rounds: the first round is untouched", () => {
  it(
    "never consults the delta seam and carries no follow-up field",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(40);
      adapter.files.set(40, PR_FILES);
      const { d, orders } = deps({ delta: okDelta([]) });
      await dispatchOnce(d);
      const o = orders[0]!;
      expect(o.round_type).toBe("first");
      expect(deltaCalls).toEqual([]);
      for (const k of ["scope", "delta", "prior_findings_note", "sweep_plan", "sweep_task_files"])
        expect(k in o).toBe(false);
      expect(o.pass_plan).toEqual(
        buildPassPlan(baseCfg, PR_FILES, { title: "PR 40", body: "" }).pass_plan,
      );
      const r = lastRound(40);
      expect(r).toMatchObject({ head_sha: NEW, scope: null, sweep_owed: null, sweep_plan: null });
      expect(events(40, "followup_full_round")).toEqual([]);
      expect("scope" in events(40, "round_dispatched")[0]!).toBe(false);
    },
  );
});

describe("the lean follow-up plan (small deltas)", () => {
  const BIG = [file("app/api/views.py", 300, 40), file("app/web/page.tsx", 200, 20)];
  it("drops the per-file sweep rows and moves the quality and style lenses to addable", () => {
    const full = buildPassPlan(baseCfg, BIG, undefined, DJANGO_ECOSYSTEM, undefined, ["STYLE.md"]);
    expect(full.pass_plan.some((p) => p.lens === "pass-sweep")).toBe(true);
    const moved = full.pass_plan.map((p) => p.lens).filter((l) => LEAN_ADDABLE_PASSES.includes(l));
    expect(moved.length).toBeGreaterThan(0);
    const lean = leanFollowUpPlan(full);
    expect(lean.pass_plan.some((p) => p.lens === "pass-sweep")).toBe(false);
    for (const l of moved) {
      expect(lean.pass_plan.some((p) => p.lens === l)).toBe(false);
      expect(lean.addable_lenses).toContain(l);
    }
    // Everything else stays planned, in order, the validator last.
    expect(lean.pass_plan).toEqual(
      full.pass_plan.filter(
        (p) => p.lens !== "pass-sweep" && !LEAN_ADDABLE_PASSES.includes(p.lens),
      ),
    );
    expect(lean.pass_plan.at(-1)!.lens).toBe("pass-validate");
    expect(lean.sweep_unswept).toEqual([]);
    // No lens left the round: planned ∪ addable covers the full plan's lenses.
    for (const l of new Set(full.pass_plan.map((p) => p.lens)))
      if (l !== "pass-sweep")
        expect(lean.pass_plan.some((p) => p.lens === l) || lean.addable_lenses.includes(l)).toBe(
          true,
        );
  });

  it(
    "applies at or under follow_up_small_delta_lines; above it, or at 0, the delta's plan is untouched",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const at = (n: number): Config => ({
        ...baseCfg,
        review: { ...baseCfg.review, follow_up_small_delta_lines: n },
      });
      const big = deltaFile("app/api/views.py", 60, 20); // 80 lines
      const run = async (pr: number, cfg: Config) => {
        queue(pr);
        reviewed(pr, "REQUEST_CHANGES");
        adapter.files.set(pr, PR_FILES);
        const { d, orders } = deps({ cfg, delta: okDelta([big]) });
        await dispatchOnce(d);
        return orders[0]!;
      };
      const lean = await run(80, at(80));
      expect(lean.pass_plan.some((p) => p.lens === "pass-sweep")).toBe(false);
      const full = await run(81, at(79));
      const off = await run(82, at(0));
      expect(off.pass_plan).toEqual(full.pass_plan);
      expect(
        leanFollowUpPlan({ pass_plan: full.pass_plan, addable_lenses: [], sweep_unswept: [] })
          .pass_plan,
      ).toEqual(lean.pass_plan);
    },
  );
});

describe("sweepStartOf — when an owed sweep starts", () => {
  const f = (path: string | null, blocking: boolean) => ({ path, blocking }) as PriorFinding;
  const list = (findings: PriorFinding[], incomplete: unknown[] = []) =>
    ({ findings, incomplete }) as unknown as PriorFindingsList;
  it("early when every open prior blocker sits in a touched file (non-blockers never hold it back)", () => {
    expect(sweepStartOf(list([]), [])).toBe("early");
    expect(sweepStartOf(list([f("a.py", true), f("z.py", false), f(null, false)]), ["a.py"])).toBe(
      "early",
    );
  });
  it("late when a blocker's file was not touched, a blocker has no path, or the list is unknown or incomplete", () => {
    expect(sweepStartOf(list([f("a.py", true), f("b.py", true)]), ["a.py"])).toBe("late");
    expect(sweepStartOf(list([f(null, true)]), ["a.py"])).toBe("late");
    expect(sweepStartOf(null, ["a.py"])).toBe("late");
    expect(sweepStartOf(list([], [{ round_no: 2 }]), ["a.py"])).toBe("late");
  });
});

describe("followUpSweepOwed", () => {
  const cfgAt = (n: number): Config => ({
    ...baseCfg,
    review: { ...baseCfg.review, follow_up_post_approval_sweep_lines: n },
  });
  const ask = (cfg: Config, a: Partial<Parameters<typeof followUpSweepOwed>[1]>) =>
    followUpSweepOwed(cfg, {
      standing: "APPROVE",
      approvalWithheld: false,
      fullLookSinceFirst: () => false,
      deltaLines: 0,
      ...a,
    });
  it("after a posted approval: owed exactly from the floor, never at 0, whatever the full looks", () => {
    expect(baseCfg.review.follow_up_post_approval_sweep_lines).toBe(500);
    expect(ask(baseCfg, { deltaLines: 499 })).toBe(false);
    expect(ask(baseCfg, { deltaLines: 500 })).toBe(true);
    expect(ask(baseCfg, { deltaLines: 500, fullLookSinceFirst: () => true })).toBe(true);
    expect(ask(cfgAt(0), { deltaLines: 100_000 })).toBe(false);
  });
  it("before an approval (a withheld one included): owed until a full look, whatever the size", () => {
    for (const a of [
      { standing: "REQUEST_CHANGES" },
      { standing: null },
      { approvalWithheld: true },
    ]) {
      expect(ask(baseCfg, { ...a, deltaLines: 1 })).toBe(true);
      expect(ask(cfgAt(0), { ...a, deltaLines: 1 })).toBe(true);
      expect(ask(baseCfg, { ...a, deltaLines: 10_000, fullLookSinceFirst: () => true })).toBe(
        false,
      );
    }
  });
});

describe("decideFollowUp + StateStore.fullLookSinceFirst", () => {
  it("a legacy re-review (scope NULL) and a ran sweep count as full looks; a first round and a staleness round do not", () => {
    const pr = 50;
    const first = store.startRound(pr, "first", ["pass-baseline"], 60);
    store.finishRound(first, "REQUEST_CHANGES", null);
    expect(store.fullLookSinceFirst(pr)).toBe(false);
    const stale = store.startRound(pr, "staleness", ["pass-baseline"], 60);
    store.finishRound(stale, "REQUEST_CHANGES", null);
    expect(store.fullLookSinceFirst(pr)).toBe(false);
    const delta = store.startRound(pr, "re-review", ["pass-baseline"], 60, { scope: "delta" });
    store.finishRound(delta, "REQUEST_CHANGES", null);
    expect(store.fullLookSinceFirst(pr)).toBe(false);
    store.setRoundMeta(delta, { sweep_status: "ran" });
    expect(store.fullLookSinceFirst(pr)).toBe(true);

    const legacy = 51;
    store.finishRound(store.startRound(legacy, "first", [], 60), "APPROVE", null);
    // An undelivered legacy re-review is no look at all.
    store.startRound(legacy, "re-review", [], 60);
    expect(store.fullLookSinceFirst(legacy)).toBe(false);
    store.finishRound(store.startRound(legacy, "re-review", [], 60), "APPROVE", null);
    expect(store.fullLookSinceFirst(legacy)).toBe(true);
  });

  it("renderDeltaPatch writes git-style headers for added, removed and binary files", () => {
    const patch = renderDeltaPatch([
      { ...deltaFile("a.py"), status: "added" },
      { ...deltaFile("b.py"), status: "removed", whole_file: true },
      { ...deltaFile("c.png"), binary: true, patch: "" },
    ]);
    expect(patch).toContain("--- /dev/null\n+++ b/a.py");
    expect(patch).toContain("--- a/b.py\n+++ /dev/null");
    expect(patch).toContain("Binary files a/c.png and b/c.png differ");
    expect(renderDeltaPatch([])).toBe("");
  });

  it(
    "decideFollowUp is total: a ratio over an empty PR still decides",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const fullPlan = buildPassPlan(baseCfg, []);
      const r = await decideFollowUp(
        { cfg: baseCfg, store, prOwnedDelta: async () => okDelta([]) },
        {
          pr: 60,
          markHead: OLD,
          tree: { head_sha: NEW, base_sha: BASE, merge_base: MB },
          files: [],
          fullPlan,
          standing: "REQUEST_CHANGES",
          ecosystem: DJANGO_ECOSYSTEM,
          styleGuide: [],
          ciLinters: [],
        },
      );
      expect(r.kind).toBe("delta");
    },
  );
});

describe("follow-up rounds: review fixes", () => {
  it(
    "a withheld approval is not an approval: the sweep stays owed",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(70);
      reviewed(70, "APPROVE");
      store.recordApprovalWithheld(70, { head_sha: OLD, reason: "red-ci", ci_state: "failure" });
      adapter.files.set(70, PR_FILES);
      const { d, orders } = deps({ delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      expect(orders[0]!.scope).toBe("delta");
      expect(orders[0]!.sweep_plan?.length).toBeGreaterThan(0);
      expect(lastRound(70).sweep_owed).toBe(1);
    },
  );

  it(
    "the reviewed head's recorded merge base is handed to the delta reader",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const OLD_MB = "fff6666666666666666666666666666666666666";
      queue(71);
      const id = store.startRound(71, "first", ["pass-baseline"], 60, {
        head_sha: OLD,
        merge_base: OLD_MB,
      });
      store.finishRound(id, "REQUEST_CHANGES", null);
      store.recordReviewedHead(71, { head_sha: OLD, verdict: "REQUEST_CHANGES", round_no: 1 });
      adapter.files.set(71, PR_FILES);
      const { d } = deps({ delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      expect(deltaCalls[0]).toMatchObject({ from: OLD, mergeBase: MB, fromMergeBase: OLD_MB });
      // This round records its own merge base for the next one.
      expect(lastRound(71).merge_base).toBe(MB);
    },
  );

  it(
    "a staleness round is never a follow-up round and never stamped a scope",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      queue(72);
      store.upsertPr({ ...store.getPr(72)!, stale_recheck: 1 });
      reviewed(72);
      adapter.files.set(72, PR_FILES);
      const { d, orders } = deps({ delta: okDelta([deltaFile("app/api/views.py")]) });
      await dispatchOnce(d);
      expect(orders[0]!.round_type).toBe("staleness");
      expect(orders[0]!.scope).toBeUndefined();
      expect(deltaCalls).toEqual([]);
      expect(lastRound(72).scope).toBeNull();
      expect(events(72, "followup_full_round")).toEqual([]);
    },
  );

  it("a staleness round stamped full is still no full look", () => {
    const pr = 73;
    store.finishRound(store.startRound(pr, "first", [], 60), "REQUEST_CHANGES", null);
    const stale = store.startRound(pr, "staleness", [], 60, { scope: "full" });
    store.finishRound(stale, "REQUEST_CHANGES", null);
    expect(store.fullLookSinceFirst(pr)).toBe(false);
  });

  it(
    "an empty full plan owes no sweep; the sweep carries the full plan's unswept files",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const args = {
        pr: 74,
        markHead: OLD,
        tree: { head_sha: NEW, base_sha: BASE, merge_base: MB },
        files: PR_FILES,
        standing: "REQUEST_CHANGES",
        ecosystem: DJANGO_ECOSYSTEM,
        styleGuide: [] as string[],
        ciLinters: [],
      };
      const seam = { cfg: baseCfg, store, prOwnedDelta: async () => okDelta([]) };
      const empty = await decideFollowUp(seam, {
        ...args,
        fullPlan: { pass_plan: [], addable_lenses: [], sweep_unswept: [] },
      });
      expect(empty.kind === "delta" && empty.decision.sweepPlan).toBeFalsy();
      const full = buildPassPlan(baseCfg, PR_FILES);
      const carried = await decideFollowUp(seam, {
        ...args,
        fullPlan: { ...full, sweep_unswept: ["app/far/away.py"] },
      });
      expect(carried.kind).toBe("delta");
      if (carried.kind === "delta") {
        expect(carried.decision.sweepPlan).toEqual(full.pass_plan);
        expect(carried.decision.sweepUnswept).toEqual(["app/far/away.py"]);
      }
    },
  );
});
