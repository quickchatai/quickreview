// Review cost levers: the validator's decision-table answer, cheaper sweep
// packing, prior findings assigned by the daemon into the lens task files, and
// two benchmark levers measured before any default moves — a light tier for
// sweep rows that hold no production code and a per-lens model.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, validateLensKnobs, type Config } from "../src/config.js";
import { applyConfigOverrides, runFingerprint } from "../src/bench/runner.js";
import { buildPassPlan, buildRoundOrder } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import {
  isLightSweepFile,
  isSweepSkipped,
  isTranslationFile,
  SWEEP_PASS,
  sweepGroups,
} from "@quickchatai/pi-quickreview/src/heuristics.js";
import {
  addendaForPass,
  configAddenda,
  passTierModels,
  sweepLightVariants,
  VALIDATE_PASS,
} from "@quickchatai/pi-quickreview/src/include.js";
import { renderPassTask, renderPassTaskNote } from "@quickchatai/pi-quickreview/src/passtasks.js";
import type { PriorFinding } from "@quickchatai/pi-quickreview/src/priorfindings.js";
import {
  assignPriorFindings,
  renderPriorTaskSection,
} from "@quickchatai/pi-quickreview/src/priortasks.js";
import {
  renderRoundPrompt,
  renderValidatorOutputNote,
  templateFileForOrder,
} from "@quickchatai/pi-quickreview/src/templates.js";
import type { RoundOrder } from "@quickchatai/pi-quickreview/src/types.js";
import type { PrStateRow } from "../src/state.js";
import type { PassPlanEntry, RoundDelta } from "@quickchatai/pi-quickreview/src/types.js";

const fixture = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
const baseCfg: Config = parseConfig(fixture);

function withReview(over: Partial<Config["review"]>): Config {
  const cfg = structuredClone(baseCfg);
  cfg.review = { ...cfg.review, ...over };
  return cfg;
}

const file = (filename: string, n = 3, extra: Partial<PrFileEntry> = {}): PrFileEntry => ({
  filename,
  additions: n,
  deletions: 0,
  status: "modified",
  patch: ["@@ -1,1 +1,2 @@", ...Array.from({ length: n }, (_, i) => `+x${i}();`)].join("\n"),
  ...extra,
});

const row = { number: 7, title: "t", head_sha: "h" } as unknown as PrStateRow;

/** The order rendered through the template the daemon would pick for it. */
const prompt = (order: RoundOrder): string =>
  renderRoundPrompt(
    readFileSync(resolve(process.cwd(), "prompts", templateFileForOrder(order)), "utf8"),
    order,
  );

// ---- sweep packing -----------------------------------------------------------

describe("A3 — the sweep packs 8 files a row and skips translation catalogs", () => {
  it("defaults to 8 files per group under the same 500-line budget", () => {
    expect(baseCfg.review.sweep_group_files).toBe(8);
    expect(baseCfg.review.sweep_group_lines).toBe(500);
    const files = Array.from({ length: 10 }, (_, i) => file(`src/f${i}.ts`));
    expect(sweepGroups(files, 6, 8).groups.map((g) => g.length)).toEqual([8, 2]);
  });

  it("knows a translation catalog by its directory or its format", () => {
    for (const p of [
      "backend/app/frontend/Config/app/translation/de.json",
      "app/translation/visitor_feedback/per_language_config/config_af_ZA.json",
      "web/src/locales/en/common.json",
      "i18n/fr.yaml",
      "po/messages.pot",
      "lib/l10n/app_en.arb",
    ])
      expect(isTranslationFile(p), p).toBe(true);
    for (const p of ["src/translation/engine.py", "src/locale.ts", "config/settings.json"])
      expect(isTranslationFile(p), p).toBe(false);
  });

  it("never plans a sweep row for a translation catalog; the PR's code still gets its rows", () => {
    const files = [
      file("src/api/handler.py"),
      ...["de", "en", "fr", "pl"].map((l) => file(`frontend/Config/app/translation/${l}.json`, 40)),
    ];
    const { groups, unswept } = sweepGroups(files, 6);
    expect(groups).toEqual([["src/api/handler.py"]]);
    expect(unswept).toEqual([]);
    expect(isSweepSkipped("frontend/Config/app/translation/de.json")).toBe(true);
  });
});

// ---- the light sweep tier ----------------------------------------------------

