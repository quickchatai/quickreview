// The security family: the `pass-sec-*` lenses as one registered set. A
// member must be a known pass with an agent file, a lens field that names one
// must read as security however a session joined it, and every list that
// derives from the registry (the preset, the lesson ids, the planning table)
// must pick the members up without an edit of its own.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalLensIds } from "@quickchatai/pi-quickreview/src/lensids.js";
import { LENS_PLANNING } from "@quickchatai/pi-quickreview/src/lensplanning.js";
import {
  ALL_PASSES,
  CHAIN_PASS,
  CHAIN_STRATEGIES,
  DIFF_ONLY_LENSES,
  isSecurityLens,
  LENS_FAMILIES,
  SCAN_DEEP_LENSES,
  SECURITY_FAMILY,
} from "@quickchatai/pi-quickreview/src/passes.js";
import {
  parseReviewCommand,
  REVIEW_PRESETS,
  SECURITY_LENSES,
} from "@quickchatai/pi-quickreview/src/plugin/args.js";

const ROOT = join(import.meta.dirname, "..");

const FAMILY = [
  "pass-sec-authn-coverage",
  "pass-sec-access",
  "pass-sec-privesc",
  "pass-sec-iam",
  "pass-sec-tokens",
  "pass-sec-toctou",
  "pass-sec-injection",
  "pass-sec-boundaries",
  "pass-sec-secrets-data",
  "pass-sec-supply-chain",
  "pass-sec-llm",
  "pass-sec-infra",
  "pass-sec-variant",
  "pass-sec-exploit-chain",
];

describe("the security family", () => {
  // MUTATION: remove "pass-sec-iam" from SECURITY_FAMILY — this fails (the
  // member list, and the every-pass-sec-name check, both lose it).
  it("is the fourteen pass-sec-* lenses, in registry order, and every pass-sec-* name is a member", () => {
    expect([...SECURITY_FAMILY]).toEqual(FAMILY);
    expect([...SECURITY_FAMILY]).toEqual(ALL_PASSES.filter((p) => p.startsWith("pass-sec-")));
  });

  it("is not the general security lens nor bounds", () => {
    expect(SECURITY_FAMILY).not.toContain("pass-security");
    expect(SECURITY_FAMILY).not.toContain("pass-bounds");
  });

  // MUTATION: rename "pass-sec-llm" in SECURITY_FAMILY to "pass-sec-llms" —
  // this fails (no shipped agent file, no planning entry).
  it("every member is a known pass with a shipped agent file and a planning entry", () => {
    for (const lens of SECURITY_FAMILY) {
      expect(ALL_PASSES, lens).toContain(lens);
      expect(existsSync(join(ROOT, "agents", `${lens}.md`)), `agents/${lens}.md`).toBe(true);
      expect(LENS_PLANNING[lens]?.priority, lens).toBe("risk");
    }
  });

  it("sits in one block after the lint lens and before the validator", () => {
    const at = ALL_PASSES.indexOf(FAMILY[0]!);
    expect(ALL_PASSES[at - 1]).toBe("pass-lint-conformance");
    expect(ALL_PASSES.slice(at, at + FAMILY.length)).toEqual(FAMILY);
    expect(ALL_PASSES[at + FAMILY.length]).toBe("pass-validate");
  });

  // Membership is declared once: ALL_PASSES places the family by spreading
  // SECURITY_FAMILY, so passes.ts spells each member's name exactly once.
  // MUTATION: replace `...SECURITY_FAMILY,` in ALL_PASSES with the fourteen
  // names written out — this fails.
  it("is declared once: passes.ts names each member a single time", () => {
    const src = readFileSync(join(ROOT, "packages", "pi-plugin", "src", "passes.ts"), "utf8");
    // The chain lens is also CHAIN_PASS's value; the other thirteen decide.
    for (const lens of SECURITY_FAMILY.filter((l) => l !== CHAIN_PASS))
      expect(src.split(`"${lens}"`).length - 1, lens).toBe(1);
    expect(src).toContain("...SECURITY_FAMILY,");
  });

  // MUTATION: give LENS_FAMILIES.security its own copy of the list — this
  // fails (one list, never two).
  it("is the family table's security entry, by identity", () => {
    expect(LENS_FAMILIES.security).toBe(SECURITY_FAMILY);
  });

  it("names the chain lens and its four strategies", () => {
    expect(SECURITY_FAMILY).toContain(CHAIN_PASS);
    expect([...CHAIN_STRATEGIES]).toEqual(["delta", "forward", "backward", "compose"]);
  });

  // Chain delta and compose are PR-only by strategy, not by lens: every
  // member stays a deep lens a scan may run.
  it("every member is a scan deep lens", () => {
    for (const lens of SECURITY_FAMILY) {
      expect(DIFF_ONLY_LENSES, lens).not.toContain(lens);
      expect(SCAN_DEEP_LENSES, lens).toContain(lens);
    }
  });
});

