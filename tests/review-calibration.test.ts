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
import { DOWNGRADE_WORDS, isKnownVocabularyWord } from "../src/findingsrecord.js";

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

describe("validator calibrations (pass-validate)", () => {
  const IDS = [
    "validate-external-semantics",
    "validate-interface-contract",
    "validate-masked-defect",
  ];

  it("each binds pass-validate alone, in PR builds only, after the doubt-not-kill rule", () => {
    const order = addendaForPass(VALIDATE_PASS).map((a) => a.id);
    for (const id of IDS) {
      expect(boundTo(id), id).toEqual({ pr: [VALIDATE_PASS], scan: [] });
      expect(order.indexOf(id), id).toBeGreaterThan(order.indexOf("validate-doubt-not-kill"));
    }
  });

  it("external semantics: dependency sources first, then a question naming the assumption — never doubted away", () => {
    const body =
      built().get(`${VALIDATE_PASS}--sol-high`) ?? built().get(`${VALIDATE_PASS}--sol-med`)!;
    expect(body).toContain(
      "A claim about an external tool or library is a question before it is a doubt",
    );
    expect(body).toContain("Consult the dependency sources first");
    expect(body).toContain("*Third-party sources* block");
    expect(body).toContain("do not doubt it away");
    expect(body).toContain("`external-assumption`");
    expect(body).toContain("`reachability: plausible`");
    expect(DOWNGRADE_WORDS).toContain("external-assumption");
    expect(isKnownVocabularyWord("external-assumption")).toBe(true);
  });

  it("interface contract: at least P2 whatever today's callers tolerate", () => {
    const text = PASS_ADDENDA.find((a) => a.id === "validate-interface-contract")!.text;
    expect(text).toContain("**at least `P2`**");
    expect(text).toContain("are not downgrade reasons");
    expect(text).toContain("Cite the contract text");
  });

  it("masked defect: keeps its own severity and states both", () => {
    const text = PASS_ADDENDA.find((a) => a.id === "validate-masked-defect")!.text;
    expect(text).toContain("do not downgrade the new defect for being masked");
    expect(text).toContain("state both");
  });

  it("name no benchmark, project or PR", () => {
    for (const id of IDS)
      expect(PASS_ADDENDA.find((a) => a.id === id)!.text, id).not.toMatch(
        /martian|golden|gifsicle|sentry|keycloak|grafana|cal\.com|discourse/i,
      );
  });
});

describe("tests that cannot observe what they claim (pass-tests + pass-validate)", () => {
  it("the lens half binds pass-tests alone and the validator half pass-validate alone, PR builds only", () => {
    expect(boundTo("tests-cannot-observe")).toEqual({ pr: ["pass-tests"], scan: [] });
    expect(boundTo("tests-cannot-observe-validate")).toEqual({ pr: [VALIDATE_PASS], scan: [] });
  });

  it("names every shape and the P2 severity, with the scenario", () => {
    const body = built().get("pass-tests--sol-med")!;
    expect(body).toContain("A test that cannot observe what it claims to test is a `P2` defect");
    for (const shape of [
      "patched to a no-op",
      "never joined or awaited",
      "a mock or fake replaces the very path the PR changed",
      "the setup omits the input the change uses",
      "Report each such test at `P2` with the concrete scenario",
    ])
      expect(body, shape).toContain(shape);
  });

  it("the validator may not downgrade it as 'not a production defect', and verifies by reading only", () => {
    const text = PASS_ADDENDA.find((a) => a.id === "tests-cannot-observe-validate")!.text;
    expect(text).toContain("is a defect in the PR at `P2`");
    expect(text).toContain("Do not downgrade it to `P3`, or kill it `below-bar`");
    expect(text).toContain("never by running it");
  });

  it("names no benchmark, project or PR", () => {
    for (const id of ["tests-cannot-observe", "tests-cannot-observe-validate"])
      expect(PASS_ADDENDA.find((a) => a.id === id)!.text, id).not.toMatch(
        /martian|golden|sentry|keycloak|grafana|cal\.com|discourse/i,
      );
  });
});
