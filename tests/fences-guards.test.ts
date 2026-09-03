// [T10] — guard coverage DERIVED from the call sites, never asserted
// in prose.
//
// [P2]: `scripts/CLAUDE.md` states which posting-time guards each
// posting script calls. It is a documentation claim about a SAFETY INVARIANT,
// which the inventory rightly calls the worst thing in this repo to let drift
// — and it had drifted: it omits guard 5 (the stale-head refusal) on
// both scripts that call it.
//
// The fix that lasts is not to correct the sentence; it is to make the
// sentence derivable, so the next drift fails a test instead of surviving a
// read. Nothing here is hand-maintained except the mapping's own liveness
// check: guard NUMBERS come from `guards.sh`'s own section headers, guard
// CALLS come from the scripts, and the claim comes from the doc.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const POSTING_SCRIPTS = ["post-review.sh", "approve-pr.sh", "reply-thread.sh"];

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/**
 * Functions in `guards.sh` that are NOT guards — plumbing the guards share,
 * plus the mark writer.
 *
 * `guard_stamp_reviewed_head` is the one that matters here, and it is why this
 * list is not an afterthought: it is DEFINED below the `# ---- guard 4:`
 * header, so the positional derivation below assigns it to guard 4, and
 * `post-review.sh` came out claiming a CI gate it does not have. It is guard
 * 2's mark WRITER — it runs after a successful post, not before one — and a
 * fence that mis-derives in the permissive direction is worse than none.
 */
const NOT_A_GUARD = new Set([
  "guard_enabled",
  "guard_token",
  "guard_api_get",
  "guard_read_pr",
  "guard_stamp_reviewed_head",
  // the evidence hook guard 2 calls on refusal. Defined by
  // post-review.sh (not guards.sh, so it sits under no header), it writes the
  // guarded-no-op record and gates nothing — the refusal is already decided
  // before it runs, and its failure never changes guard 2's answer.
  "guard_on_no_new_evidence",
]);

/**
 * function name → guard number, read out of `guards.sh`'s own section
 * headers (`# ---- guard N: … ----`). A function belongs to the guard whose
 * header it sits under, and to NO guard once a non-guard header intervenes.
 *
 * THAT SECOND CLAUSE IS THE WHOLE FENCE, and the first version of this
 * function did not have it. It set `current` on a guard header and never
 * cleared it, so every function below `guards.sh`'s
 * `# ---- the reviewed-head mark ----` header inherited guard 4. The symptom
 * was `guard_stamp_reviewed_head` — patched at the time with a hand-written
 * `NOT_A_GUARD` entry, which fixed the instance and left the mechanism.
 *
 * What that cost, demonstrated by an adversarial reviewer: add any function
 * at the end of `guards.sh`, call it from `approve-pr.sh` INSTEAD of
 * `guard_require_green_ci`, and the approval route stops gating on CI while
 * every test in this file passes — including the one that asserts
 * `approve-pr.sh` must contain guard 4. A fence mis-deriving in the
 * PERMISSIVE direction, which the header of this file calls worse than none,
 * being exactly that.
 *
 * Now: ANY `# ---- … ----` header resets the section, and only a guard header
 * opens one. A function outside every guard section is unnumbered, which
 * makes it a loud orphan in the test below unless it is named in
 * `NOT_A_GUARD` — so that list is now structural rather than a patch.
 */
function guardNumbers(): Map<string, number> {
  const out = new Map<string, number>();
  let current: number | undefined;
  for (const line of read("scripts/guards.sh").split("\n")) {
    const section = /^#\s*-{2,}/.test(line);
    if (section) {
      const guard = /^#\s*-+\s*guard\s+(\d+)\s*:/.exec(line);
      current = guard ? Number(guard[1]) : undefined;
      continue;
    }
    const fn = /^(guard_[a-z_]+)\(\)/.exec(line);
    if (fn && current !== undefined && !NOT_A_GUARD.has(fn[1]!)) out.set(fn[1]!, current);
  }
  return out;
}

