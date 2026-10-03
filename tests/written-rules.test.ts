// Written repo rules (2026-10-03, the Qodo PR-Review-Bench near-miss audit):
// pass-style walks every written rule as a checklist, one grouped nit per rule;
// it is planned on a test-only diff when the repo writes rules; and the
// validator never kills a finding that cites a written rule for its shape.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import { addendaForPass, buildAgents, PASS_ADDENDA } from "../src/include.js";

const root = resolve(process.cwd());
const NO_BENCHMARK_NAMES = /qodo|swe-?prbench|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|spyder/i;
const text = (id: string) => PASS_ADDENDA.find((a) => a.id === id)!.text;
const ids = (p: string, mode: "pr" | "scan" = "pr") =>
  addendaForPass(p, PASS_ADDENDA, "django", mode).map((a) => a.id);

describe("pass-style walks every written rule", () => {
  it("binds pass-style only, PR builds only", () => {
    expect(ids("pass-style")).toContain("style-written-rule-checklist");
    expect(ids("pass-style", "scan")).not.toContain("style-written-rule-checklist");
    expect(ids("pass-baseline")).not.toContain("style-written-rule-checklist");
  });
  it("checks rule by rule, groups one rule's sites into one nit, names conflicts, leaves tool-enforced rules", () => {
    const t = text("style-written-rule-checklist");
    expect(t).toMatch(/ONE BY ONE/);
    expect(t).toMatch(/test files included, unless the guide exempts tests/);
    expect(t).toMatch(/ONE `\[nit\]` that quotes the rule .* lists every site/);
    expect(t).toMatch(/Never one comment per site/);
    expect(t).toMatch(/conflicts with the file's own convention/);
    expect(t).toMatch(/A rule that config enforces belongs to CI/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
  it("is in the built pass-style body", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-written-rules-"));
    try {
      buildAgents(join(root, "agents"), dir, { root });
      const f = readdirSync(dir).find((n) => n.startsWith("pass-style--"));
      expect(f).toBeDefined();
      expect(readFileSync(join(dir, f!), "utf8")).toContain("Walk every written rule");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the validator never kills a written-rule finding for its shape", () => {
  it("binds pass-validate, PR builds only", () => {
    expect(ids("pass-validate")).toContain("validate-written-rule-kept");
    expect(ids("pass-validate", "scan")).not.toContain("validate-written-rule-kept");
  });
  it("demotes to a nit, never kills below-bar or for its lens or its siblings, still leaves CI's rules", () => {
    const t = text("validate-written-rule-kept");
    expect(t).toMatch(/from ANY lens/);
    expect(t).toMatch(/Never kill it `below-bar`/);
    expect(t).toMatch(/never excuse it because sibling or older code breaks the same rule/);
    expect(t).toMatch(/never fold it as a paragraph under an unrelated finding/);
    expect(t).toMatch(/configured formatter or linter enforces the rule \(`out-of-scope`/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
});

describe("pass-style is planned on a test-only diff when the repo writes rules", () => {
  const cfg: Config = parseConfig(readFileSync(resolve(root, "tests/fixtures/config.toml"), "utf8"));
  const testOnly = [
    { filename: "src/Foo.Tests/DisplayNameTest.cs", status: "modified", additions: 40, deletions: 2, changes: 42 },
  ] as unknown as PrFileEntry[];
  it("plans it with the written guide named as the reason", () => {
    const c = structuredClone(cfg);
    c.review = { ...c.review, style_lens: true };
    const { pass_plan } = buildPassPlan(c, testOnly, undefined, undefined, undefined, ["AGENTS.md"]);
    const row = pass_plan.find((r) => r.lens === "pass-style");
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).toContain("AGENTS.md");
  });
  it("does not plan it when the repo writes no rules and the profile has no guide", () => {
    const c = structuredClone(cfg);
    c.review = { ...c.review, style_lens: true };
    const { pass_plan } = buildPassPlan(c, testOnly, undefined, undefined, undefined, []);
    expect(pass_plan.some((r) => r.lens === "pass-style")).toBe(false);
  });
});
