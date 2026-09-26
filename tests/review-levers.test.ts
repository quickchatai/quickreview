// The benchmark-driven review levers (bench/aacr/RESULTS.md, 2026-09-26):
// one reasoning-effort setting, per-run bench config levers, the
// content-triggered sub-lenses, the per-file sweep, their place in the pass
// plan and its rendering, and the validator's restate-don't-kill rule.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { applyReviewEffort, parseConfig, withThinking, type Config } from "../src/config.js";
import { applyConfigOverrides } from "../src/bench/runner.js";
import { ALL_PASSES, buildPassPlan, buildRoundOrder } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import {
  selectSubLenses,
  SUBLENS_PASSES,
  SWEEP_MAX_FILES_PER_GROUP,
  SWEEP_PASS,
  sweepGroups,
  type PrFile,
} from "../src/heuristics.js";
import { addendaForPass, composeAddendum, splitModelSpec, VALIDATE_PASS } from "../src/include.js";
import { DOWNGRADE_WORDS } from "../src/findingsrecord.js";
import { renderPassPlan, renderRoundPrompt, roundTemplateFile } from "../src/templates.js";
import type { PrStateRow } from "../src/state.js";

const fixture = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
const baseCfg: Config = parseConfig(fixture);

function withLevers(over: Partial<Config["review"]>): Config {
  const cfg = structuredClone(baseCfg);
  cfg.review = { ...cfg.review, ...over };
  return cfg;
}

const file = (
  filename: string,
  added: string[],
  extra: Partial<PrFileEntry> = {},
): PrFileEntry => ({
  filename,
  additions: added.length,
  deletions: 0,
  status: "modified",
  patch: ["@@ -1,1 +1,2 @@", ...added.map((l) => `+${l}`)].join("\n"),
  ...extra,
});

// ---- [models] effort ---------------------------------------------------------

describe("[models] effort — one reasoning level for every model", () => {
  it("replaces or adds the thinking suffix, knowing xhigh and max", () => {
    expect(withThinking("openai-codex/gpt-6-sol:medium", "low")).toBe("openai-codex/gpt-6-sol:low");
    expect(withThinking("openai-codex/gpt-6-sol", "high")).toBe("openai-codex/gpt-6-sol:high");
    expect(withThinking("openai-codex/gpt-6-sol:max", "medium")).toBe(
      "openai-codex/gpt-6-sol:medium",
    );
    expect(splitModelSpec("openai-codex/gpt-6-sol:xhigh")).toEqual({
      model: "openai-codex/gpt-6-sol",
      thinking: "xhigh",
    });
    expect(splitModelSpec("openai-codex/gpt-6-sol:max").thinking).toBe("max");
  });

  it('"" leaves every spec as written (the shipped default)', () => {
    expect(baseCfg.models.effort).toBe("");
    expect(applyReviewEffort(baseCfg.models)).toBe(baseCfg.models);
  });

  it.each([
    ["low", "low"],
    ["medium", "medium"],
    ["med", "medium"],
    ["high", "max"],
  ])("effort = %s sets :%s on default, conversation, overseer and every tier", (effort, level) => {
    const cfg = parseConfig(fixture.replace("[models]\n", `[models]\neffort = "${effort}"\n`));
    const specs = [
      cfg.models.default,
      cfg.models.conversation,
      cfg.models.overseer,
      ...Object.values(cfg.models.tiers),
    ];
    for (const spec of specs) expect(spec.endsWith(`:${level}`)).toBe(true);
  });

  it("high means effort_max — a model's own ceiling when it tops out lower", () => {
    const cfg = parseConfig(
      fixture.replace("[models]\n", `[models]\neffort = "high"\neffort_max = "xhigh"\n`),
    );
    expect(cfg.models.tiers["sol-high"].endsWith(":xhigh")).toBe(true);
  });

  it("refuses an unknown effort or ceiling rather than measuring nothing", () => {
    expect(() =>
      parseConfig(fixture.replace("[models]\n", `[models]\neffort = "extreme"\n`)),
    ).toThrow(/effort/);
    expect(() =>
      parseConfig(fixture.replace("[models]\n", `[models]\neffort_max = "off"\n`)),
    ).toThrow(/effort_max/);
  });
});

