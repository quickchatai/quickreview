// The owner-approved review calibrations of 2026-10-02 (after the Martian
// tune20 golden mining, bench/aacr/ext/martian-tuning/GOLDEN-MINING.md §5).
// Each rides the addendum registry (rule 6: seeds untouched), binds exactly the
// pass it names, and composes into PR builds only — a scan build is unchanged.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addendaForPass, buildAgents, PASS_ADDENDA, VALIDATE_PASS } from "../src/include.js";
import { ALL_PASSES } from "../src/passes.js";

const root = resolve(process.cwd());

function built(): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "qcr-calibration-"));
  try {
    buildAgents(join(root, "agents"), dir, { root });
    return new Map(
      readdirSync(dir).map((f) => [f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every pass that composes `id` in a PR build, and in a scan build. */
function boundTo(id: string): { pr: string[]; scan: string[] } {
  const of = (mode: "pr" | "scan") =>
    ALL_PASSES.filter((p) =>
      addendaForPass(p, PASS_ADDENDA, "django", mode).some((a) => a.id === id),
    );
  return { pr: of("pr"), scan: of("scan") };
}

describe("consistency-identifiers (pass-consistency)", () => {
  it("binds pass-consistency alone, in PR builds only", () => {
    expect(boundTo("consistency-identifiers")).toEqual({ pr: ["pass-consistency"], scan: [] });
  });

  it("compares new identifiers with the PR's other uses and with the sibling convention", () => {
    const body = built().get("pass-consistency--sol-med")!;
    expect(body).toContain("New identifiers must agree with each other and with their siblings");
    for (const phrase of [
      "Metric names, metric tag or label keys",
      "Against the other new uses in this PR",
      "Against the sibling convention in the touched module",
      "raises a generic error",
      "the majority's `path:line` and the outlier's",
      "does not cover these",
    ])
      expect(body, phrase).toContain(phrase);
    // composed after the seed's own "Not this lens" style exclusion it qualifies
    expect(body.indexOf("New identifiers must agree")).toBeGreaterThan(
      body.indexOf("Style is excluded"),
    );
  });

  it("names no benchmark, project or PR", () => {
    const text = PASS_ADDENDA.find((a) => a.id === "consistency-identifiers")!.text;
    expect(text).not.toMatch(
      /martian|golden|sentry|keycloak|grafana|cal\.com|discourse|shards?\b/i,
    );
  });
});

void VALIDATE_PASS;
