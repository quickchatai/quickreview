// The code-quality lenses (2026-09-27): maintainability, duplication and
// abstraction on every PR that adds real code; style ONLY where the repo
// writes its style guide down — and style from any other lens is killed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, REVIEW_PRESETS, type Config } from "../src/config.js";
import { ALL_PASSES, buildPassPlan } from "../src/dispatch.js";
import { DOWNGRADE_WORDS, KILL_WORDS } from "../src/findingsrecord.js";
import type { PrFileEntry } from "../src/github.js";
import { QUALITY_MIN_ADDED_LINES, QUALITY_PASSES, STYLE_PASS } from "../src/heuristics.js";
import { addendaForPass, VALIDATE_PASS } from "../src/include.js";
import { findStyleGuide, GUIDE_MIN_LINES, SECTION_MIN_LINES } from "../src/styleguide.js";

const baseCfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const withLevers = (over: Partial<Config["review"]>): Config => {
  const cfg = structuredClone(baseCfg);
  cfg.review = { ...cfg.review, ...over };
  return cfg;
};
const file = (filename: string, lines: number): PrFileEntry => ({
  filename,
  additions: lines,
  deletions: 0,
  status: "modified",
  patch: ["@@ -1,1 +1,2 @@", ...Array.from({ length: lines }, (_, i) => `+x${i}();`)].join("\n"),
});
const lenses = (cfg: Config, files: PrFileEntry[], guide: string[] = []) =>
  buildPassPlan(cfg, files, undefined, undefined, undefined, guide).pass_plan.map((p) => p.lens);

describe("the quality lenses", () => {
  it("are planned once non-test code adds enough lines, and never on docs or tests alone", () => {
    const big = lenses(baseCfg, [file("src/a.ts", QUALITY_MIN_ADDED_LINES)]);
    for (const l of QUALITY_PASSES) expect(big).toContain(l);
    const small = lenses(baseCfg, [file("src/a.ts", QUALITY_MIN_ADDED_LINES - 1)]);
    for (const l of QUALITY_PASSES) expect(small).not.toContain(l);
    const testsOnly = lenses(baseCfg, [file("tests/a.test.ts", 200)]);
    for (const l of QUALITY_PASSES) expect(testsOnly).not.toContain(l);
    const docs = lenses(baseCfg, [file("README.md", 200)]);
    for (const l of QUALITY_PASSES) expect(docs).not.toContain(l);
  });

  it("are a preset lever: on by default, addable when switched off, threshold configurable", () => {
    expect(REVIEW_PRESETS.default.levers.quality_lenses).toBe(true);
    const off = buildPassPlan(withLevers({ quality_lenses: false }), [file("src/a.ts", 100)]);
    for (const l of QUALITY_PASSES) {
      expect(off.pass_plan.map((p) => p.lens)).not.toContain(l);
      expect(off.addable_lenses).toContain(l);
      expect(ALL_PASSES).toContain(l);
    }
    expect(lenses(withLevers({ quality_min_added_lines: 5 }), [file("src/a.ts", 5)])).toContain(
      "pass-duplication",
    );
  });

  it("are capped at P2 at the validator and share the judgment lenses' own-questions rule", () => {
    const v = addendaForPass(VALIDATE_PASS);
    const cap = v.find((a) => a.id === "quality-cap-validate")!;
    expect(cap).toBeDefined();
    for (const l of QUALITY_PASSES) {
      expect(cap.text).toContain(`\`${l}\``);
      expect(addendaForPass(l).map((a) => a.id)).toContain("judgment-lens-own-questions");
    }
    expect(cap.text).toContain("down to `P2` with the downgrade word `design-over-cap`");
  });
});

describe("the style lens", () => {
  it("is planned only with a written guide, and tells the pass where the guide is", () => {
    const code = [file("src/a.ts", 3)];
    expect(lenses(baseCfg, code)).not.toContain(STYLE_PASS);
    const plan = buildPassPlan(baseCfg, code, undefined, undefined, undefined, ["docs/STYLE.md"]);
    const row = plan.pass_plan.find((p) => p.lens === STYLE_PASS)!;
    expect(row.why).toContain("docs/STYLE.md");
    expect(lenses(withLevers({ style_lens: false }), code, ["docs/STYLE.md"])).not.toContain(
      STYLE_PASS,
    );
    expect(lenses(baseCfg, [file("README.md", 3)], ["docs/STYLE.md"])).not.toContain(STYLE_PASS);
  });

  it("style from any other lens is killed; the style lens itself is nit-only", () => {
    const cap = addendaForPass(VALIDATE_PASS).find((a) => a.id === "quality-cap-validate")!;
    expect(cap.text).toContain("`style-not-in-guide`");
    expect(cap.text).toContain("`style-over-cap`");
    expect(KILL_WORDS).toContain("style-not-in-guide");
    expect(DOWNGRADE_WORDS).toContain("style-over-cap");
    // The maintainability lens never raises style.
    expect(readFileSync("agents/pass-maintainability.md", "utf8")).toContain(
      "**Style is excluded.**",
    );
  });
});