describe("H2 — `[review] sweep_light_tier` (off by default)", () => {
  it("tests, prose and config/data are light; code and CI workflows are not", () => {
    for (const p of [
      "tests/test_api.py",
      "src/a.test.ts",
      "docs/guide.md",
      "config/app.yaml",
      "pyproject.toml",
    ])
      expect(isLightSweepFile(p), p).toBe(true);
    for (const p of ["src/api.py", "Dockerfile", ".github/workflows/ci.yml", "scripts/run.sh"])
      expect(isLightSweepFile(p), p).toBe(false);
  });

  const files = [
    ...Array.from({ length: 8 }, (_, i) => file(`src/m${i}.py`)),
    ...Array.from({ length: 3 }, (_, i) => file(`tests/test_m${i}.py`)),
  ];

  it("off: every sweep row runs at the sweep's pinned tier, as before", () => {
    const plan = buildPassPlan(baseCfg, files).pass_plan.filter((p) => p.lens === SWEEP_PASS);
    expect(plan.map((p) => p.tier)).toEqual(["sol-high", "sol-high"]);
    expect(sweepLightVariants(baseCfg.review)).toEqual([]);
  });

  it("on: only the row holding no production code drops to the light tier", () => {
    const cfg = withReview({ sweep_light_tier: "sol-med" });
    const plan = buildPassPlan(cfg, files).pass_plan.filter((p) => p.lens === SWEEP_PASS);
    const byTier = Object.fromEntries(plan.map((p) => [p.tier, p.focus]));
    expect(byTier["sol-high"]).toHaveLength(8);
    expect(byTier["sol-med"]).toEqual(["tests/test_m0.py", "tests/test_m1.py", "tests/test_m2.py"]);
    const light = plan.find((p) => p.tier === "sol-med")!;
    expect(light.agent).toBe("pass-sweep--sol-med");
    expect(light.why).toContain("sweep_light_tier");
  });

  it("the light variant escapes the sweep's pin, so it really runs at its own tier", () => {
    const cfg = withReview({ sweep_light_tier: "sol-med" });
    const models = passTierModels(
      cfg.models.pass_tiers,
      cfg.models.tiers,
      {},
      {},
      sweepLightVariants(cfg.review),
    );
    expect(models["pass-sweep--sol-med"]).toBeUndefined(); // the build uses the tier's own spec
    expect(models["pass-sweep--sol-high"]).toBe(cfg.models.tiers["sol-high"]);
    expect(models["pass-sweep--terra-med"]).toBe(cfg.models.tiers["sol-high"]);
  });

  it("a profile floor on the sweep moves the exempt variant to the floored light tier the plan names", () => {
    const cfg = withReview({ sweep_light_tier: "terra-med" });
    cfg.models.pass_tiers = { ...cfg.models.pass_tiers, [SWEEP_PASS]: "sol-high" };
    cfg.lenses = { [SWEEP_PASS]: { min_tier: "sol-med" } };
    const plan = buildPassPlan(cfg, files).pass_plan.filter((p) => p.lens === SWEEP_PASS);
    const light = plan.find((p) => p.why?.includes("sweep_light_tier"))!;
    expect(light.agent).toBe("pass-sweep--sol-med");
    expect(sweepLightVariants(cfg.review, cfg.lenses)).toEqual(["pass-sweep--sol-med"]);
    const models = passTierModels(
      cfg.models.pass_tiers,
      cfg.models.tiers,
      {},
      {},
      sweepLightVariants(cfg.review, cfg.lenses),
      cfg.lenses,
    );
    // the light row's variant runs at its own (floored) tier, not the pin's
    expect(models[light.agent]).toBeUndefined();
    expect(models["pass-sweep--sol-high"]).toBe(cfg.models.tiers["sol-high"]);
  });

  it("refuses a tier that does not exist, and the bench records the lever", () => {
    expect(() =>
      parseConfig(`${fixture}\n`.replace("[review]\n", '[review]\nsweep_light_tier = "cheap"\n')),
    ).toThrow(/sweep_light_tier/);
    const cfg = applyConfigOverrides(structuredClone(baseCfg), "review.sweep_light_tier=sol-med");
    expect(runFingerprint(cfg, "").levers?.sweep_light_tier).toBe("sol-med");
    expect(runFingerprint(baseCfg, "").levers?.sweep_light_tier).toBeUndefined();
  });
});

// ---- a per-lens model --------------------------------------------------------

