// The plan lists its rows slowest first (dispatch.ts `slowestFirst`).
//
// The session launches a turn's rows in table order and the subagent glue runs
// them under a process-wide cap in that order, so a slow row listed late
// starts in the last wave. The plan therefore orders its rows: pass-baseline;
// then by tier, highest first; within a tier the risk passes, the focused rows
// (behaviour-delta, then sweep) by changed lines covered, larger first, every
// other lens, the cheap conditional lenses; pass-validate last.
//
// What is pinned: the ordering changes only the order. The rows (each
// byte-identical), their tiers and focus, and the addable list are the same
// sets as the unordered plan — the hashes below were taken from it —
// and every consumer that indexes rows (task files, `lenses`) follows the one
// ordered array.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan, buildRoundOrder, slowestFirst } from "../src/dispatch.js";
import { NONE_ECOSYSTEM } from "../src/ecosystem.js";
import type { PrFileEntry } from "../src/github.js";
import { renderPassTaskNote, writePassTasks } from "../src/passtasks.js";
import type { PrStateRow } from "../src/state.js";
import { PASS_TIER_ORDER, type PassPlanEntry } from "../src/types.js";

const sandbox = join(import.meta.dirname, "..");
const fixture: Config = parseConfig(
  readFileSync(resolve(sandbox, "tests/fixtures/config.toml"), "utf8"),
);

function cfgOf(): Config {
  const cfg = structuredClone(fixture);
  cfg.review.sweep = true;
  cfg.review.sweep_group_files = 1;
  cfg.review.behaviour_delta = true;
  return cfg;
}

function file(filename: string, additions: number, deletions: number, patch: string): PrFileEntry {
  return {
    filename,
    status: "modified",
    additions,
    deletions,
    changes: additions + deletions,
    patch,
  } as unknown as PrFileEntry;
}

const GUARD_REMOVED =
  "@@ -1,5 +1,3 @@\n def f(user):\n-    if not user.is_staff:\n-        raise PermissionDenied()\n     return load()\n+    # moved\n";
// Sizes chosen so the planned order (small, large, medium) is not the size
// order: the sweep rows must come out large → medium → small.
const FILES: PrFileEntry[] = [
  file("src/auth/session.py", 20, 4, GUARD_REMOVED),
  file("src/orders/api.py", 400, 30, GUARD_REMOVED),
  file("src/web/App.tsx", 90, 10, "@@ -1 +1,2 @@\n+export const a = 1;\n"),
  file("tests/test_orders.py", 30, 0, "@@ -0,0 +1 @@\n+def test_x(): pass\n"),
];
const INTENT = {
  title: "Orders: route by region",
  body: "This PR routes orders by region so that each region's warehouse receives its own orders, adds a staff guard to the session loader and a small UI constant for the routing banner, with a test for the routing.",
};

const plan = (cfg: Config = cfgOf()) => buildPassPlan(cfg, FILES, INTENT, NONE_ECOSYSTEM);
// `required` (the rows a round may not post without) post-dates the launch
// order and is pinned by tests/required-passes.test.ts; the rows as this
// lever found them are compared without it.
const canon = (rows: readonly PassPlanEntry[]): string[] =>
  rows.map(({ required: _required, ...r }) => JSON.stringify(r)).sort();
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

