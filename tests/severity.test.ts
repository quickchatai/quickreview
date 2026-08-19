import { describe, expect, it } from "vitest";
import {
  deriveVerdict,
  isFirstPartyDirectiveInjection,
  isFirstPartyDirectivePath,
  normalizeReachability,
  postTag,
  type Reachability,
  type Severity,
} from "../src/severity.js";

describe("postTag", () => {
  it("always blocks on P0/P1 regardless of confidence", () => {
    for (const sev of ["P0", "P1"] as Severity[]) {
      expect(postTag(sev, 0)).toBe("blocker");
      expect(postTag(sev, 1)).toBe("blocker");
    }
  });

  it("blocks on P2 only at confidence >= 0.8", () => {
    expect(postTag("P2", 0.8)).toBe("blocker");
    expect(postTag("P2", 0.95)).toBe("blocker");
    expect(postTag("P2", 0.79)).toBe("question");
    expect(postTag("P2", 0)).toBe("question");
  });

  it("never blocks on P3 or nit", () => {
    expect(postTag("P3", 1)).toBe("question");
    expect(postTag("nit", 1)).toBe("nit");
  });
});

describe("reachability gate", () => {
  it("contrived never blocks, at any severity or confidence", () => {
    for (const sev of ["P0", "P1", "P2", "P3"] as Severity[]) {
      expect(postTag(sev, 1, "contrived")).toBe("question");
      expect(postTag(sev, 0, "contrived")).toBe("question");
    }
    // A nit stays a nit — demoting it to a question would be a promotion.
    expect(postTag("nit", 1, "contrived")).toBe("nit");
  });

  it("plausible blocks on P0/P1 and turns P2 into a question", () => {
    expect(postTag("P0", 0.4, "plausible")).toBe("blocker");
    expect(postTag("P1", 1, "plausible")).toBe("blocker");
    expect(postTag("P2", 0.99, "plausible")).toBe("question");
    expect(postTag("P3", 1, "plausible")).toBe("question");
    expect(postTag("nit", 1, "plausible")).toBe("nit");
  });

  it("routine — and an absent or unknown value — leaves the old mapping untouched", () => {
    for (const sev of ["P0", "P1", "P2", "P3", "nit"] as Severity[]) {
      for (const conf of [0, 0.79, 0.8, 1]) {
        const base = postTag(sev, conf);
        expect(postTag(sev, conf, "routine")).toBe(base);
        expect(postTag(sev, conf, undefined)).toBe(base);
        expect(postTag(sev, conf, null)).toBe(base);
        // A pass that writes garbage must not be able to soften a blocker.
        expect(postTag(sev, conf, "whenever" as Reachability)).toBe(base);
      }
    }
    expect(normalizeReachability("plausible")).toBe("plausible");
    expect(normalizeReachability("")).toBe("routine");
    expect(normalizeReachability(undefined)).toBe("routine");
  });

  it("REGRESSION: the blocker bar did not move — known-good blockers still block", () => {
    // The three cases the retrospective names as must-still-block. All
    // three are `routine`: the triggering state arises in normal operation.
    const knownGood = [
      { name: "cross-tenant IDOR", severity: "P0" as Severity, confidence: 0.9 },
      { name: "database alias break under rolling deploy", severity: "P0" as Severity, confidence: 0.85 },
      { name: "PII exposure", severity: "P1" as Severity, confidence: 0.8 },
    ];
    for (const c of knownGood) {
      expect(postTag(c.severity, c.confidence, "routine"), c.name).toBe("blocker");
      expect(deriveVerdict({ hasBlockers: true, needsHuman: false }), c.name).toBe("REQUEST_CHANGES");
    }
    // And a high-confidence routine P2 still blocks exactly as before.
    expect(postTag("P2", 0.9, "routine")).toBe("blocker");
  });
});