// ---- bench --config ------------------------------------------------------------

describe("bench --config: one run's levers on the shipped config", () => {
  it("sets typed keys and re-applies models.effort", () => {
    const cfg = applyConfigOverrides(
      baseCfg,
      "review.sweep=true,review.sweep_max_groups=2,models.effort=high",
    );
    expect(cfg.review.sweep).toBe(true);
    expect(cfg.review.sweep_max_groups).toBe(2);
    expect(cfg.models.conversation.endsWith(":max")).toBe(true);
    // the input config is untouched
    expect(baseCfg.review.sweep).toBe(false);
  });

  it("fails loudly on a typo, a missing section or a bad boolean", () => {
    expect(() => applyConfigOverrides(baseCfg, "review.sweeep=true")).toThrow(/no key/);
    expect(() => applyConfigOverrides(baseCfg, "nope.x=1")).toThrow(/no section/);
    expect(() => applyConfigOverrides(baseCfg, "review.sweep=yes")).toThrow(/true\|false/);
    expect(() => applyConfigOverrides(baseCfg, "models.effort=extreme")).toThrow(/effort/);
  });

  it("an empty spec is the shipped config", () => {
    expect(applyConfigOverrides(baseCfg, "")).toBe(baseCfg);
  });
});

// ---- the sub-lens triggers -------------------------------------------------------

describe("selectSubLenses — content, not paths", () => {
  const lenses = (files: PrFile[], title = "", body = "") =>
    selectSubLenses(files, { title, body }).map((s) => s.lens);

  it("widened: a predicate or a literal guard changes, or accepted IDs are added", () => {
    expect(
      lenses([file("src/joystick.c", ["bool SDL_IsJoystick8BitDo(Uint16 vid, Uint16 pid)"])]),
    ).toContain("pass-widened");
    expect(lenses([file("src/save.ts", ['if (encoding !== "utf8") {'])])).toContain("pass-widened");
    expect(lenses([file("src/ids.c", ["    0x6000, 0x6001,", "    0x6003,"])])).toContain(
      "pass-widened",
    );
    expect(lenses([file("src/a.ts", ["const total = a + b;"])])).not.toContain("pass-widened");
  });

  it("roundtrip: encoding handling AND a write-back, never either alone", () => {
    expect(
      lenses([
        file("src/extract.ts", ["const enc = jschardet.detect(buf).encoding"]),
        file("src/diff.ts", ["await fs.writeFile(path, iconv.encode(text, enc))"]),
      ]),
    ).toContain("pass-roundtrip");
    expect(lenses([file("src/read.ts", ["const enc = jschardet.detect(buf)"])])).not.toContain(
      "pass-roundtrip",
    );
    // prose is not code: a README about encodings fires nothing
    expect(lenses([file("README.md", ["encoding utf-8", "writeFile everything"])])).not.toContain(
      "pass-roundtrip",
    );
  });

  it("deferred: two distinct queue/defer words in one file's added lines", () => {
    expect(
      lenses([file("player/command.c", ["mp_dispatch_enqueue(q, fn);", "pending_resize = true;"])]),
    ).toContain("pass-deferred");
    expect(lenses([file("a.ts", ["setTimeout(f, 10)"])])).not.toContain("pass-deferred");
  });

  it("bounds: a loop over remote pages, a limited read, an unchecked cast, a host leak", () => {
    expect(
      lenses([file("client/mod.rs", ["loop {", "    let page = client.fetch(offset).await?;"])]),
    ).toContain("pass-bounds");
    expect(
      lenses([file("x.ts", ["const buf = await fs.readFile(p);", "if (buf.length > MAX_SIZE) {"])]),
    ).toContain("pass-bounds");
    expect(lenses([file("agents.ts", ["const data = (await res.json()) as Agent[];"])])).toContain(
      "pass-bounds",
    );
    expect(lenses([file("server.go", ["tag, _ := os.Hostname()"])])).toContain("pass-bounds");
    expect(lenses([file("x.ts", ["for (const a of items) total += a;"])])).not.toContain(
      "pass-bounds",
    );
  });

  it("claims: the PR text makes a checkable claim", () => {
    expect(lenses([], "Silence C4244 in SoDatumLabel")).toContain("pass-claims");
    expect(lenses([], "Add 8BitDo controllers", "Only firmware v2.05+ is supported.")).toContain(
      "pass-claims",
    );
    expect(lenses([], "Refactor the widget", "Moves code around.")).not.toContain("pass-claims");
  });

  it("rollout: the PR text names a staggered release, or persisted state changes", () => {
    expect(lenses([], "Hotfix: cap the received log")).toContain("pass-rollout");
    expect(
      lenses([file("src/store/settings.ts", ["const persistConfig = { version: 3, migrate }"])]),
    ).toContain("pass-rollout");
    expect(lenses([file("a.ts", ["x = 1"])], "Tidy up")).not.toContain("pass-rollout");
  });

  it("ALL_PASSES lists exactly the registry's sub-lenses, plus the sweep", () => {
    expect(ALL_PASSES.filter((p) => SUBLENS_PASSES.includes(p))).toEqual([...SUBLENS_PASSES]);
    expect(ALL_PASSES).toContain(SWEEP_PASS);
  });

  it("every sub-lens is a known, addable pass with an agent file", () => {
    for (const lens of SUBLENS_PASSES) {
      expect(ALL_PASSES).toContain(lens);
      expect(() => readFileSync(resolve(process.cwd(), "agents", `${lens}.md`))).not.toThrow();
    }
  });
});

