// The benchmark-driven review levers (bench/aacr/RESULTS.md):
// one reasoning-effort setting, per-run bench config levers, the
// content-triggered sub-lenses, the per-file sweep, their place in the pass
// plan and its rendering, and the validator's restate-don't-kill rule.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyReviewEffort,
  parseConfig,
  REVIEW_PRESETS,
  withThinking,
  type Config,
} from "../src/config.js";
import { applyConfigOverrides, withPresetInToml } from "../src/bench/runner.js";
import { ALL_PASSES, buildPassPlan, buildRoundOrder } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import {
  INTENT_MIN_SUBSTANCE_WORDS,
  PLACEMENT_MIN_NEW_FILE_LINES,
  PLACEMENT_MIN_PROD_FILES,
  selectSubLenses,
  SUBLENS_PASSES,
  SWEEP_MAX_FILES_PER_GROUP,
  SWEEP_WIDE_FILES_PER_GROUP,
  SWEEP_PASS,
  sweepGroups,
  type PrFile,
} from "@quickchatai/pi-quickreview/src/heuristics.js";
import {
  addendaForPass,
  composeAddendum,
  splitModelSpec,
  VALIDATE_PASS,
} from "@quickchatai/pi-quickreview/src/include.js";
import { DOWNGRADE_WORDS } from "@quickchatai/pi-quickreview/src/findingsrecord.js";
import {
  renderPassPlan,
  renderRoundPrompt,
  roundTemplateFile,
} from "@quickchatai/pi-quickreview/src/templates.js";
import type { PrStateRow } from "../src/state.js";

const fixture = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
const baseCfg: Config = parseConfig(fixture);
// The shipped pins (DEFAULT_PASS_TIERS: baseline, sweep and behaviour-delta at
// sol-high) are cleared here: these tests exercise the
// unpinned tier heuristics; the pins themselves are pinned in lens-knobs.test.ts.
baseCfg.models.pass_tiers = {};

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
    const specs = [cfg.models.default, cfg.models.conversation, ...Object.values(cfg.models.tiers)];
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

// ---- [review] preset -----------------------------------------------------------

describe("[review] preset — default / low / max", () => {
  const withPreset = (extra: string) =>
    parseConfig(fixture.replace(/\[review\]\n/, `[review]\n${extra}\n`));

  it("no preset key is the default preset: the lean plan, each tier at its own level", () => {
    expect(baseCfg.review.preset).toBe("default");
    expect(baseCfg.review).toMatchObject(REVIEW_PRESETS.default.levers);
    expect(baseCfg.models.effort).toBe("");
  });

  it("the pure selection defaults ARE the default preset's thresholds", () => {
    expect(INTENT_MIN_SUBSTANCE_WORDS).toBe(REVIEW_PRESETS.default.levers.intent_min_words);
    expect(PLACEMENT_MIN_PROD_FILES).toBe(REVIEW_PRESETS.default.levers.placement_min_code_files);
    expect(PLACEMENT_MIN_NEW_FILE_LINES).toBe(
      REVIEW_PRESETS.default.levers.placement_min_new_file_lines,
    );
  });

  it("low: every model at low reasoning, the lean plan", () => {
    const cfg = withPreset(`preset = "low"`);
    for (const spec of [cfg.models.conversation, ...Object.values(cfg.models.tiers)])
      expect(spec.endsWith(":low")).toBe(true);
    expect(cfg.review).toMatchObject(REVIEW_PRESETS.default.levers);
  });

  it("max: every model at its ceiling, the full lever plan", () => {
    const cfg = withPreset(`preset = "max"`);
    for (const spec of [cfg.models.conversation, ...Object.values(cfg.models.tiers)])
      expect(spec.endsWith(":max")).toBe(true);
    expect(cfg.review).toMatchObject({
      intent_min_words: 20,
      placement_min_code_files: 4,
      placement_min_new_file_lines: 0,
      sweep_group_files: 3,
      sweep_group_lines: 400,
    });
  });

  it("an explicit key beats the preset — review knobs and [models] effort alike", () => {
    const cfg = withPreset(`preset = "max"\nsweep = false`);
    expect(cfg.review.sweep).toBe(false);
    expect(cfg.review.intent_min_words).toBe(20);
    const mixed = parseConfig(
      fixture
        .replace(/\[review\]\n/, `[review]\npreset = "max"\n`)
        .replace("[models]\n", `[models]\neffort = "medium"\n`),
    );
    expect(mixed.models.tiers["sol-high"].endsWith(":medium")).toBe(true);
  });

  it("refuses an unknown preset", () => {
    expect(() => withPreset(`preset = "turbo"`)).toThrow(/preset/);
  });
});