describe("first-party directive gate", () => {
  it("recognizes the reviewed repo's own agent-directive paths", () => {
    for (const p of [
      ".claude/skills/user-journey-analysis/SKILL.md", // the #5306 false positive
      ".claude/settings.json",
      "prompts/round-first.md",
      "CLAUDE.md",
      "AGENTS.md",
      "backend/AGENTS.md",
      "src/deep/CLAUDE.md",
      ".cursorrules",
      ".cursor/rules/style.mdc",
      ".github/copilot-instructions.md",
    ]) {
      expect(isFirstPartyDirectivePath(p), p).toBe(true);
    }
  });

  it("does NOT match ordinary code, nested prompts dirs, or vendored trees", () => {
    for (const p of [
      "src/app.py",
      "docs/prompts.md",
      "backend/prompts/system.md", // prompts/** binds at the repo root only
      "README.md",
      "node_modules/pkg/CLAUDE.md",
      "vendor/tool/.claude/skills/x.md",
      "third_party/agents/AGENTS.md",
      "",
    ]) {
      expect(isFirstPartyDirectivePath(p), p || "(empty)").toBe(false);
    }
    expect(isFirstPartyDirectivePath(undefined)).toBe(false);
    expect(isFirstPartyDirectivePath(null)).toBe(false);
  });

  it("gates only injection-kind findings", () => {
    expect(isFirstPartyDirectiveInjection("injection", ".claude/skills/x/SKILL.md")).toBe(true);
    expect(isFirstPartyDirectiveInjection("Injection", "CLAUDE.md")).toBe(true);
    expect(isFirstPartyDirectiveInjection("security", ".claude/skills/x/SKILL.md")).toBe(false);
    expect(isFirstPartyDirectiveInjection(undefined, ".claude/skills/x/SKILL.md")).toBe(false);
    expect(isFirstPartyDirectiveInjection("injection", "src/app.py")).toBe(false);
    expect(isFirstPartyDirectiveInjection("injection", "node_modules/pkg/CLAUDE.md")).toBe(false);
  });

  it("an injection finding on a first-party directive path never blocks, at any severity", () => {
    const ctx = { kind: "injection", path: ".claude/skills/x/SKILL.md" };
    for (const sev of ["P0", "P1", "P2", "P3"] as Severity[]) {
      expect(postTag(sev, 1, "routine", ctx)).toBe("question");
      expect(postTag(sev, 0.5, undefined, ctx)).toBe("question");
    }
    expect(postTag("nit", 1, "routine", ctx)).toBe("nit");
  });

  it("keeps the P1 bright line for third-party/vendored and non-directive paths", () => {
    expect(postTag("P1", 1, "routine", { kind: "injection", path: "src/app.py" })).toBe("blocker");
    expect(postTag("P1", 1, "routine", { kind: "injection", path: "node_modules/pkg/CLAUDE.md" })).toBe("blocker");
    expect(postTag("P1", 1, "routine", { kind: "injection", path: "vendor/x/.claude/y.md" })).toBe("blocker");
  });

  it("leaves every non-injection finding on a directive path untouched", () => {
    const ctx = { kind: "security", path: ".claude/skills/x/SKILL.md" };
    expect(postTag("P1", 1, "routine", ctx)).toBe("blocker");
    expect(postTag("P2", 0.9, "routine", { path: ".claude/skills/x/SKILL.md" })).toBe("blocker");
  });

  it("routes the verdict to NEEDS_HUMAN — never REQUEST_CHANGES — and a real blocker elsewhere still wins", () => {
    expect(deriveVerdict({ hasBlockers: false, needsHuman: false, firstPartyDirectiveInjection: true })).toBe("NEEDS_HUMAN");
    expect(deriveVerdict({ hasBlockers: false, needsHuman: true, firstPartyDirectiveInjection: true })).toBe("NEEDS_HUMAN");
    // The park never softens a genuine blocker on another surface.
    expect(deriveVerdict({ hasBlockers: true, needsHuman: false, firstPartyDirectiveInjection: true })).toBe("REQUEST_CHANGES");
    // Absent flag: legacy behaviour exactly.
    expect(deriveVerdict({ hasBlockers: false, needsHuman: false })).toBe("APPROVE");
  });
});

describe("deriveVerdict", () => {
  it("requests changes whenever a blocker exists, even when the session is unsure", () => {
    expect(deriveVerdict({ hasBlockers: true, needsHuman: false })).toBe("REQUEST_CHANGES");
    expect(deriveVerdict({ hasBlockers: true, needsHuman: true })).toBe("REQUEST_CHANGES");
  });

  it("parks only on the session's own judgment — there are no daemon criteria left", () => {
    expect(deriveVerdict({ hasBlockers: false, needsHuman: true })).toBe("NEEDS_HUMAN");
  });

  it("approves a clean, unremarkable PR", () => {
    expect(deriveVerdict({ hasBlockers: false, needsHuman: false })).toBe("APPROVE");
  });
});