// ---- the sweep ---------------------------------------------------------------------

describe("sweepGroups", () => {
  const f = (filename: string, additions: number, status = "modified"): PrFile => ({
    filename,
    additions,
    deletions: 0,
    status,
  });

  it("groups diff-order files under both caps and skips lockfiles, prose and deletions", () => {
    const { groups, unswept } = sweepGroups(
      [
        f("a.ts", 10),
        f("package-lock.json", 500),
        f("b.ts", 10),
        f("README.md", 5),
        f("c.ts", 10),
        f("d.ts", 10),
        f("gone.ts", 0, "removed"),
        f("big.ts", 900),
        f("e.ts", 10),
      ],
      6,
    );
    expect(groups).toEqual([["a.ts", "b.ts", "c.ts"], ["d.ts"], ["big.ts"], ["e.ts"]]);
    expect(groups.every((g) => g.length <= SWEEP_MAX_FILES_PER_GROUP)).toBe(true);
    expect(unswept).toEqual([]);
  });

  it("names every file past the group cap instead of dropping it silently", () => {
    const files = Array.from({ length: 10 }, (_, i) => f(`f${i}.ts`, 200));
    const { groups, unswept } = sweepGroups(files, 2);
    expect(groups).toEqual([
      ["f0.ts", "f1.ts"],
      ["f2.ts", "f3.ts"],
    ]);
    expect(unswept).toEqual(["f4.ts", "f5.ts", "f6.ts", "f7.ts", "f8.ts", "f9.ts"]);
  });
});

// ---- the plan ------------------------------------------------------------------------

