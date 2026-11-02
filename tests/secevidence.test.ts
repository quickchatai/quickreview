// A security candidate's outcome and severity are fixed functions of what the
// validator and the lens wrote: the chain's hop labels compute the outcome
// (packages/pi-plugin/src/secevidence.ts), and impact × exposure computes the
// severity (severity.ts `securitySeverity`). Both tables are stated in a
// prompt as well, so each is pinned against its prompt here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPartialChain,
  normalizeHopLabel,
  normalizeSecurityOutcome,
  readHopLabels,
  securityOutcome,
} from "@quickchatai/pi-quickreview/src/secevidence.js";
import {
  isSecurityFinding,
  securitySeverity,
  SECURITY_EXPOSURES,
  type SecurityImpact,
} from "@quickchatai/pi-quickreview/src/severity.js";
import { DOUBT_WORDS } from "@quickchatai/pi-quickreview/src/doubtwords.js";
import { VALIDATE_SEC_EVIDENCE_ADDENDUM } from "@quickchatai/pi-quickreview/src/include.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";

const ROOT = join(import.meta.dirname, "..");

describe("securityOutcome — the chain's outcome table", () => {
  // MUTATION: return "question" for two plausible hops — fails.
  it.each([
    [["valid", "valid", "valid"], "confirmed"],
    [["valid", "plausible", "valid"], "question"],
    [["plausible", "valid", "plausible"], "partial-chain"],
    [["plausible", "plausible", "plausible"], "partial-chain"],
    [["valid", "contradicted"], "refuted"],
    [["plausible", "plausible", "contradicted"], "refuted"],
    [["valid"], "confirmed"],
  ] as const)("%j → %s", (labels, outcome) => {
    expect(securityOutcome(labels)).toBe(outcome);
  });

  it("is unknown with no labels or a label outside the closed set — never a hop that held", () => {
    expect(securityOutcome([])).toBe("unknown");
    expect(securityOutcome(["valid", "probably"])).toBe("unknown");
  });

  it("reads labels in any case and spacing", () => {
    expect(securityOutcome([" Valid ", "PLAUSIBLE"])).toBe("question");
    expect(normalizeHopLabel("Contradicted")).toBe("contradicted");
    expect(normalizeHopLabel("refuted")).toBeNull();
  });

  it("matches the validator's table in the evidence addendum, row for row", () => {
    const rows: Array<[string, string]> = [
      ["every hop valid", "survives"],
      [
        "exactly one plausible, none contradicted",
        "DOUBTED with the word `unverifiable`, naming that hop",
      ],
      ["two or more plausible, none contradicted", "DOUBTED with the word `partial-chain`"],
      ["any hop contradicted", "`refuted`, citing the hop"],
    ];
    for (const [labels, outcome] of rows)
      expect(VALIDATE_SEC_EVIDENCE_ADDENDUM).toContain(`| ${labels} | ${outcome} |`);
  });
});

describe("a hop resting on a lead", () => {
  // A lead that survived only as a question is not a proven hop: labelling
  // its hop valid would let an all-valid label set compute `confirmed`.
  // MUTATION: drop "**confirmed**" from the lead-hop sentence in
  // VALIDATE_SEC_EVIDENCE_ADDENDUM — this fails.
  it("is valid only when the lead survived confirmed, plausible when it survived only as a question", () => {
    expect(VALIDATE_SEC_EVIDENCE_ADDENDUM).toContain(
      "A hop that rests on a lead is valid only when that lead survived you **confirmed** (`security_outcome: confirmed`, every evidence line valid); plausible when it survived only as a question, went under DOUBTED, or you could not judge it; contradicted when you refuted it.",
    );
    // and such a hop moves the chain off `confirmed`
    expect(securityOutcome(["valid", "plausible", "valid"])).toBe("question");
  });
});

