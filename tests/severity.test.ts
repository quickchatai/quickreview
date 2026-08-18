import { describe, expect, it } from "vitest";
import { deriveVerdict, postTag, type Severity } from "../src/severity.js";

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
