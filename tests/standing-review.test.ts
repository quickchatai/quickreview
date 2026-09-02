// the ONE reading of a reviewed-head mark.
//
// PR #5409 round 18 (2026-09-01): the shell had stamped `posted_event =
// REQUEST_CHANGES` at the head, the watcher never enriched `verdict`, and
// dispatch — reading `verdict` alone — saw nothing standing and paid $1.92 for a
// round whose review posting guard 2 (which reads head + reply only) then
// refused. Two readers of one row, two answers. The first half of this file
// pins the interpretation; the second half pins that nothing else reads the
// row's verdict directly, so the split cannot silently return.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewedHeadRow } from "../src/state.js";
import { snapshotMark, standingLifecycleState, standingReview, standingVerdict } from "../src/standing-review.js";

const HEAD = "a746573675f8eae0f13e69ad83006190aa8436e4";

const mark = (over: Partial<ReviewedHeadRow> = {}): ReviewedHeadRow => ({
  pr: 5409,
  head_sha: HEAD,
  reviewed_at: "2026-09-01T10:41:34.773Z",
  verdict: null,
  posted_event: null,
  round_no: null,
  last_author_reply_at: null,
  ...over,
});

describe("standingReview — one interpretation of the reviewed-head mark", () => {
  it("no mark ⇒ nothing stands", () => {
    expect(standingReview(undefined)).toEqual({ kind: "none" });
    expect(standingVerdict(undefined)).toBeNull();
  });

  it("the #5409 partial mark — posted REQUEST_CHANGES, verdict null — IS a standing REQUEST_CHANGES", () => {
    const m = mark({ posted_event: "REQUEST_CHANGES" });
    expect(standingReview(m)).toEqual({ kind: "decided", verdict: "REQUEST_CHANGES", source: "posted_event" });
    expect(standingVerdict(m)).toBe("REQUEST_CHANGES");
    expect(standingLifecycleState(standingVerdict(m))).toBe("awaiting_author");
  });

  it("the symmetric partial APPROVE mark is a standing approval", () => {
    const m = mark({ posted_event: "APPROVE" });
    expect(standingReview(m)).toEqual({ kind: "decided", verdict: "APPROVE", source: "posted_event" });
    expect(standingLifecycleState(standingVerdict(m))).toBe("tracked");
  });

  it("a decided verdict wins over posted_event — the enriched guard-1 downgrade and the withheld approval both read right", () => {
    // REQUEST_CHANGES softened to a COMMENT by guard 1, then enriched.
    expect(standingReview(mark({ verdict: "REQUEST_CHANGES", posted_event: "COMMENT", round_no: 3 })))
      .toEqual({ kind: "decided", verdict: "REQUEST_CHANGES", source: "verdict" });
    // APPROVE withheld for red CI (posted as COMMENT), then enriched.
    expect(standingReview(mark({ verdict: "APPROVE", posted_event: "COMMENT", round_no: 3 })))
      .toEqual({ kind: "decided", verdict: "APPROVE", source: "verdict" });
    // Verdict casing is normalized like everywhere else.
    expect(standingVerdict(mark({ verdict: " approve " }))).toBe("APPROVE");
  });

  it("NEEDS_HUMAN and the retired ESCALATE spelling are UNDECIDED, even beside a posted REQUEST_CHANGES (carve-out)", () => {
    for (const verdict of ["NEEDS_HUMAN", "ESCALATE", "escalate"]) {
      const m = mark({ verdict, posted_event: "REQUEST_CHANGES", round_no: 2 });
      expect(standingReview(m)).toEqual({ kind: "undecided" });
      expect(standingVerdict(m)).toBeNull();
    }
  });

  it("COMMENT alone, a bare stamp, or a mis-cased posted event is never guessed into a verdict", () => {
    expect(standingReview(mark({ posted_event: "COMMENT" }))).toEqual({ kind: "unknown", posted_event: "COMMENT" });
    expect(standingReview(mark())).toEqual({ kind: "unknown", posted_event: null });
    // Both writers stamp the upper-case GitHub event; anything else is a
    // lookalike, not proof (tests/operator-recovery.test.ts pins the same).
    expect(standingReview(mark({ posted_event: "request_changes" }))).toEqual({ kind: "unknown", posted_event: "request_changes" });
    expect(standingVerdict(mark({ verdict: "MAYBE", posted_event: "COMMENT" }))).toBeNull();
    expect(standingLifecycleState(null)).toBe("tracked");
  });

  it("snapshotMark records exactly the fields a restore needs and nothing session-written", () => {
    expect(snapshotMark(mark({ posted_event: "REQUEST_CHANGES", last_author_reply_at: "2026-09-01T09:00:00.000Z" }))).toEqual({
      head_sha: HEAD,
      reviewed_at: "2026-09-01T10:41:34.773Z",
      verdict: null,
      posted_event: "REQUEST_CHANGES",
      round_no: null,
      last_author_reply_at: "2026-09-01T09:00:00.000Z",
    });
  });
});