describe("the outcome a session writes", () => {
  it("folds known spellings onto the closed set and refuses the rest", () => {
    expect(normalizeSecurityOutcome("Confirmed")).toBe("confirmed");
    expect(normalizeSecurityOutcome("partial chain")).toBe("partial-chain");
    expect(normalizeSecurityOutcome("survives")).toBe("confirmed");
    expect(normalizeSecurityOutcome("excluded")).toBe("excluded");
    expect(normalizeSecurityOutcome("maybe")).toBeNull();
    expect(normalizeSecurityOutcome(3)).toBeNull();
  });

  it("reads hop labels from an array or one comma-separated string", () => {
    expect(readHopLabels(["Valid", " plausible "])).toEqual(["valid", "plausible"]);
    expect(readHopLabels("[valid, plausible]")).toEqual(["valid", "plausible"]);
    expect(readHopLabels([])).toBeNull();
    expect(readHopLabels(undefined)).toBeNull();
  });

  it("knows a partial chain by its kind, its word or its outcome", () => {
    expect(isPartialChain({ kind: "partial-chain" })).toBe(true);
    expect(isPartialChain({ kind: "partial-chain:idor-to-admin" })).toBe(true);
    expect(isPartialChain({ word: "partial-chain" })).toBe(true);
    expect(isPartialChain({ security_outcome: "partial chain" })).toBe(true);
    expect(isPartialChain({ kind: "exploit-chain" })).toBe(false);
    expect(isPartialChain({ kind: "partial-chainsaw" })).toBe(false);
  });

  it("partial-chain is a doubt word: a killed partial chain is kept as doubted", () => {
    expect(DOUBT_WORDS).toContain("partial-chain");
  });
});

describe("securitySeverity — the family's impact × exposure matrix", () => {
  // The table as prompts/pass-sec-common.md states it, parsed, so the prompt
  // and the code cannot drift.
  // MUTATION: make B × remote-auth "P3" in SECURITY_MATRIX — fails.
  it("is the shared prompt's table, cell for cell", () => {
    const text = readFileSync(join(ROOT, "prompts/pass-sec-common.md"), "utf8");
    const rows = text
      .split("\n")
      .filter((l) => /^\| [ABC] \|/.test(l))
      .map((l) =>
        l
          .split("|")
          .map((c) => c.trim())
          .filter((c) => c !== ""),
      );
    expect(rows.map((r) => r[0])).toEqual(["A", "B", "C"]);
    for (const [impact, ...cells] of rows) {
      expect(cells).toHaveLength(SECURITY_EXPOSURES.length);
      SECURITY_EXPOSURES.forEach((exposure, i) =>
        expect(
          securitySeverity(impact as SecurityImpact, exposure),
          `${impact} × ${exposure}`,
        ).toBe(cells[i]),
      );
    }
  });

  it("never reads likelihood: the most exposed impact-A finding is P0", () => {
    expect(securitySeverity("A", "remote-unauth")).toBe("P0");
    expect(securitySeverity("C", "local")).toBe("excluded");
  });
});

describe("isSecurityFinding", () => {
  it("is true for every family lens, pass-security, and a security kind", () => {
    for (const lens of SECURITY_FAMILY) expect(isSecurityFinding(null, lens), lens).toBe(true);
    expect(isSecurityFinding(null, "pass-security")).toBe(true);
    expect(isSecurityFinding(null, "pass-baseline + pass-security")).toBe(true);
    expect(isSecurityFinding(null, "pass-sec-exploit-chain:delta")).toBe(true);
    expect(isSecurityFinding("security:idor", "pass-baseline")).toBe(true);
    expect(isSecurityFinding("exploit-chain", null)).toBe(true);
    expect(isSecurityFinding("partial-chain", null)).toBe(true);
  });

  it("is false for other lenses and kinds", () => {
    expect(isSecurityFinding(null, "pass-baseline")).toBe(false);
    expect(isSecurityFinding("injection", "pass-tests")).toBe(false);
    expect(isSecurityFinding("securityish", "pass-tests")).toBe(false);
    expect(isSecurityFinding(null, "pass-security-review")).toBe(false);
    expect(isSecurityFinding(undefined, undefined)).toBe(false);
  });
});
