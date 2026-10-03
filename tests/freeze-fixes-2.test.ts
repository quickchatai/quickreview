// Freeze fixes 2 (2026-10-03): the cross-benchmark miss analysis — general
// bug-class rules, PR builds only, no benchmark names in any prompt text.
import { describe, expect, it } from "vitest";
import { addendaForPass, PASS_ADDENDA } from "../src/include.js";

const NO_BENCHMARK_NAMES =
  /qodo|martian|swe-?prbench|aacr|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|spyder|cal\.com|keycloak|sentry|grafana|discourse|freecad|clickhouse|dbeaver|ollama|lvgl|electron|immich|ragflow|filament/i;
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;
const ids = (p: string, mode: "pr" | "scan" = "pr") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

describe("exhaust the site", () => {
  it("binds baseline, sweep, widened and behaviour-delta, PR builds only", () => {
    for (const p of ["pass-baseline", "pass-sweep", "pass-widened", "pass-behaviour-delta"])
      expect(ids(p), p).toContain("exhaust-the-site");
    expect(ids("pass-security")).not.toContain("exhaust-the-site");
    expect(ids("pass-baseline", "scan")).not.toContain("exhaust-the-site");
  });
  it("names siblings, twins, every consequence and the other failures, one finding per fix", () => {
    const t = text("exhaust-the-site");
    expect(t).toMatch(/Siblings of the same shape/);
    expect(t).toMatch(/The twin/);
    expect(t).toMatch(/Every consequence/);
    expect(t).toMatch(/other calls in that loop/);
    expect(t).toMatch(/needs its OWN fix as its own finding/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import { behaviourDeltaGroups, BEHAVIOUR_DELTA_PASS } from "../src/heuristics.js";
import type { PrFileEntry } from "../src/github.js";

const cfg = (): Config => parseConfig(readFileSync(resolve("tests/fixtures/config.toml"), "utf8"));
const f = (filename: string, additions: number, deletions: number, status = "modified") =>
  ({ filename, additions, deletions, changes: additions + deletions, status }) as unknown as PrFileEntry;

describe("pass-behaviour-delta", () => {
  it("groups only non-test code that modifies or deletes lines, packed by changed lines", () => {
    const files = [
      f("src/a.py", 10, 4),
      f("src/new.py", 80, 0, "added"), // pure addition: not this lens's
      f("tests/test_a.py", 5, 5), // a test: not this lens's
      f("README.md", 3, 3), // prose: not this lens's
      f("src/gone.go", 0, 40, "removed"), // a deleted file IS a behaviour change
      f("src/big.ts", 300, 300),
    ];
    const { groups, unread } = behaviourDeltaGroups(files, 3, 500);
    expect(groups).toEqual([["src/a.py", "src/gone.go"], ["src/big.ts"]]);
    expect(unread).toEqual([]);
    expect(behaviourDeltaGroups(files, 1, 500)).toEqual({ groups: [["src/a.py", "src/gone.go"]], unread: ["src/big.ts"] });
  });

  it("is planned before the validator with focus files and a reason, and the knob turns it off", () => {
    const c = cfg();
    const files = [f("src/a.py", 10, 4)];
    const { pass_plan } = buildPassPlan(c, files);
    const rows = pass_plan.filter((r) => r.lens === BEHAVIOUR_DELTA_PASS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.focus).toEqual(["src/a.py"]);
    expect(rows[0]!.why).toMatch(/modifies or deletes existing code/);
    expect(pass_plan.at(-1)!.lens).toBe("pass-validate");
    const off = structuredClone(c);
    off.review = { ...off.review, behaviour_delta: false };
    expect(buildPassPlan(off, files).pass_plan.some((r) => r.lens === BEHAVIOUR_DELTA_PASS)).toBe(false);
    // A pure addition plans no behaviour-delta row.
    expect(buildPassPlan(c, [f("src/new.py", 50, 0, "added")]).pass_plan.some((r) => r.lens === BEHAVIOUR_DELTA_PASS)).toBe(false);
  });

  it("its brief enumerates every modifying hunk, covers removed guards, defaults to a question, names no benchmark", () => {
    const body = readFileSync(resolve("agents/pass-behaviour-delta.md"), "utf8");
    expect(body).toMatch(/Enumerate\. Write ONE line in your notes for EVERY hunk/);
    expect(body).toMatch(/a removed or weakened guard/);
    expect(body).toMatch(/Default to a `question`/);
    expect(body).toMatch(/states as its intent is not a finding/);
    expect(body).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCiLinters, lintersForFiles } from "../src/lintconfig.js";
import { LINT_CONFORMANCE_PASS } from "../src/heuristics.js";

describe("pass-lint-conformance: planned only on linters a CI job runs", () => {
  const repo = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "qcr-lint-"));
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(d, p, ".."), { recursive: true });
      writeFileSync(join(d, p), t);
    }
    return d;
  };

  it("finds a tool a workflow runs directly, with its config", () => {
    const d = repo({
      ".github/workflows/ci.yml": "jobs:\n  lint:\n    steps:\n      - run: npx eslint . --max-warnings 0\n      - run: cargo fmt --check\n",
      "eslint.config.js": "export default [];\n",
      "rustfmt.toml": "max_width = 100\n",
    });
    try {
      const l = findCiLinters(d);
      expect(l.map((x) => x.tool).sort()).toEqual(["eslint", "rustfmt"]);
      expect(l.find((x) => x.tool === "eslint")!.configs).toEqual(["eslint.config.js"]);
      expect(l.find((x) => x.tool === "eslint")!.ci).toEqual([".github/workflows/ci.yml"]);
      expect(lintersForFiles(l, ["src/a.ts"]).map((x) => x.tool)).toEqual(["eslint"]);
      expect(lintersForFiles(l, ["README.md"])).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("follows a CI step through the package script that wraps the tool; a shared file needs the tool's section", () => {
    const d = repo({
      ".github/workflows/ci.yml": "steps:\n  - run: pnpm run lint\n",
      "package.json": '{"scripts":{"lint":"biome check ."}}',
      "biome.json": "{}",
      "pyproject.toml": "[project]\nname='x'\n",
    });
    try {
      const l = findCiLinters(d);
      expect(l.map((x) => x.tool)).toEqual(["biome"]);
      expect(l[0]!.ci).toEqual(["package.json"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("no CI definition, no linter — however much lint config the repo carries", () => {
    const d = repo({ "eslint.config.js": "export default [];\n", ".clang-format": "BasedOnStyle: LLVM\n" });
    try {
      expect(findCiLinters(d)).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("is planned with the tool and its CI file named, only when a changed file is covered", () => {
    const c = cfg();
    const linters = [{ tool: "clang-format", configs: [".clang-format"], ci: [".github/workflows/lint.yml"], covers: /\.(cc|h)$/ }];
    const plan = buildPassPlan(c, [f("shell/a.cc", 5, 3)], undefined, undefined, undefined, [], linters).pass_plan;
    const row = plan.find((r) => r.lens === LINT_CONFORMANCE_PASS);
    expect(row).toBeDefined();
    expect(row!.why).toMatch(/CI runs clang-format \(\.github\/workflows\/lint\.yml; config \.clang-format\)/);
    expect(buildPassPlan(c, [f("src/a.py", 5, 3)], undefined, undefined, undefined, [], linters).pass_plan.some((r) => r.lens === LINT_CONFORMANCE_PASS)).toBe(false);
    const off = structuredClone(c);
    off.review = { ...off.review, lint_conformance: false };
    expect(buildPassPlan(off, [f("shell/a.cc", 5, 3)], undefined, undefined, undefined, [], linters).pass_plan.some((r) => r.lens === LINT_CONFORMANCE_PASS)).toBe(false);
  });

  it("its brief reports only CI-failing violations on changed lines, one P2 per tool, never runs a tool", () => {
    const body = readFileSync(resolve("agents/pass-lint-conformance.md"), "utf8");
    expect(body).toMatch(/you never run a tool/);
    expect(body).toMatch(/One finding per tool/);
    expect(body).toMatch(/Its severity is `P2`/);
    expect(body).toMatch(/continue-on-error/);
    expect(body).not.toMatch(NO_BENCHMARK_NAMES);
  });
});