describe("isSecurityLens — a recorded lens field", () => {
  // MUTATION: test only the first token of the field — the joined cases fail.
  it("reads a member however the session joined or suffixed it", () => {
    expect(isSecurityLens("pass-sec-access")).toBe(true);
    expect(isSecurityLens("pass-sec-access + pass-baseline")).toBe(true);
    expect(isSecurityLens("pass-baseline + pass-sec-access")).toBe(true);
    expect(isSecurityLens("pass-baseline,pass-sec-tokens")).toBe(true);
    expect(isSecurityLens("pass-sec-exploit-chain:delta")).toBe(true);
    expect(isSecurityLens("PASS-SEC-INJECTION (2 lenses)")).toBe(true);
  });

  // MUTATION: match on the "pass-sec" prefix instead of membership — the
  // unknown name fails.
  it("is false for a field naming no member", () => {
    expect(isSecurityLens("pass-security")).toBe(false);
    expect(isSecurityLens("pass-bounds + pass-baseline")).toBe(false);
    expect(isSecurityLens("pass-sec-unknown")).toBe(false);
    expect(isSecurityLens("recheck")).toBe(false);
    expect(isSecurityLens("")).toBe(false);
  });
});

describe("the family through the registry's readers", () => {
  it("canonicalLensIds reads a chain row's lens past its strategy", () => {
    expect(canonicalLensIds("pass-sec-exploit-chain:delta")).toEqual(["pass-sec-exploit-chain"]);
    for (const s of CHAIN_STRATEGIES)
      expect(canonicalLensIds(`pass-sec-exploit-chain:${s} + pass-sec-access`)).toEqual([
        "pass-sec-exploit-chain",
        "pass-sec-access",
      ]);
  });

  // MUTATION: restore the hand-written SECURITY_LENSES list (baseline,
  // security, data-safety, bounds, contracts) — this fails.
  it("the /qcr-review security preset keeps the family and the validator, and skips the rest", () => {
    expect([...SECURITY_LENSES]).toEqual([...SECURITY_FAMILY, "pass-validate"]);
    const lever = REVIEW_PRESETS.security.levers;
    expect(lever.startsWith("review.skip_lenses=")).toBe(true);
    const skipped = lever.slice("review.skip_lenses=".length).split("|");
    expect(skipped.sort()).toEqual(ALL_PASSES.filter((p) => !SECURITY_LENSES.includes(p)).sort());
    for (const general of ["pass-baseline", "pass-security", "pass-bounds", "pass-sweep"])
      expect(skipped).toContain(general);
  });

  // MUTATION: delete the "--security" case from parseReviewCommand — this
  // fails (it becomes an unknown flag).
  it("--security asks for a security review on top of any preset; without it nothing is set", () => {
    expect(parseReviewCommand("12 --security")).toMatchObject({
      preset: null,
      securityRequest: true,
      target: { kind: "pr", pr: "12" },
    });
    expect(parseReviewCommand("quick --security")).toMatchObject({
      preset: "quick",
      securityRequest: true,
    });
    expect(parseReviewCommand("12")).not.toHaveProperty("securityRequest");
    expect(parseReviewCommand("security 12")).not.toHaveProperty("securityRequest");
  });
});