describe("findStyleGuide", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-style-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const rules = (n: number) => Array.from({ length: n }, (_, i) => `- rule ${i}`).join("\n");

  it("finds a substantial dedicated guide at the root, under docs/ and one level below", () => {
    writeFileSync(join(root, "STYLEGUIDE.md"), `# Style\n${rules(GUIDE_MIN_LINES)}\n`);
    mkdirSync(join(root, "docs", "dev"), { recursive: true });
    writeFileSync(join(root, "docs", "coding-standards.md"), rules(GUIDE_MIN_LINES));
    writeFileSync(join(root, "docs", "dev", "style-guide.rst"), rules(GUIDE_MIN_LINES));
    expect(findStyleGuide(root)).toEqual([
      "STYLEGUIDE.md",
      "docs/coding-standards.md",
      "docs/dev/style-guide.rst",
    ]);
  });

  it("ignores a stub guide and linter configs — a tool's rules are CI's", () => {
    writeFileSync(join(root, "STYLE.md"), "We use prettier.\n");
    writeFileSync(join(root, ".eslintrc.json"), "{}");
    writeFileSync(join(root, "ruff.toml"), rules(40));
    expect(findStyleGuide(root)).toEqual([]);
  });

  it("finds the style section of CONTRIBUTING with its line span, only when substantial", () => {
    writeFileSync(
      join(root, "CONTRIBUTING.md"),
      `# Contributing\nhello\n## Code style\n${rules(SECTION_MIN_LINES)}\n## Releases\nx\n`,
    );
    expect(findStyleGuide(root)).toEqual([`CONTRIBUTING.md:3-${3 + SECTION_MIN_LINES}`]);
    writeFileSync(join(root, "CONTRIBUTING.md"), "# Contributing\n## Code style\nUse black.\n");
    expect(findStyleGuide(root)).toEqual([]);
  });

  it("is total: a missing tree is no guide", () => {
    expect(findStyleGuide(join(root, "nope"))).toEqual([]);
  });
});

describe("code files", () => {
  it("counts ESM/CJS TypeScript modules as code (a .mts-only PR once got no code lenses)", async () => {
    const { CODE_FILE_RE } = await import("../src/heuristics.js");
    for (const f of ["a.mts", "a.cts", "a.cxx", "a.hh", "a.dart"])
      expect(CODE_FILE_RE.test(f)).toBe(true);
    const l = lenses(baseCfg, [file("scripts/make.mts", 45)]);
    expect(l).toContain("pass-tests");
    expect(l).toContain("pass-maintainability");
  });
});

describe("[review] nits — strict by default, open on request", () => {
  it("defaults to strict, accepts open, refuses anything else", async () => {
    const { configAddenda } = await import("../src/include.js");
    const { renderNitPolicyNote } = await import("../src/templates.js");
    expect(baseCfg.review.nits).toBe("strict");
    const toml = readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8");
    const withNits = (v: string) => toml.replace(/^\[review\]$/m, `[review]\nnits = "${v}"`);
    expect(parseConfig(withNits("open")).review.nits).toBe("open");
    expect(() => parseConfig(withNits("some"))).toThrow(/nits must be "strict" or "open"/);
    // strict adds nothing anywhere (the duplicate merge's rule is its own knob)
    expect(configAddenda(baseCfg.review).map((a) => a.id)).toEqual(["validate-demote-not-kill", "dedup-group-validate"]);
    expect(renderNitPolicyNote(undefined)).toBe("");
    const open = configAddenda({ nits: "open" });
    expect(open.map((a) => a.id)).toEqual([
      "validate-demote-not-kill",
      "nits-open",
      "nits-open-validate",
    ]);
    expect(open[2]!.text).toContain("`below-bar` is not used this round");
    expect(renderNitPolicyNote("open")).toContain("NIT POLICY — open");
  });

  it("an open config reaches the round order; strict leaves it out", async () => {
    const { buildRoundOrder } = await import("../src/dispatch.js");
    const order = (cfg: Config) =>
      buildRoundOrder({
        cfg,
        row: { number: 7, title: "t", head_sha: "h" } as never,
        files: [file("src/a.ts", 30)],
        roundId: 1,
        roundNo: 1,
        roundType: "first",
        worktree: "wt/pr-7",
        settledDigest: "",
        issuedAt: "2026-09-27T00:00:00Z",
      });
    expect(order(withLevers({ nits: "open" })).nit_policy).toBe("open");
    expect(order(baseCfg).nit_policy).toBeUndefined();
  });
});

describe("the validator demotes a true observation instead of killing it", () => {
  it("is on by default, and quality-lens findings are judged on the cost they name", async () => {
    const { configAddenda } = await import("../src/include.js");
    expect(configAddenda(baseCfg.review).map((a) => a.id)).toEqual(["validate-demote-not-kill", "dedup-group-validate"]);
    expect(configAddenda({ ...baseCfg.review, validate_demote: false, dedup_merge: false })).toEqual([]);
    const cap = addendaForPass(VALIDATE_PASS).find((a) => a.id === "quality-cap-validate")!;
    expect(cap.text).toContain("are NOT kill reasons for them");
    expect(cap.text).toContain("`pass-consistency` is capped at `P2` UNLESS it shows a failure");
  });
});
