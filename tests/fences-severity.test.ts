// the FULL (severity × confidence × reachability) matrix
// (audit assertion #16).
//
// The reachability axis is the one mechanism in this system that touches the
// blocker bar, and the ratified decision it implements is absolute: it exists
// to stop UNREACHABLE findings blocking, NEVER to reduce blockers. The audit
// called the existing coverage "the model for the rest", and it nearly is —
// three tests over three partial slices (contrived at two confidences,
// plausible at five spot checks, routine at four). No single test walks the
// cross-product, so a rule added for one (severity, confidence) pair could
// weaken another and be met by a green suite.
//
// This walks all 5 × 4 × 4 combinations — including reachability values the
// union does not name, because a misbehaving pass can invent one and
// `normalizeReachability` folds it to `routine`.
import { describe, expect, it } from "vitest";
import { postTag, REACHABILITY_VALUES, type Reachability, type Severity } from "../src/severity.js";

const SEVERITIES: Severity[] = ["P0", "P1", "P2", "P3", "nit"];
const CONFIDENCES = [0, 0.5, 0.79, 0.8, 1];
/** The three declared values, plus the two shapes a pass can actually emit. */
const REACHABILITIES = [...REACHABILITY_VALUES, undefined, null, "banana" as Reachability];

describe("the reachability gate over the whole matrix", () => {
  it("the axis walks every declared value — the union has not grown behind this test", () => {
    expect([...REACHABILITY_VALUES]).toEqual(["routine", "plausible", "contrived"]);
  });

  /**
   * THE BAR NEVER MOVES. For every cell, the tag with a reachability applied
   * is never STRONGER than the tag the base mapping gives — that is what
   * "demotes and never suppresses, and never promotes" means, stated over the
   * whole space instead of a slice.
   *
   * MUTATION: change `if (reach === "plausible" && severity === "P2")` to
   * `severity === "P1"` in src/severity.ts — this fails, because a P1 that
   * would have blocked now returns a question at a reachability that is not
   * `contrived`… and the contrived-only rule below fails too.
   */
  const RANK: Record<string, number> = { nit: 0, question: 1, blocker: 2 };

  it("no (severity, confidence, reachability) cell is ever stronger than its base", () => {
    for (const s of SEVERITIES) {
      for (const c of CONFIDENCES) {
        const base = postTag(s, c, "routine");
        for (const r of REACHABILITIES) {
          const got = postTag(s, c, r);
          expect(
            RANK[got]!,
            `postTag(${s}, ${c}, ${String(r)}) = ${got} is STRONGER than the routine base ${base}. `
              + "The reachability axis exists to stop unreachable findings blocking — never to change the bar.",
          ).toBeLessThanOrEqual(RANK[base]!);
        }
      }
    }
  });

  it("every cell returns one of the three tags — there is no drop path", () => {
    for (const s of SEVERITIES) {
      for (const c of CONFIDENCES) {
        for (const r of REACHABILITIES) {
          expect(["blocker", "question", "nit"], `postTag(${s}, ${c}, ${String(r)})`).toContain(postTag(s, c, r));
        }
      }
    }
  });

  /**
   * `contrived` never blocks, at any severity or confidence — and a nit stays
   * a nit, because demoting a nit to a question would be a PROMOTION.
   */
  it("contrived never blocks, and never promotes a nit", () => {
    for (const s of SEVERITIES) {
      for (const c of CONFIDENCES) {
        expect(postTag(s, c, "contrived"), `${s} @ ${c}`).toBe(s === "nit" ? "nit" : "question");
      }
    }
  });

  /**
   * `plausible` moves P2 ONLY. P0/P1 still block; P3 and nit are untouched.
   * This is the cell the audit's spot checks covered one confidence at a time.
   */
  it("plausible moves P2 and nothing else, at every confidence", () => {
    for (const c of CONFIDENCES) {
      expect(postTag("P0", c, "plausible"), `P0 @ ${c}`).toBe("blocker");
      expect(postTag("P1", c, "plausible"), `P1 @ ${c}`).toBe("blocker");
      expect(postTag("P2", c, "plausible"), `P2 @ ${c}`).toBe("question");
      expect(postTag("P3", c, "plausible"), `P3 @ ${c}`).toBe("question");
      expect(postTag("nit", c, "plausible"), `nit @ ${c}`).toBe("nit");
    }
  });

  /**
   * Anything unrecognised — including a garbage string a misbehaving pass
   * invents — folds to `routine`, i.e. the base mapping is untouched. The
   * failure mode this forbids is a typo in a pass's output silently demoting
   * a real blocker.
   */
  it("an absent, null or invented reachability leaves the base mapping exactly as it is", () => {
    for (const s of SEVERITIES) {
      for (const c of CONFIDENCES) {
        const base = postTag(s, c, "routine");
        for (const r of [undefined, null, "banana" as Reachability, "" as Reachability, "ROUTINE" as Reachability]) {
          expect(postTag(s, c, r), `postTag(${s}, ${c}, ${String(r)})`).toBe(base);
        }
      }
    }
  });

  /**
   * The confidence boundary, pinned exactly: P2 blocks at ≥ 0.8 and asks
   * below it. Off-by-one here moves the bar in the direction the ratified
   * decision forbids.
   */
  it("P2's confidence boundary is exactly 0.8", () => {
    expect(postTag("P2", 0.79, "routine")).toBe("question");
    expect(postTag("P2", 0.8, "routine")).toBe("blocker");
    expect(postTag("P2", 0.8, "plausible")).toBe("question");
    expect(postTag("P2", 0.8, "contrived")).toBe("question");
  });
});
