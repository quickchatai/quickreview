// Written repo rules:
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
const NO_BENCHMARK_NAMES =
  /qodo|swe-?prbench|ghost|aspnetcore|firefox|tauri|prefect|dify|redis|pipecat|spyder/i;
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
    expect(t).toMatch(/anchored at the first/);
    expect(t).toMatch(/conflicts with the file's own convention/);
    expect(t).toMatch(/belongs to the lint-conformance check/);
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

describe("one validator rule for conventions: written rules kept as nits, CI-enforced lint a build defect", () => {
  it("binds pass-validate, in PR and scan builds", () => {
    // Scan too: quality-cap-validate (both modes) defers every
    // convention candidate to this rule, and stage 2 can plan pass-style.
    expect(ids("pass-validate")).toContain("validate-convention-rule");
    expect(ids("pass-validate", "scan")).toContain("validate-convention-rule");
    expect(ids("pass-validate")).not.toContain("validate-written-rule-kept");
  });
  it("demotes a written rule to a nit, keeps CI-run lint at P2, kills only unbacked taste", () => {
    const t = text("validate-convention-rule");
    expect(t).toMatch(/from ANY lens/);
    expect(t).toMatch(/Never kill it `below-bar`/);
    expect(t).toMatch(/never excuse it because sibling or older code breaks the same rule/);
    expect(t).toMatch(/never fold it as a paragraph under an unrelated finding/);
    expect(t).toMatch(/AND a CI job of this repo runs/);
    expect(t).toMatch(/build defect, not style — keep it at `P2`/);
    expect(t).toMatch(/never \\"CI owns it\\"|never "CI owns it"/);
    expect(t).toMatch(/Neither\*\*: taste — kill it `style-not-in-guide`/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
  it("no validator text tells it to leave CI-run lint out of scope any more", () => {
    for (const a of addendaForPass("pass-validate", PASS_ADDENDA, "django", "pr"))
      expect(a.text, a.id).not.toMatch(
        /CI owns it\)|formatter or linter enforces is still out of scope/,
      );
  });
});

describe("new code is judged against itself; the base is a comparison, not an excuse", () => {
  it("binds pass-validate (PR builds) and names the three habits", () => {
    expect(ids("pass-validate")).toContain("validate-new-code-and-base");
    const t = text("validate-new-code-and-base");
    expect(t).toMatch(/never refutes a defect in code this PR adds or rewrites/);
    expect(t).toMatch(/cites the comparison/);
    // The merge rule lives once, in the merge/group rules (no restatement here).
    expect(t).not.toMatch(/Merge only what one fix removes/);
    expect(t).not.toMatch(NO_BENCHMARK_NAMES);
  });
  it("documented semantics now include published standards, and unverifiable is for the in-code mechanism only", () => {
    const t = text("validate-external-semantics");
    expect(t).toMatch(/an RFC, a file-format or codec specification, a published grammar/);
    expect(t).toMatch(
      /`unverifiable` is only for a mechanism you could not establish IN THIS CODE/,
    );
  });
});

describe("pass-style is planned on a test-only diff when the repo writes rules", () => {
  const cfg: Config = parseConfig(
    readFileSync(resolve(root, "tests/fixtures/config.toml"), "utf8"),
  );
  const testOnly = [
    {
      filename: "src/Foo.Tests/DisplayNameTest.cs",
      status: "modified",
      additions: 40,
      deletions: 2,
      changes: 42,
    },
  ] as unknown as PrFileEntry[];
  it("plans it with the written guide named as the reason", () => {
    const c = structuredClone(cfg);
    c.review = { ...c.review, style_lens: true };
    const { pass_plan } = buildPassPlan(c, testOnly, undefined, undefined, undefined, [
      "AGENTS.md",
    ]);
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