// ---- the structural fence --------------------------------------------------

const ROOT = resolve(process.cwd());

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** A direct read of `.verdict` off something that is a reviewed-head mark. The
 * identifier list is what the codebase calls the row today; a new spelling that
 * dodges it is caught by the consumer table below, which demands the import. */
const RAW_MARK_VERDICT = /(?:reviewedHead\([^)]*\)|\b(?:mark|reviewed|prev))\s*!?\??\.\s*verdict\b/g;

/**
 * The lifecycle consumers of the mark, and the raw reads each is allowed to
 * keep. `state.ts` writes the row (recordReviewedHead's carry-forward) and
 * repairs one legacy shape (repairMigrationPrecheckReviewedHead's
 * null-verdict test) — both are about the row's storage, not its meaning.
 * Everything else reads through standing-review.ts. Add a consumer here when
 * you add one; never widen an allowance to make a new raw read pass.
 */
const CONSUMERS: ReadonlyArray<{ file: string; rawReadsAllowed: number }> = [
  { file: "src/dispatch.ts", rawReadsAllowed: 0 },
  { file: "src/guards.ts", rawReadsAllowed: 0 },
  { file: "src/recheck.ts", rawReadsAllowed: 0 },
  { file: "src/reconcile.ts", rawReadsAllowed: 0 },
  { file: "src/verdicts.ts", rawReadsAllowed: 0 },
  { file: "src/state.ts", rawReadsAllowed: 3 },
  { file: "src/posting-receipt.ts", rawReadsAllowed: 0 },
];

describe("every lifecycle consumer reads the mark through standing-review (fence)", () => {
  it("each named consumer imports the helper", () => {
    for (const { file } of CONSUMERS) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, `${file} must import from ./standing-review.js`).toMatch(/from "\.\/standing-review\.js"/);
    }
  });

  it("no src module reads `.verdict` off a reviewed-head mark directly", () => {
    const allowed = new Map(CONSUMERS.map((c) => [c.file, c.rawReadsAllowed]));
    const offenders: string[] = [];
    for (const path of tsFiles(join(ROOT, "src"))) {
      const rel = path.slice(ROOT.length + 1);
      if (rel === "src/standing-review.ts") continue;
      const text = readFileSync(path, "utf8");
      const hits = [...text.matchAll(RAW_MARK_VERDICT)];
      const budget = allowed.get(rel) ?? 0;
      if (hits.length > budget) {
        offenders.push(`${rel}: ${hits.length} raw mark.verdict read(s), ${budget} allowed — read it through standingReview/standingVerdict`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the state.ts allowance is exact, so a retired raw read lowers it rather than leaving slack", () => {
    const text = readFileSync(join(ROOT, "src/state.ts"), "utf8");
    expect([...text.matchAll(RAW_MARK_VERDICT)]).toHaveLength(CONSUMERS.find((c) => c.file === "src/state.ts")!.rawReadsAllowed);
  });
});