describe("the plan lists its rows slowest first", () => {
  it("only the order moved: the same rows, tiers, focus and addable list as before the lever", () => {
    const p = plan();
    // Taken from the plan without `slowestFirst` (the rows as a sorted set of
    // their JSON, and the addable list as planned).
    expect(sha(canon(p.pass_plan))).toBe(PRE_LEVER_ROWS);
    expect(sha(p.addable_lenses)).toBe(PRE_LEVER_ADDABLE);
    expect(p.sweep_unswept).toEqual([]);
  });

  it("baseline first, then by tier; risk passes, larger focus first, cheap lenses last; validator last", () => {
    const rows = plan().pass_plan;
    const lenses = rows.map((r) => r.lens);
    expect(lenses[0]).toBe("pass-baseline");
    expect(lenses.at(-1)).toBe("pass-validate");
    // Tiers never rise after the baseline (the validator aside).
    const tiers = rows.slice(1, -1).map((r) => PASS_TIER_ORDER.indexOf(r.tier));
    expect(tiers).toEqual([...tiers].sort((a, b) => b - a));
    // Within the top tier: the risk passes lead.
    const top = rows.slice(1, -1).filter((r) => r.tier === rows[1]!.tier);
    const risk = new Set(fixture.models.risk_passes);
    const firstNonRisk = top.findIndex((r) => !risk.has(r.lens));
    expect(firstNonRisk).toBeGreaterThan(0);
    expect(top.slice(firstNonRisk).some((r) => risk.has(r.lens))).toBe(false);
    // The sweep rows: larger focus first.
    const sweeps = rows.filter((r) => r.lens === "pass-sweep").map((r) => r.focus![0]);
    expect(sweeps.slice(0, 3)).toEqual([
      "src/orders/api.py",
      "src/web/App.tsx",
      "tests/test_orders.py",
    ]);
    // The cheap conditional lenses (here the quality lenses) close their tier.
    const quality = lenses.indexOf("pass-maintainability");
    expect(quality).toBeGreaterThan(lenses.indexOf("pass-tests"));
    for (const l of lenses.slice(quality, -1))
      expect([
        "pass-maintainability",
        "pass-duplication",
        "pass-abstraction",
        "pass-consistency",
      ]).toContain(l);
  });

  it("is a pure permutation and idempotent", () => {
    const rows = plan().pass_plan;
    const risk = new Set(fixture.models.risk_passes);
    expect(slowestFirst(rows, FILES, risk)).toEqual(rows);
    // Reversed input: the same rows, the same frame (rows with equal keys
    // keep their input order, so ties may swap).
    const again = slowestFirst([...rows].reverse(), FILES, risk);
    expect(canon(again)).toEqual(canon(rows));
    expect(again[0]!.lens).toBe("pass-baseline");
    expect(again.at(-1)!.lens).toBe("pass-validate");
    expect(again.filter((r) => r.lens === "pass-sweep")).toEqual(
      rows.filter((r) => r.lens === "pass-sweep"),
    );
  });

  describe("every consumer follows the one ordered array", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "qcr-launch-order-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("the order's lenses, the task files' numbering and the launch note", () => {
      const cfg = cfgOf();
      const order = buildRoundOrder({
        cfg,
        row: { number: 7, title: INTENT.title, head_sha: "abc" } as unknown as PrStateRow,
        files: FILES,
        roundId: 1,
        roundNo: 1,
        roundType: "first",
        worktree: "/wt",
        settledDigest: "",
        issuedAt: "2026-10-09T00:00:00Z",
        ecosystem: NONE_ECOSYSTEM,
        prBody: INTENT.body,
      });
      expect(order.pass_plan).toEqual(plan(cfg).pass_plan);
      expect(order.lenses).toEqual([...new Set(order.pass_plan.map((p) => p.lens))]);
      const tasks = writePassTasks(dir, order, "");
      const discovery = order.pass_plan.filter((p) => p.lens !== "pass-validate");
      expect(tasks.map((t) => t.agent)).toEqual(discovery.map((p) => p.agent));
      expect(tasks.map((t) => t.row)).toEqual(discovery.map((_, i) => i));
      expect(readdirSync(dir).sort()[0]).toBe(
        "01-pass-baseline--" + order.pass_plan[0]!.tier + ".md",
      );
      const note = renderPassTaskNote({
        ...order,
        pass_task_files: tasks.map((t) => ({ row: t.row, agent: t.agent, path: t.path })),
      });
      expect(note).toContain("in the table's order (the daemon");
      expect(note).toContain("lists the slowest first");
    });
  });
});

const PRE_LEVER_ROWS = "3391a17b50ef559dd7074be3463df9e65381e9077fbc83b1c823fe28c9831538";
const PRE_LEVER_ADDABLE = "680ad47a474d04554d20ba13b1238d67a4691d95de56c2b407325201b0f827e1";