/** The guard functions a script actually calls, in code (comments stripped). */
function guardCalls(script: string): string[] {
  const code = read(`scripts/${script}`)
    .split("\n")
    .map((l) => l.replace(/#.*$/, ""))
    .join("\n");
  return [...new Set([...code.matchAll(/\b(guard_[a-z_]+)\b/g)].map((m) => m[1]!))];
}

describe("[T10] guard coverage is derived from the call sites", () => {
  it("guards.sh's section headers actually number its functions", () => {
    const numbers = guardNumbers();
    // Five numbered guards exist (1-3, 4, 5). If the
    // header parse breaks, everything below silently checks nothing.
    expect(
      [...new Set(numbers.values())].sort(),
      "the guard-number parse found the wrong set of guards",
    ).toEqual([1, 2, 3, 4, 5]);
    expect(numbers.size).toBeGreaterThanOrEqual(5);
  });

  it("every guard function a posting script calls belongs to a numbered guard", () => {
    const numbers = guardNumbers();
    const orphans: string[] = [];
    for (const s of POSTING_SCRIPTS) {
      for (const fn of guardCalls(s)) {
        if (NOT_A_GUARD.has(fn) || numbers.has(fn)) continue;
        orphans.push(`${s} → ${fn}`);
      }
    }
    expect(
      orphans,
      "a posting script calls a guard function that sits under no `# ---- guard N:` header — " +
        "either it is plumbing (add it to NOT_A_GUARD with a reason) or it is an unnumbered guard nobody can document",
    ).toEqual([]);
  });

  /**
   * The derived truth, per script. This is the sentence `scripts/CLAUDE.md`
   * tries to state, computed instead.
   *
   * MUTATION: delete the `guard_require_green_ci` call from
   * scripts/approve-pr.sh — this fails, and so does the doc comparison below.
   */
  const derived = (): Record<string, number[]> => {
    const numbers = guardNumbers();
    const out: Record<string, number[]> = {};
    for (const s of POSTING_SCRIPTS) {
      out[s] = [
        ...new Set(
          guardCalls(s)
            .map((fn) => numbers.get(fn))
            .filter((n): n is number => n !== undefined),
        ),
      ].sort();
    }
    return out;
  };

  it("each posting script calls the guards its route needs", () => {
    expect(derived()).toEqual({
      // Posting a review: open (3), the head this round reviewed (5), new
      // evidence since the last mark (2), and the human-approval downgrade (1).
      "post-review.sh": [1, 2, 3, 5],
      // Approving: open (3), still the reviewed head (5), green CI (4).
      // Guard 2 is not needed — the review it approves went through
      // post-review.sh, which stamped the mark.
      "approve-pr.sh": [3, 4, 5],
      // A thread reply mutates no review: only "is the PR still there".
      "reply-thread.sh": [3],
    });
  });

  /**
   * The doc comparison — and the one divergence this fence RECORDS instead of
   * repairing.
   *
   * `scripts/CLAUDE.md` says "post-review.sh guards 1+2+3, approve-pr.sh 3+4,
   * reply-thread.sh 3". Guard 5 is missing from both scripts that call it.
   * That sentence is wrong today, and it is exactly [P2].
   *
   * It is NOT corrected here because this agent does not edit a CLAUDE.md on
   * an agent's instruction — that is a standing constraint on how this session
   * works, not a judgement about the fix, which is one line. So the divergence
   * is pinned in the self-retiring shape used elsewhere in these fences: the
   * test asserts the doc says EXACTLY the known-wrong thing, so a new drift
   * fails, AND correcting it fails too, forcing this block's deletion and the
   * assertion's flip to the direct comparison.
   *
   * MUTATION: change "approve-pr.sh 3+4" to "approve-pr.sh 3" in
   * scripts/CLAUDE.md — this fails.
   */
  it("the documented coverage is the recorded stale one ([P2])", () => {
    const KNOWN_STALE_DOC: Record<string, number[]> = {
      "post-review.sh": [1, 2, 3], // guard 5 missing
      "approve-pr.sh": [3, 4], //     guard 5 missing
      "reply-thread.sh": [3], //      correct
    };

    const doc = read("scripts/CLAUDE.md");
    const claimed: Record<string, number[]> = {};
    for (const s of POSTING_SCRIPTS) {
      const m = new RegExp(`${s.replace(".", "\\.")}\\s+(?:guards?\\s+)?([\\d+]+)`).exec(doc);
      expect(
        m?.[1],
        `scripts/CLAUDE.md no longer states coverage for ${s} in the shape this fence reads`,
      ).toBeTruthy();
      claimed[s] = m![1]!.split("+").map(Number).sort();
    }

    const real = derived();
    const agrees = POSTING_SCRIPTS.every(
      (s) => JSON.stringify(claimed[s]) === JSON.stringify(real[s]),
    );
    if (agrees) {
      throw new Error(
        "scripts/CLAUDE.md's guard-coverage sentence has been corrected — delete KNOWN_STALE_DOC and assert " +
          "`expect(claimed).toEqual(derived())` directly.",
      );
    }
    expect(
      claimed,
      "the documented guard coverage drifted to a THIRD value. It is a published claim about a safety invariant: " +
        `derive it from the call sites, which currently say ${JSON.stringify(real)}.`,
    ).toEqual(KNOWN_STALE_DOC);
  });

  /**
   * The other half of [P2], and the half with teeth: whatever the doc says,
   * a script that POSTS must call guard 3, and the script that APPROVES must
   * call guard 4. Those two are the invariants; the prose is only their
   * description.
   *
   * MUTATION: delete `guard_require_open` from scripts/reply-thread.sh — this
   * fails.
   */
  it("every posting script re-checks merged/closed, and only the approver gates on CI", () => {
    const real = derived();
    for (const s of POSTING_SCRIPTS) {
      expect(
        real[s],
        `${s} does not re-check that the PR is still open before mutating (guard 3)`,
      ).toContain(3);
    }
    expect(real["approve-pr.sh"], "the approval route must gate on green CI (guard 4)").toContain(
      4,
    );
    expect(
      real["reply-thread.sh"],
      "a thread reply is not a review and must not claim the head (guard 2)",
    ).not.toContain(2);
  });
});
