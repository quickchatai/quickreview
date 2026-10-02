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
    expect(t).toMatch(/killed `style-not-in-guide`.*when the repo writes no rule for it/);
    expect(t).toMatch(/QUOTES a rule the repo wrote/);
    expect(t).toMatch(/never kill it for the lens it came from/);
    expect(t).toMatch(/formatter or linter enforces is still out of scope/);
    expect(bodyOf("pass-validate")).toContain("QUOTES a rule the repo wrote");
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