describe("buildPassPlan with the levers", () => {
  const files = [
    file("src/joystick.c", ["bool SDL_IsJoystick8BitDo(Uint16 pid)"]),
    file("src/hid.c", ["x = 1;"]),
  ];

  it("off (the code default): the plan is exactly the path-shaped one", () => {
    const off = buildPassPlan(baseCfg, files, { title: "Silence C4244" });
    expect(
      off.pass_plan.some((p) => SUBLENS_PASSES.includes(p.lens) || p.lens === SWEEP_PASS),
    ).toBe(false);
    expect(off.sweep_unswept).toEqual([]);
    // off, the sweep is addable: a session may sweep a file it suspects
    expect(off.addable_lenses).toContain(SWEEP_PASS);
  });

  it("on: fired sub-lenses carry their reason, sweep rows their files, the validator stays last", () => {
    const cfg = withLevers({ sublenses: true, sweep: true, sweep_max_groups: 6 });
    const { pass_plan, addable_lenses } = buildPassPlan(cfg, files, { title: "Silence C4244" });
    const widened = pass_plan.find((p) => p.lens === "pass-widened");
    expect(widened?.why).toMatch(/predicate/);
    expect(pass_plan.find((p) => p.lens === "pass-claims")?.why).toMatch(/C4244/);
    const sweeps = pass_plan.filter((p) => p.lens === SWEEP_PASS);
    expect(sweeps).toEqual([
      {
        lens: SWEEP_PASS,
        agent: "pass-sweep--terra-med",
        tier: "terra-med",
        raisable_to: ["pass-sweep--sol-med", "pass-sweep--sol-high"],
        focus: ["src/joystick.c", "src/hid.c"],
      },
    ]);
    expect(pass_plan[pass_plan.length - 1]?.lens).toBe(VALIDATE_PASS);
    // not fired ⇒ addable; fired ⇒ planned, not addable; the sweep is never addable
    expect(addable_lenses).toContain("pass-rollout");
    expect(addable_lenses).not.toContain("pass-widened");
    expect(addable_lenses).not.toContain(SWEEP_PASS);
  });

  it("the order lists each lens once even with several sweep rows", () => {
    const cfg = withLevers({ sweep: true, sweep_max_groups: 6 });
    const many = Array.from({ length: 7 }, (_, i) => file(`src/f${i}.ts`, ["x();"]));
    const row = { number: 7, title: "t", head_sha: "h" } as unknown as PrStateRow;
    const order = buildRoundOrder({
      cfg,
      row,
      files: many,
      roundId: 1,
      roundNo: 1,
      roundType: "first",
      worktree: "wt/pr-7",
      settledDigest: "",
      issuedAt: "2026-09-26T00:00:00Z",
      dependencyNote: "**Third-party sources** …",
    });
    expect(order.pass_plan.filter((p) => p.lens === SWEEP_PASS)).toHaveLength(3);
    expect(order.lenses.filter((l) => l === SWEEP_PASS)).toHaveLength(1);
    expect(order.dependency_note).toBe("**Third-party sources** …");
    const prompt = renderRoundPrompt(
      readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile("first")), "utf8"),
      order,
    );
    expect(prompt).toContain("**Third-party sources** …");
    expect(prompt).toContain("| focus / why |");
    expect(prompt).toContain("files: `src/f0.ts`, `src/f1.ts`, `src/f2.ts`");
    expect(prompt).not.toContain("{{");
  });
});

describe("renderPassPlan", () => {
  it("without focus or reasons the table is exactly the four-column one", () => {
    const text = renderPassPlan([
      { lens: "pass-baseline", agent: "pass-baseline--sol-med", tier: "sol-med", raisable_to: [] },
    ]);
    expect(text).toBe(
      [
        "| lens | subagent to call | tier | may raise to |",
        "| --- | --- | --- | --- |",
        "| pass-baseline | `pass-baseline--sol-med` | sol-med | — (pinned) |",
      ].join("\n"),
    );
  });

  it("names the files past the sweep cap under the table", () => {
    const text = renderPassPlan(
      [
        {
          lens: SWEEP_PASS,
          agent: "pass-sweep--terra-med",
          tier: "terra-med",
          raisable_to: [],
          focus: ["a.ts"],
        },
      ],
      ["b.ts"],
    );
    expect(text).toContain("files: `a.ts`");
    expect(text).toContain("Not swept (over the per-round sweep cap): `b.ts`.");
  });
});

// ---- the validator -------------------------------------------------------------

describe("validator: restate, don't kill", () => {
  it("binds pass-validate only, with its own downgrade word", () => {
    expect(addendaForPass(VALIDATE_PASS).map((a) => a.id)).toContain("validate-restate-not-kill");
    expect(addendaForPass("pass-baseline").map((a) => a.id)).not.toContain(
      "validate-restate-not-kill",
    );
    expect(composeAddendum(VALIDATE_PASS)).toContain("with the downgrade word `restated`");
    expect(DOWNGRADE_WORDS).toContain("restated");
  });
});