describe("H6 — `[models.pass_models]` (empty by default)", () => {
  it("moves every variant of the lens onto the model, at the level it would have run at", () => {
    const models = passTierModels(
      baseCfg.models.pass_tiers,
      baseCfg.models.tiers,
      {},
      { "pass-duplication": "openai-codex/gpt-6-luna" },
    );
    expect(models["pass-duplication--sol-med"]).toBe("openai-codex/gpt-6-luna:medium");
    expect(models["pass-duplication--sol-high"]).toBe("openai-codex/gpt-6-luna:high");
    // a spec that names its own level keeps it on every variant
    const own = passTierModels(
      baseCfg.models.pass_tiers,
      baseCfg.models.tiers,
      {},
      {
        "pass-duplication": "openai-codex/gpt-6-luna:high",
      },
    );
    expect(own["pass-duplication--sol-med"]).toBe("openai-codex/gpt-6-luna:high");
    // nothing else moves
    expect(own["pass-baseline--sol-high"]).toBe(baseCfg.models.tiers["sol-high"]);
    expect(own["pass-maintainability--sol-med"]).toBeUndefined();
  });

  it("never the validator, never a risk pass, never an unknown lens or a malformed spec", () => {
    const bad = (pass: string, spec: string) => {
      const cfg = structuredClone(baseCfg);
      cfg.models.pass_models = { [pass]: spec };
      return () => validateLensKnobs(cfg);
    };
    expect(bad(VALIDATE_PASS, "openai-codex/gpt-6-luna")).toThrow(/pass-validate/);
    expect(bad("pass-security", "openai-codex/gpt-6-luna")).toThrow(/risk pass/);
    expect(bad("pass-nope", "openai-codex/gpt-6-luna")).toThrow(/unknown pass/);
    expect(bad("pass-duplication", "luna")).toThrow(/provider\/model/);
    expect(bad("pass-duplication", "openai-codex/gpt-6-luna:high")).not.toThrow();
  });

  it("is reachable from a bench arm and recorded in its fingerprint", () => {
    const cfg = applyConfigOverrides(
      structuredClone(baseCfg),
      "models.pass_models.pass-duplication=openai-codex/gpt-6-luna:high",
    );
    expect(cfg.models.pass_models).toEqual({ "pass-duplication": "openai-codex/gpt-6-luna:high" });
    expect(runFingerprint(cfg, "").pass_models).toEqual({
      "pass-duplication": "openai-codex/gpt-6-luna:high",
    });
    expect(runFingerprint(baseCfg, "").pass_models).toBeUndefined();
  });
});

// ---- the validator's decision table ------------------------------------------

describe("A1 — the validator answers with a decision table", () => {
  it("is composed for PR builds by default, never for the scan, and off restores the frozen format", () => {
    const on = configAddenda(baseCfg.review).find((a) => a.id === "validate-compact-output")!;
    expect(on.scope).toEqual([VALIDATE_PASS]);
    expect(on.mode).toBe("pr");
    expect(on.text).toContain("`DECISIONS`");
    expect(on.text).toContain("never what you decide");
    expect(
      configAddenda({ ...baseCfg.review, validate_compact: false }).some(
        (a) => a.id === "validate-compact-output",
      ),
    ).toBe(false);
    expect(
      addendaForPass(VALIDATE_PASS, configAddenda(baseCfg.review), undefined, "scan").some(
        (a) => a.id === "validate-compact-output",
      ),
    ).toBe(false);
  });

  it("the round tells the session how to read the table — only when the plan has a validator", () => {
    const files = [file("src/a.py")];
    const order = (cfg: Config) =>
      buildRoundOrder({
        cfg,
        row,
        files,
        roundId: 1,
        roundNo: 1,
        roundType: "first",
        worktree: "wt/pr-7",
        settledDigest: "",
        issuedAt: "2026-10-09T00:00:00Z",
      });
    const on = order(baseCfg);
    expect(on.validate_compact).toBe(true);
    const text = prompt(on);
    expect(text).toContain("The validator answers with a decision table");
    expect(text).toContain("record it `doubted` (`unverifiable`) and never post it");
    const off = order(withReview({ validate_compact: false }));
    expect(off.validate_compact).toBeUndefined();
    expect(prompt(off)).not.toContain("decision table");
    expect(renderValidatorOutputNote({ validate_compact: true, pass_plan: [] })).toBe("");
  });

  it("every round template tells the parent to read narrowly", () => {
    for (const t of ["first", "re-review", "staleness", "follow-up"]) {
      const text = readFileSync(resolve(process.cwd(), `prompts/round-${t}.md`), "utf8");
      expect(text, t).toContain("**Read narrowly in the parent.**");
    }
  });
});

// ---- prior findings in the task files ----------------------------------------

const prior = (over: Partial<PriorFinding>): PriorFinding =>
  ({
    ref: "1:k",
    round_no: 1,
    finding_key: "k",
    origin_round: 1,
    earlier_refs: [],
    head_sha: "a".repeat(40),
    path: "src/a.py",
    line: 10,
    posted_as: "blocker",
    severity: "P1",
    lens: "pass-baseline",
    lens_ids: ["pass-baseline"],
    title: "boom",
    thread_id: 1,
    blocking: true,
    last_status: null,
    last_status_round: null,
    last_evidence: null,
    reason: null,
    evidence: null,
    ...over,
  }) as PriorFinding;

const entry = (lens: string, focus?: string[]): PassPlanEntry => ({
  lens,
  agent: `${lens}--sol-high`,
  tier: "sol-high",
  raisable_to: [],
  ...(focus ? { focus } : {}),
});

