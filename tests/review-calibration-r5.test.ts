// Round-5 review calibrations (2026-10-03), mined from the stored reviews of
// two external runs — SWE-PRBench eval100 and Qodo PR-Review-Bench pr100 —
// with no new run (bench/aacr/ext/REVIEW-MINING.md). Each fix names a general
// class with evidence on several PRs; none encodes a benchmark's comments.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addendaForPass, buildAgents, PASS_ADDENDA } from "../src/include.js";

const root = resolve(process.cwd());
const NO_BENCHMARK_NAMES = /qodo|swe-?prbench|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|spyder/i;

let cache: Map<string, string> | undefined;
function built(): Map<string, string> {
  if (cache) return cache;
  const dir = mkdtempSync(join(tmpdir(), "qcr-calibration-r5-"));
  try {
    buildAgents(join(root, "agents"), dir, { root });
    cache = new Map(
      readdirSync(dir).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")]),
    );
    return cache;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function bodyOf(lens: string): string {
  const key = [...built().keys()].sort().find((k) => k.startsWith(`${lens}--`));
  expect(key, lens).toBeDefined();
  return built().get(key!)!;
}
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;

describe("a written rule raised by any lens is judged as style, not killed for its lens", () => {
  it("the validator keeps a rule-quoting convention finding as a nit and still kills unwritten taste", () => {
    const t = text("quality-cap-validate");
    // quality-cap no longer restates the style kill: it defers, once, to the convention rule.
    expect(t).toMatch(/judged only under \*One rule for conventions\*/);
    expect(t).not.toMatch(/`pass-style` findings are `nit`, always/);
    const c = text("validate-convention-rule");
    expect(c).toMatch(/from ANY lens/);
    expect(c).toMatch(/never kill it for the lens it came from/);
    expect(bodyOf("pass-validate")).toContain("One rule for conventions");
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
    expect(addendaForPass("pass-validate").some((a) => a.id === "quality-cap-validate")).toBe(true);
  });
});

describe("reordered-statements (pass-baseline, pass-sweep)", () => {
  it("binds the two line-reading lenses, PR builds only", () => {
    const ids = (p: string, mode: "pr" | "scan") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);
    for (const p of ["pass-baseline", "pass-sweep"]) {
      expect(ids(p, "pr")).toContain("reordered-statements");
      expect(ids(p, "scan")).not.toContain("reordered-statements");
    }
    expect(ids("pass-validate", "pr")).not.toContain("reordered-statements");
  });

  it("asks what the old order guaranteed and spares independent steps", () => {
    const t = text("reordered-statements");
    expect(t).toMatch(/write the OLD order and the NEW order side by side/);
    expect(t).toMatch(/what the old order guaranteed/);
    expect(t).toMatch(/Do not report a reorder whose steps are independent/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
    expect(bodyOf("pass-baseline")).toContain("A reorder changes what the old order guaranteed");
  });
});

// Round 6 (REVIEW-MINING.md §7), mined from the Qodo run with no new run.
describe("anchor-at-cause (every lens + the validator's re-anchor)", () => {
  const ids = (p: string, mode: "pr" | "scan") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

  it("binds every lens and the validator, PR builds only", () => {
    for (const p of ["pass-baseline", "pass-sweep", "pass-tests", "pass-security"]) {
      expect(ids(p, "pr")).toContain("anchor-at-cause");
      expect(ids(p, "scan")).not.toContain("anchor-at-cause");
    }
    expect(ids("pass-validate", "pr")).toContain("validate-anchor-at-cause");
    expect(ids("pass-validate", "pr")).not.toContain("anchor-at-cause");
  });

  it("anchors at the line a fix would edit, the symptom in the body, with both exceptions", () => {
    const t = text("anchor-at-cause");
    expect(t).toMatch(/CHANGED line that causes the defect/);
    expect(t).toMatch(/name that site in the body as the symptom/);
    expect(t).toMatch(/cause is in code this PR does not change, anchor the nearest changed line/);
    expect(t).toMatch(/defect IS in the test .* the test line is the cause/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
    expect(bodyOf("pass-baseline")).toContain("Anchor a finding at its cause, not at its symptom");
  });

  it("the validator re-anchors to the cause as a correction, never a bad-anchor kill", () => {
    const t = text("validate-anchor-at-cause");
    expect(t).toMatch(/re-anchored on that production line/);
    expect(t).toMatch(/never a `bad-anchor` kill/);
    expect(bodyOf("pass-validate")).toContain("Re-anchor to the cause");
  });

  it("every round template says anchor at the cause, and none still says where it shows", () => {
    for (const f of ["round-first.md", "round-re-review.md", "round-staleness.md"]) {
      const s = readFileSync(join(root, "prompts", f), "utf8");
      expect(s, f).toContain("**Anchor at the cause.**");
      expect(s, f).not.toContain("Anchor where the defect shows");
    }
  });
});

describe("line-local-slips (pass-baseline, pass-sweep)", () => {
  it("binds the two line-reading lenses, PR builds only", () => {
    const ids = (p: string, mode: "pr" | "scan") => addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);
    for (const p of ["pass-baseline", "pass-sweep"]) {
      expect(ids(p, "pr")).toContain("line-local-slips");
      expect(ids(p, "scan")).not.toContain("line-local-slips");
    }
    expect(ids("pass-validate", "pr")).not.toContain("line-local-slips");
  });

  it("checks operators, assignments, loop targets and near-namesakes, at the severity the outcome earns", () => {
    const t = text("line-local-slips");
    for (const re of [/comparison operator and bound/, /assignment vs compound assignment/, /loop or comprehension target/, /near-namesake in scope/])
      expect(t).toMatch(re);
    expect(t).toMatch(/concrete wrong outcome/);
    expect(t).toMatch(/at the severity that outcome earns/);
    expect(t).toMatch(/Do not report a token that is deliberate/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
    expect(bodyOf("pass-sweep")).toContain("One-token slips on changed lines");
  });
});
