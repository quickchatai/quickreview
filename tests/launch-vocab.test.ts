// Route-gated round templates (P5.8, owner ruling D3). A round order names the
// tools that launch its lenses: `subagent` / `launch_plan` natively (the tmux
// bot), `lens` / `lens_wave` when it was built for an engine route
// (`lens_runtime = "engine"`). Native output is byte-identical to what it was
// before the engine tools existed (tests/golden-prompts.test.ts pins the
// bench's); an engine order never names the old pair, a native one never the
// new; the tmux host cannot render an engine order.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  assertNativeHost,
  assertNativeOrder,
  ENGINE_VOCAB,
  launchVocab,
  lensRuntimeOf,
  NATIVE_VOCAB,
} from "../src/launchvocab.js";
import { renderPassTaskNote } from "../src/passtasks.js";
import {
  renderExtentNote,
  renderPassPlan,
  renderPriorAssignNote,
  renderRoundPrompt,
  renderSweepNote,
  renderValidatorShardNote,
  ROUND_TEMPLATE_FILES,
  FOLLOW_UP_TEMPLATE_FILE,
} from "../src/templates.js";
import type { PassPlanEntry, RoundOrder } from "../src/types.js";
import { FILES, FIXTURE_CONFIG, TARGET, mkRoot, mkTree } from "./helpers/round-rig.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");
const { renderOneShotPrompts } = await import("../src/engine/prompts.js");
const { buildRoundOrder } = await import("../src/dispatch.js");

const read = (file: string): string =>
  readFileSync(resolve(process.cwd(), "prompts", file), "utf8");

const PLAN: PassPlanEntry[] = [
  { lens: "pass-baseline", agent: "pass-baseline--sol-med", tier: "sol-med", raisable_to: [] },
  { lens: "pass-validate", agent: "pass-validate--sol-med", tier: "sol-med", raisable_to: [] },
];
const SWEEP: PassPlanEntry[] = [
  { lens: "pass-sweep", agent: "pass-sweep--sol-med", tier: "sol-med", raisable_to: [] },
];
const files = (dir: string, plan: PassPlanEntry[]) =>
  plan.map((p, row) => ({ row, agent: p.agent, path: `${dir}/0${row + 1}-${p.agent}.md` }));

/** An order that exercises every block that names a launch tool. */
const ORDER: RoundOrder = {
  pr: 7,
  title: "Add a cache",
  round_id: 3,
  round_no: 2,
  review_no: 2,
  round_type: "re-review",
  lenses: PLAN.map((p) => p.lens),
  pass_plan: PLAN,
  addable_lenses: ["pass-ui"],
  migration_gate: false,
  head_sha: "1111111111111111111111111111111111111111",
  base_ref: "main",
  base_sha: "basetip",
  merge_base: "forkpoint",
  worktree: "/sandbox/wt/pr-7",
  settled_digest: "",
  issued_at: "2026-10-19T10:00:00Z",
  validator_shards: 2,
  pass_task_files: files("/s/tasks", PLAN),
  sweep_plan: SWEEP,
  sweep_task_files: files("/s/tasks-sweep", SWEEP),
  follow_up_extent: "session",
  optional_plan: SWEEP,
  optional_task_files: files("/s/tasks-optional", SWEEP),
  prior_assignments: [{ row: 0, priors: [] }],
};
const ENGINE: RoundOrder = { ...ORDER, lens_runtime: "engine" };

const OLD_NAMES = /\bsubagent\b|\blaunch_plan\b/;
// `lens` alone is also a findings-record field, so only the tool spellings count.
const NEW_NAMES = /\blens_wave\b|`lens` (tool|call)|\blens to call\b/;

/** Every rendered launch block of an order, joined. */
function blocks(order: RoundOrder): string {
  return [
    renderPassPlan(order.pass_plan, [], {
      vocab: launchVocab(order),
    }),
    renderPassTaskNote(order),
    renderValidatorShardNote(order),
    renderPriorAssignNote(order),
    renderExtentNote(order),
    renderSweepNote(order),
  ].join("\n");
}

const TEMPLATES = [...Object.values(ROUND_TEMPLATE_FILES), FOLLOW_UP_TEMPLATE_FILE];
const prompt = (file: string, order: RoundOrder): string =>
  renderRoundPrompt(read(file), order, undefined, "Owner");

describe("launchVocab", () => {
  it("is native without the field and for native, engine only for engine", () => {
    expect(launchVocab({})).toBe(NATIVE_VOCAB);
    expect(launchVocab(ORDER)).toBe(NATIVE_VOCAB);
    expect(launchVocab(ENGINE)).toBe(ENGINE_VOCAB);
    expect(NATIVE_VOCAB).toEqual({
      lens: "subagent",
      wave: "launch_plan",
      lensToCall: "subagent to call",
    });
    expect(ENGINE_VOCAB).toEqual({ lens: "lens", wave: "lens_wave", lensToCall: "lens to call" });
  });

  it("a route writes the field only for engine, so a native order has no key", () => {
    expect(lensRuntimeOf({ pi: { lens_runtime: "native" } })).toEqual({});
    expect(
      "lens_runtime" in { ...ORDER, ...lensRuntimeOf({ pi: { lens_runtime: "native" } }) },
    ).toBe(false);
    expect(lensRuntimeOf({ pi: { lens_runtime: "engine" } })).toEqual({ lens_runtime: "engine" });
  });
});