// ---- bench --config ------------------------------------------------------------

describe("bench --config: one run's levers on the shipped config", () => {
  it("sets typed keys and re-applies models.effort", () => {
    const cfg = applyConfigOverrides(
      baseCfg,
      "review.sweep=false,review.sweep_max_groups=2,models.effort=high",
    );
    expect(cfg.review.sweep).toBe(false);
    expect(cfg.review.sweep_max_groups).toBe(2);
    expect(cfg.models.conversation.endsWith(":max")).toBe(true);
    // the input config is untouched
    expect(baseCfg.review.sweep).toBe(true);
  });

  it("review.preset re-parses the config as if it said that preset; other pairs still override", () => {
    const max = applyConfigOverrides(baseCfg, "review.preset=max", fixture);
    expect(max.review.preset).toBe("max");
    expect(max.models.conversation.endsWith(":max")).toBe(true);
    expect(max.models.tiers["terra-med"].endsWith(":max")).toBe(true);
    expect(max.review).toMatchObject(REVIEW_PRESETS.max.levers);
    // exactly what production parses from the same text with that preset
    expect(max).toEqual(parseConfig(withPresetInToml(fixture, "max")));
    const maxNoSweep = applyConfigOverrides(
      baseCfg,
      "review.sweep=false,review.preset=max",
      fixture,
    );
    expect(maxNoSweep.review.sweep).toBe(false);
    expect(maxNoSweep.review.intent_min_words).toBe(20);
    const low = applyConfigOverrides(baseCfg, "review.preset=low", fixture);
    expect(low.models.tiers["sol-high"].endsWith(":low")).toBe(true);
    expect(() => applyConfigOverrides(baseCfg, "review.preset=turbo", fixture)).toThrow(/preset/);
  });

  it("default over a file that runs max goes back to each tier's own level", () => {
    const maxText = withPresetInToml(fixture, "max");
    const def = applyConfigOverrides(parseConfig(maxText), "review.preset=default", maxText);
    expect(def.models.tiers).toEqual(baseCfg.models.tiers);
    expect(def.models.conversation).toBe(baseCfg.models.conversation);
    expect(def.review.preset).toBe("default");
  });

  it("a key the file sets explicitly still beats the bench preset, as in production", () => {
    const text = fixture.replace(/\[review\]\n/, "[review]\ndependency_sources = false\n");
    const max = applyConfigOverrides(parseConfig(text), "review.preset=max", text);
    expect(max.review.dependency_sources).toBe(false);
  });

  it("spaced, repeated or text-less preset pairs never relabel a run without applying it", () => {
    const spaced = applyConfigOverrides(baseCfg, "review.preset = max", fixture);
    expect(spaced.models.tiers["sol-high"].endsWith(":max")).toBe(true);
    expect(() =>
      applyConfigOverrides(baseCfg, "review.preset=max,review.preset=low", fixture),
    ).toThrow(/more than once/);
    expect(() => applyConfigOverrides(baseCfg, "review.preset=max")).toThrow(/config text/);
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
    // record-now-run-later with the drain on the other side (mpv's option callbacks)
    expect(
      lenses([
        file("player/command.c", [
          "    // Coalesce redundant updates and only keep the newest one.",
          "void mp_option_run_callbacks(struct MPContext *mpctx)",
        ]),
      ]),
    ).toContain("pass-deferred");
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

  it("groups files under both caps, source first, and skips lockfiles and deletions (prose rides last)", () => {
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
    // Freeze fixes 2: changed prose is swept when the PR changes code, after
    // every source file, at half weight.
    expect(groups).toEqual([["a.ts", "b.ts", "c.ts", "d.ts"], ["big.ts"], ["e.ts", "README.md"]]);
    expect(groups.every((g) => g.length <= SWEEP_MAX_FILES_PER_GROUP)).toBe(true);
    expect(unswept).toEqual([]);
  });

  it("fills groups source first, tests and fixtures next, prose last; a prose-only PR sweeps no prose", () => {
    const { groups } = sweepGroups(
      [f("docs/guide.md", 10), f("tests/test_a.py", 10), f("src/a.py", 10), f("src/b.py", 10)],
      6,
      2,
      500,
    );
    expect(groups).toEqual([
      ["src/a.py", "src/b.py"],
      ["tests/test_a.py", "docs/guide.md"],
    ]);
    expect(sweepGroups([f("README.md", 20), f("docs/x.rst", 5)], 6).groups).toEqual([]);
  });

  it("group caps are parameters: the first batch's 3 files / 400 lines", () => {
    const five = ["a", "b", "c", "d", "e"].map((n) => f(`${n}.ts`, 10));
    expect(sweepGroups(five, 6, 3, 400).groups).toEqual([
      ["a.ts", "b.ts", "c.ts"],
      ["d.ts", "e.ts"],
    ]);
    expect(sweepGroups(five, 6).groups).toEqual([["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]]);
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

  it("a WIDE change (more files than files x groups) is packed by its line budget, every file swept", () => {
    // Ghost@53b39a0-shaped: 120 small files. The file cap would run out of
    // groups after 30 files and leave 90 unswept.
    const wide = Array.from({ length: 120 }, (_, i) => f(`w${i}.ts`, 4));
    const old = sweepGroups(wide, 6, 5, 500, 0);
    expect(old.groups).toHaveLength(6);
    expect(old.unswept).toHaveLength(90);
    const packed = sweepGroups(wide, 6, 5, 500);
    expect(packed.unswept).toEqual([]);
    expect(packed.groups.map((g) => g.length)).toEqual([40, 40, 40]);
    expect(packed.groups.every((g) => g.length <= SWEEP_WIDE_FILES_PER_GROUP)).toBe(true);
  });

  it("the wide rule leaves a change that fits the file cap exactly as before", () => {
    const thirty = Array.from({ length: 30 }, (_, i) => f(`n${i}.ts`, 4));
    expect(sweepGroups(thirty, 6, 5, 500)).toEqual(sweepGroups(thirty, 6, 5, 500, 0));
    // and the line budget still binds inside a wide change
    const heavy = Array.from({ length: 40 }, (_, i) => f(`h${i}.ts`, 100));
    const g = sweepGroups(heavy, 6, 5, 500).groups;
    expect(g.every((x) => x.length * 100 <= 500)).toBe(true);
  });
});

// ---- the plan ------------------------------------------------------------------------

describe("buildPassPlan with the levers", () => {
  const files = [
    file("src/joystick.c", ["bool SDL_IsJoystick8BitDo(Uint16 pid)"]),
    file("src/hid.c", ["x = 1;"]),
  ];

  it("switched off: the plan is exactly the path-shaped one", () => {
    const off = buildPassPlan(withLevers({ sublenses: false, sweep: false }), files, {
      title: "Silence C4244",
    });
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
    expect(sweeps).toMatchObject([
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
    // More files than one sweep group holds (`sweep_group_files`, 8).
    const many = Array.from({ length: 10 }, (_, i) => file(`src/f${i}.ts`, ["x();"]));
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
    expect(order.pass_plan.filter((p) => p.lens === SWEEP_PASS)).toHaveLength(2);
    expect(order.lenses.filter((l) => l === SWEEP_PASS)).toHaveLength(1);
    expect(order.dependency_note).toBe("**Third-party sources** …");
    const prompt = renderRoundPrompt(
      readFileSync(resolve(process.cwd(), "prompts", roundTemplateFile("first")), "utf8"),
      order,
    );
    expect(prompt).toContain("**Third-party sources** …");
    expect(prompt).toContain("| focus / why |");
    expect(prompt).toContain(
      "files: `src/f0.ts`, `src/f1.ts`, `src/f2.ts`, `src/f3.ts`, `src/f4.ts`",
    );
    expect(prompt).not.toContain("{{");
  });
});

describe("selection tuning — the [review] cost knobs", () => {
  const added = (filename: string, additions: number): PrFileEntry => ({
    filename,
    additions,
    deletions: 0,
    status: "added",
  });
  const body20 = Array.from({ length: 25 }, (_, i) => `word${i}`).join(" ");

  it("the default (lean) plan skips intent on a 25-word body and placement on a 5-line new file", () => {
    const lenses = buildPassPlan(baseCfg, [added("src/new.ts", 5)], { body: body20 }).pass_plan.map(
      (p) => p.lens,
    );
    expect(lenses).not.toContain("pass-placement");
    expect(lenses).not.toContain("pass-intent");
    // a 40-line new file still gets its placement question
    const big = buildPassPlan(baseCfg, [added("src/new.ts", 40)], { body: body20 }).pass_plan;
    expect(big.map((p) => p.lens)).toContain("pass-placement");
  });

  it("the max preset's thresholds bring both lenses back", () => {
    const cfg = withLevers(REVIEW_PRESETS.max.levers);
    const lenses = buildPassPlan(cfg, [added("src/new.ts", 5)], { body: body20 }).pass_plan.map(
      (p) => p.lens,
    );
    expect(lenses).toContain("pass-placement");
    expect(lenses).toContain("pass-intent");
  });

  it("placement_min_code_files moves the cross-cutting threshold", () => {
    const files = ["a", "b", "c", "d", "e"].map((n) => file(`src/${n}.ts`, ["x();"]));
    expect(buildPassPlan(baseCfg, files).pass_plan.map((p) => p.lens)).not.toContain(
      "pass-placement",
    );
    const cfg = withLevers({ placement_min_code_files: 4 });
    expect(buildPassPlan(cfg, files).pass_plan.map((p) => p.lens)).toContain("pass-placement");
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

// ---- the tests lens and the one-region rule ---------------------------------

describe("the tests lens", () => {
  it("is planned on every PR that changes code, and only then", () => {
    const code = buildPassPlan(baseCfg, [file("src/a.ts", ["x();"])]).pass_plan.map((p) => p.lens);
    expect(code).toContain("pass-tests");
    const docs = buildPassPlan(baseCfg, [file("README.md", ["hi"])]).pass_plan.map((p) => p.lens);
    expect(docs).not.toContain("pass-tests");
  });
  it("is a preset lever, on in every preset, and addable when switched off", () => {
    for (const p of ["default", "low", "max"] as const)
      expect(REVIEW_PRESETS[p].levers.tests_lens).toBe(true);
    const off = buildPassPlan(withLevers({ tests_lens: false }), [file("src/a.ts", ["x();"])]);
    expect(off.pass_plan.map((p) => p.lens)).not.toContain("pass-tests");
    expect(off.addable_lenses).toContain("pass-tests");
  });
});

describe("one region, every problem", () => {
  it("binds every finding lens, and the validator keeps same-line different-mechanism findings", () => {
    for (const lens of ["pass-baseline", "pass-sweep", "pass-tests", "pass-widened"])
      expect(addendaForPass(lens).map((a) => a.id)).toContain("every-problem-on-the-lines");
    expect(addendaForPass(VALIDATE_PASS).map((a) => a.id)).toContain(
      "every-problem-on-the-lines-validate",
    );
    expect(addendaForPass(VALIDATE_PASS).map((a) => a.id)).not.toContain(
      "every-problem-on-the-lines",
    );
  });
});