describe("A6 — the daemon assigns every prior finding to the row that owns it", () => {
  const plan = [
    entry("pass-baseline", ["src/a.py"]),
    entry("pass-baseline", ["src/b.py"]),
    entry("pass-security"),
    entry(SWEEP_PASS, ["src/c.py"]),
    entry(VALIDATE_PASS),
  ];

  it("the raising lens when planned, its row by file, else pass-baseline", () => {
    const assigned = assignPriorFindings(
      {
        round_no: 3,
        findings: [
          prior({ ref: "1:sec", lens: "pass-security", lens_ids: ["pass-security"] }),
          prior({ ref: "1:sw", lens: "pass-sweep", lens_ids: ["pass-sweep"], path: "src/c.py" }),
          // a sweep finding whose file no sweep row holds falls to baseline, by file
          prior({ ref: "1:sw2", lens: "pass-sweep", lens_ids: ["pass-sweep"], path: "src/b.py" }),
          // a lens not planned this round → baseline
          prior({
            ref: "2:dup",
            round_no: 2,
            lens: "pass-duplication",
            lens_ids: ["pass-duplication"],
          }),
          // a split baseline: the row whose files hold it, else the first
          prior({ ref: "1:far", path: "src/z.py" }),
          // the validator never owns one
          prior({ ref: "1:val", lens: VALIDATE_PASS, lens_ids: [VALIDATE_PASS], path: null }),
        ],
      },
      plan,
      new Set(["src/a.py"]),
    );
    const where = Object.fromEntries(assigned.flatMap((a) => a.priors.map((p) => [p.ref, a.row])));
    expect(where).toEqual({
      "1:sec": 2,
      "1:sw": 3,
      "1:sw2": 1,
      "2:dup": 0,
      "1:far": 0,
      "1:val": 0,
    });
    const dup = assigned.flatMap((a) => a.priors).find((p) => p.ref === "2:dup")!;
    expect(dup.unchanged).toBe(false); // src/a.py is in the delta
    expect(dup.held_last_round).toBe(true); // posted in round 2, this is round 3
    const sec = assigned.flatMap((a) => a.priors).find((p) => p.ref === "1:sec")!;
    expect(sec.held_last_round).toBe(false);
    const far = assigned.flatMap((a) => a.priors).find((p) => p.ref === "1:far")!;
    expect(far.unchanged).toBe(true);
  });

  it("the row's task file carries its findings and the one-line answer; other rows carry none", () => {
    const delta: RoundDelta = {
      from_sha: "b".repeat(40),
      tree: "c".repeat(40),
      lines: 3,
      files: [{ path: "src/a.py", status: "modified", ranges: [[1, 3]] }],
      patch_file: "/s/delta.patch",
    };
    const files = [file("src/a.py"), file("src/b.py")];
    const order = buildRoundOrder({
      cfg: baseCfg,
      row,
      files,
      roundId: 1,
      roundNo: 3,
      roundType: "re-review",
      worktree: "wt/pr-7",
      settledDigest: "",
      issuedAt: "2026-10-09T00:00:00Z",
      followUp: {
        delta,
        deltaFiles: [file("src/a.py")],
        priorFindingsNote: "PRIOR FINDINGS TO VERIFY — 1",
        priorFindings: { round_no: 3, findings: [prior({ ref: "2:k", round_no: 2 })] },
      },
    });
    expect(order.prior_assignments).toHaveLength(1);
    const at = order.prior_assignments![0]!.row;
    expect(order.pass_plan[at]!.lens).toBe("pass-baseline");
    const mine = renderPassTask(order, order.pass_plan[at]!, "", undefined, at);
    expect(mine).toContain("## Prior findings to verify first");
    expect(mine).toContain("`PRIOR <ref> <fixed|open|obsolete|unverifiable> — <evidence");
    expect(mine).toContain("ref 2:k");
    const other = order.pass_plan.findIndex((p, i) => i !== at && p.lens !== VALIDATE_PASS);
    expect(renderPassTask(order, order.pass_plan[other]!, "", undefined, other)).not.toContain(
      "## Prior findings to verify first",
    );
    // The session checks the assignment rather than making it.
    const withFiles = { ...order, pass_task_files: [{ row: at, agent: "a", path: "/t/01-a.md" }] };
    expect(renderPassTaskNote(withFiles)).toContain("already in their lenses' task files");
    expect(prompt(order)).toContain("check the daemon's assignment");
  });

  it("no list ⇒ no assignment: the session assigns, as before", () => {
    expect(renderPriorTaskSection([])).toBe("");
    expect(assignPriorFindings({ round_no: 2, findings: [] }, plan, new Set())).toEqual([]);
    expect(
      assignPriorFindings(
        { round_no: 2, findings: [prior({})] },
        [entry(VALIDATE_PASS)],
        new Set(),
      ),
    ).toEqual([]);
  });
});