describe("the daemon-rendered launch blocks", () => {
  it("native blocks name the old pair and never the new", () => {
    const text = blocks(ORDER);
    expect(text).toContain("launch_plan({ dirs:");
    expect(text).toContain("subagent to call");
    expect(text).not.toMatch(NEW_NAMES);
  });

  it("engine blocks name the new pair and never the old", () => {
    const text = blocks(ENGINE);
    expect(text).toContain('lens_wave({ dirs: ["/s/tasks"] })');
    expect(text).toContain('lens_wave({ dirs: ["/s/tasks-sweep"], extra:');
    expect(text).toContain("| lens | lens to call | tier | may raise to |");
    expect(text).toContain("| row | lens | task file |");
    expect(text).toContain("ONE `lens` call (`tasks:[…]`)");
    expect(text).toContain("through `lens_wave`'s `extra`");
    expect(text).toContain("to the `lens_wave` call's `dirs`");
    expect(text).not.toMatch(OLD_NAMES);
  });

  it("the engine blocks are the native blocks with only the names swapped", () => {
    const swap = (s: string): string =>
      s
        .replaceAll("launch_plan", "lens_wave")
        .replaceAll("subagent to call", "lens to call")
        .replaceAll("subagent", "lens");
    expect(blocks(ENGINE)).toBe(swap(blocks(ORDER)));
  });

  it("an order with no task files renders no task note on either route", () => {
    expect(renderPassTaskNote({ ...ENGINE, pass_task_files: undefined })).toBe("");
    expect(renderPassTaskNote({ ...ORDER, pass_task_files: undefined })).toBe("");
  });
});

describe("the round templates", () => {
  for (const file of TEMPLATES) {
    const forFile = (o: RoundOrder): RoundOrder =>
      file === FOLLOW_UP_TEMPLATE_FILE
        ? ({
            ...o,
            scope: "delta",
            delta: { from_sha: "a", tree: "b", lines: 1, patch_file: "/p", files: [] },
            prior_findings_note: "PRIOR FINDINGS TO VERIFY",
          } as RoundOrder)
        : o;

    it(`${file}: the engine render names lens and lens_wave, never subagent or launch_plan`, () => {
      const text = prompt(file, forFile(ENGINE));
      expect(text).toMatch(/`lens` tool or `lens_wave`/);
      expect(text).toContain("**`lens_wave`**");
      expect(text).toContain("*lens to call*");
      expect(text).not.toMatch(OLD_NAMES);
    });

    it(`${file}: the native render names subagent and launch_plan, never the new pair`, () => {
      const text = prompt(file, forFile(ORDER));
      expect(text).toMatch(/`subagent` tool or `launch_plan`/);
      expect(text).toContain("*subagent to call*");
      expect(text).not.toMatch(NEW_NAMES);
    });

    it(`${file}: the engine render is the native one with the tool names swapped, nothing else`, () => {
      // The native prompt has no other "subagent" or "launch_plan" than the tools.
      const swap = (s: string): string =>
        s
          .replaceAll("launch_plan", "lens_wave")
          .replaceAll("subagent to call", "lens to call")
          .replaceAll("subagent", "lens");
      expect(prompt(file, forFile(ENGINE))).toBe(swap(prompt(file, forFile(ORDER))));
    });
  }
});

describe("the tmux host is bound to native", () => {
  it("refuses an order written for the engine, and renders a native one", () => {
    expect(() => assertNativeOrder(ENGINE)).toThrow(/tmux host renders native round prompts only/);
    expect(() => assertNativeOrder(ORDER)).not.toThrow();
  });

  it("refuses an engine config at assembly", () => {
    expect(() => assertNativeHost("engine")).toThrow(/not available on the bot/);
    expect(() => assertNativeHost("native")).not.toThrow();
  });
});

describe("the routes that build orders", () => {
  const tmp = mkdtempSync(join(tmpdir(), "launch-vocab-"));
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const root = mkRoot(tmp, "root");
  const tree = mkTree(tmp, "tree");

  const oneShot = (runtime: "native" | "engine") => {
    const cfg = benchConfig("");
    cfg.pi.lens_runtime = runtime;
    return renderOneShotPrompts({
      root,
      cfg,
      ecosystem: ecosystemFor("none"),
      target: TARGET,
      tree,
      caseDir: join(tmp, "out"),
      files: FILES,
      issuedAt: "2026-10-19T00:00:00.000Z",
    });
  };

  it("a one-shot or bench round on lens_runtime = engine is written in the engine's names", () => {
    const p = oneShot("engine");
    expect(p.order).toMatch(/`lens` tool or `lens_wave`/);
    expect(p.order).not.toMatch(OLD_NAMES);
  });

  it("the same round on native is unchanged: no engine names, no order field", () => {
    const p = oneShot("native");
    expect(p.order).toMatch(/`subagent` tool or `launch_plan`/);
    expect(p.order).not.toMatch(NEW_NAMES);
    expect(p.order).toBe(oneShot("native").order);
  });

  it("the daemon's order builder never writes the field, whatever the config says", () => {
    const cfg = benchConfig("");
    cfg.pi.lens_runtime = "engine";
    const built = buildRoundOrder({
      cfg,
      row: {
        number: 7,
        state: "reviewing",
        head_sha: "a".repeat(40),
        title: "t",
        author: "",
      } as never,
      files: FILES,
      roundId: 1,
      roundNo: 1,
      roundType: "first",
      worktree: tree,
      settledDigest: "",
      issuedAt: "2026-10-19T00:00:00.000Z",
    });
    expect("lens_runtime" in built).toBe(false);
    expect(() => assertNativeOrder(built)).not.toThrow();
  });
});
