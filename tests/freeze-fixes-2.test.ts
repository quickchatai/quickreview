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
    expect(t).toMatch(/\*\*siblings\*\*/);
    expect(t).toMatch(/\*\*twin\*\*/);
    expect(t).toMatch(/\*\*every consequence\*\*/);
    expect(t).toMatch(/\*\*other calls\*\* in the same loop/);
    expect(t).toMatch(/needs its OWN fix is its own finding/);
    // The baseline sibling-sites rule folded in (one finding, every site listed).
    expect(t).toMatch(/callers of a shared helper/);
    expect(t).toMatch(/one finding with every site listed/);
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
    expect(rows[0]!.why).toMatch(/base behaviour is at risk/);
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

describe("sweep mechanical checklist", () => {
  it("binds pass-sweep only (PR builds) and names the seven checks", () => {
    expect(ids("pass-sweep")).toContain("sweep-mechanical-checklist");
    expect(ids("pass-baseline")).not.toContain("sweep-mechanical-checklist");
    expect(ids("pass-sweep", "scan")).not.toContain("sweep-mechanical-checklist");
    const t = text("sweep-mechanical-checklist");
    for (const k of [/can be null, empty or throw/, /Placeholders vs arguments/, /A default outside its choices/, /names the wrong thing/, /Two similar APIs/, /Combined or repeated input/, /An unreachable fallback/])
      expect(t).toMatch(k);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("pass-tests: a loosened test is evidence of a behaviour change", () => {
  it("binds pass-tests (PR builds) and reports the production behaviour, not coverage", () => {
    expect(ids("pass-tests")).toContain("tests-loosened-is-behaviour");
    expect(ids("pass-tests", "scan")).not.toContain("tests-loosened-is-behaviour");
    const t = text("tests-loosened-is-behaviour");
    expect(t).toMatch(/RELAXES an existing test/);
    expect(t).toMatch(/Report THAT behaviour change as the finding, anchored at the production line/);
    expect(t).toMatch(/It is not a coverage note/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("sweep: prose focus files and paths left behind by a move", () => {
  it("binds pass-sweep (PR builds): prose against the changed code, nit unless a command or example breaks; grep old paths", () => {
    expect(ids("pass-sweep")).toContain("sweep-docs-and-moves");
    const t = text("sweep-docs-and-moves");
    expect(t).toMatch(/A prose focus file/);
    expect(t).toMatch(/Grammar and wording are not findings/);
    expect(t).toMatch(/grep the repository for the OLD path/);
    expect(t).toMatch(/CODEOWNERS/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

import { selectSubLenses, PUBLIC_SIGNATURE_RE, WIRE_FORMAT_RE } from "../src/heuristics.js";

describe("planning: every planned lens says why (owner decision 2026-10-03)", () => {
  it("each plan row but the validator carries a reason", () => {
    const files = [
      { ...f("app/serializers/user.py", 200, 10), patch: "@@ -1,2 +1,2 @@\n-def old(x):\n+def new(x, y):\n" },
      f("web/a.tsx", 30, 2),
      f("tests/test_user.py", 30, 0),
    ];
    const { pass_plan } = buildPassPlan(cfg(), files);
    for (const r of pass_plan.filter((p) => p.lens !== "pass-validate"))
      expect(typeof r.why === "string" && r.why.length > 0, r.lens).toBe(true);
    expect(pass_plan.find((r) => r.lens === "pass-baseline")!.why).toMatch(/every round/);
    expect(pass_plan.find((r) => r.lens === "pass-ui")!.why).toMatch(/web\/a\.tsx/);
  });
});

describe("planning: backcompat by content, claims on a stated behaviour", () => {
  it("a changed public signature or wire serialization plans backcompat outside the API paths", () => {
    expect(PUBLIC_SIGNATURE_RE.test("export function render(opts) {")).toBe(true);
    expect(PUBLIC_SIGNATURE_RE.test("pub fn encode(&self) -> Vec<u8> {")).toBe(true);
    expect(PUBLIC_SIGNATURE_RE.test("func NewClient(cfg Config) *Client {")).toBe(true);
    expect(PUBLIC_SIGNATURE_RE.test("def public_helper(a):")).toBe(true);
    expect(PUBLIC_SIGNATURE_RE.test("    def _private(self):")).toBe(false);
    expect(PUBLIC_SIGNATURE_RE.test("func helper(x int) {")).toBe(false);
    expect(WIRE_FORMAT_RE.test("    out.writeString(name); // writeTo(StreamOutput out)")).toBe(true);
    const lib = { ...f("lib/core/encoder.ts", 5, 5), patch: "@@ -1,1 +1,1 @@\n-export function encode(a: A): string {\n+export function encode(a: A, b?: B): string {\n" };
    const plan = buildPassPlan(cfg(), [lib]).pass_plan;
    const bc = plan.find((r) => r.lens === "pass-backcompat");
    expect(bc).toBeDefined();
    expect(bc!.why).toMatch(/a public signature changes in lib\/core\/encoder\.ts/);
    const internal = { ...f("lib/core/encoder.ts", 5, 5), patch: "@@ -1,1 +1,1 @@\n-  const x = 1;\n+  const x = 2;\n" };
    expect(buildPassPlan(cfg(), [internal]).pass_plan.some((r) => r.lens === "pass-backcompat")).toBe(false);
  });

  it("pass-claims fires on a stated behaviour in a one-line body", () => {
    const hit = selectSubLenses([], { title: "Truncate status output", body: "Outputs the last lines that fit." });
    expect(hit.find((s) => s.lens === "pass-claims")?.why).toMatch(/Outputs the last lines that fit/);
    expect(selectSubLenses([], { title: "Refactor", body: "Moves code around." }).some((s) => s.lens === "pass-claims")).toBe(false);
  });
});

import { LENS_PLANNING } from "../src/lensplanning.js";
import { ALL_PASSES } from "../src/passes.js";

describe("every lens documents when it runs and its priority (owner decision 2026-10-03)", () => {
  it("LENS_PLANNING covers exactly ALL_PASSES", () => {
    expect(Object.keys(LENS_PLANNING).sort()).toEqual([...ALL_PASSES].sort());
    for (const [l, p] of Object.entries(LENS_PLANNING)) expect(p.when.length, l).toBeGreaterThan(5);
  });
  it("no lens was removed: abstraction, placement and backcompat are still in the vocabulary", () => {
    for (const l of ["pass-abstraction", "pass-placement", "pass-backcompat"]) expect(ALL_PASSES).toContain(l);
  });
});

import { clusterFindings, identifiersOf } from "../src/dedup.js";

describe("dedup hygiene: identifiers without backticks", () => {
  it("reads camelCase, PascalCase, snake_case, SCREAMING_CASE, calls and dotted names from plain prose", () => {
    const ids = identifiersOf("The refresh skips modelLibraries and ExternalManager; RECREATE_UPGRADE_EXIT_CODE changed, get_model returns None, and client.retry() is gone.");
    for (const x of ["modelLibraries", "ExternalManager", "RECREATE_UPGRADE_EXIT_CODE", "get_model", "client", "retry"]) expect(ids.has(x), x).toBe(true);
    for (const x of ["The", "refresh", "JavaScript", "None"]) expect(ids.has(x), x).toBe(false);
    expect(identifiersOf("Written in JavaScript on GitHub, see the docs.").size).toBe(0);
  });
  it("two candidates naming the same bare identifier now join a group", () => {
    const r = clusterFindings([
      { id: "a", path: "x.ts", line: 10, title: "loadModel can return null", body: "loadModel returns null for an unknown id" },
      { id: "b", path: "y.ts", line: 200, title: "Caller dereferences loadModel result", body: "the loop calls loadModel and reads .name" },
    ]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.signals).toContain("shared-identifier");
  });
  it("the validator keeps each merged member's anchor and never folds a second fix in", async () => {
    const { configAddenda } = await import("../src/include.js");
    const t = configAddenda({ dedup_merge: true }).find((a) => a.id === "dedup-group-validate")!.text;
    expect(t).toMatch(/keeping that member's own `path` and `line`/);
    expect(t).toMatch(/never carries a second fix as a clause/);
  });
});
