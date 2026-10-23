// The regression case set. Everything here is offline: the case set is a
// committed fixture extracted from the review corpus, the replay is
// injected, and no test executes reviewed code (scoping rule 2).
//
// Four properties are pinned because they are the design, not the code:
//   1. selection reads SUBSTANCE and never the GitHub verdict;
//   2. a failure is an investigation with a recommendation, never a veto;
//   3. dry-run is asserted by this module's own code, and an open or
//      contaminated case is refused outright;
//   4. the module cannot reach the live daemon.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CONTAMINATION_CUTOFF,
  QUALIFYING_RUNG,
  ReplayRefused,
  assertReplaySafe,
  classifySubstance,
  findingTheme,
  matchFinding,
  parseCaseSet,
  qualifyFinding,
  renderInvestigation,
  runRegression,
  scoreCase,
  selectCases,
  type CandidateReview,
  type RegressionCase,
  type SandboxFinding,
} from "../src/regression.js";

const here = dirname(fileURLToPath(import.meta.url));
const SET_PATH = join(here, "fixtures", "regression-cases.json");
const SRC_PATH = join(here, "..", "src", "regression.ts");
const set = parseCaseSet(JSON.parse(readFileSync(SET_PATH, "utf8")));

const DRY = { isDryRun: true };
const LIVE = { isDryRun: false };

function candidate(over: Partial<CandidateReview> = {}): CandidateReview {
  return {
    pr: 100,
    reviewer: "alice",
    submittedAt: "2025-01-01T00:00:00Z",
    state: "CHANGES_REQUESTED",
    prState: "MERGED",
    headSha: "abc",
    changedFiles: 4,
    churn: 120,
    findings: [
      {
        path: "api/handler.py",
        line: 10,
        text: "This will throw when `token` is None, because validate() dereferences it before the guard.",
        resolved: true,
        gotReply: true,
      },
      {
        path: "api/handler.py",
        line: 40,
        text: "I would suggest extracting the retry loop into a helper instead of inlining it here.",
        resolved: true,
        gotReply: false,
      },
    ],
    ...over,
  };
}

describe("the substance instrument", () => {
  it("puts remarks on the bottom rungs and arguments on the top", () => {
    expect(classifySubstance("nit", "nit").rung).toBe(0);
    expect(classifySubstance("ditto", "ditto").rung).toBe(0);
    expect(classifySubstance("rename this to userId", "rename this to userId").rung).toBe(1);
    const pointed =
      "Does this handle the empty scenario list at all, or does the caller already filter it out before we get here?";
    expect(classifySubstance(pointed, pointed).rung).toBe(2);
    expect(
      classifySubstance(
        "This will break when the list is empty.",
        "This will break when the list is empty.",
      ).rung,
    ).toBe(3);
    const argued =
      "This will break for an empty scenario list, because `first()` returns None and the caller dereferences it straight away. We already hit this in the importer. Suggest guarding:\n```py\nif not scenarios: return []\n```";
    expect(classifySubstance(argued, argued.replace(/```[\s\S]*```/, "")).rung).toBe(4);
  });

  it("keeps machine-authored, non-English and off-PR findings out", () => {
    expect(
      qualifyFinding({ text: "[blocker] this will break because the list is empty" }).reason,
    ).toBe("machine-authored (bot grammar)");
    expect(
      qualifyFinding({ text: "To nie zadziała, bo lista jest pusta i trzeba to zmienić" }).reason,
    ).toBe("not English");
    expect(
      qualifyFinding({ text: "As we discussed, this will break because the cache is cold" }).reason,
    ).toBe("evidence is not in the PR");
    expect(qualifyFinding({ text: "typo" }).reason).toContain("L0");
    expect(
      qualifyFinding({ text: "This will break because `first()` returns None here." }).ok,
    ).toBe(true);
  });
});

describe("selection is a substance filter, not a verdict filter", () => {
  // The property, stated as a test: the corpus's block rate is one reviewer's
  // habit, so if the verdict were touching selection at all, flipping every
  // verdict would move the set.
  it("selects identically when every GitHub verdict is flipped", () => {
    const pool = [
      candidate(),
      candidate({ pr: 101, reviewer: "bob" }),
      candidate({ pr: 102, reviewer: "cara" }),
    ];
    const asBlocked = selectCases(pool.map((c) => ({ ...c, state: "CHANGES_REQUESTED" })));
    const asApproved = selectCases(pool.map((c) => ({ ...c, state: "APPROVED" })));
    const asCommented = selectCases(pool.map((c) => ({ ...c, state: "COMMENTED" })));
    const ids = (r: { cases: RegressionCase[] }) => r.cases.map((c) => c.id);
    expect(ids(asBlocked)).toHaveLength(3);
    expect(ids(asApproved)).toEqual(ids(asBlocked));
    expect(ids(asCommented)).toEqual(ids(asBlocked));
  });

  it("drops a review whose findings are all remarks, however hard it blocked", () => {
    const nits = candidate({
      state: "CHANGES_REQUESTED",
      findings: [
        { path: "a.py", line: 1, text: "nit", resolved: true, gotReply: false },
        { path: "a.py", line: 2, text: "typo", resolved: true, gotReply: false },
        { path: "a.py", line: 3, text: "ditto", resolved: true, gotReply: false },
      ],
    });
    const r = selectCases([nits]);
    expect(r.cases).toHaveLength(0);
    expect(r.rejected[0]!.reason).toContain("substance bar");
  });

  it("keeps an APPROVED review that carries real substance", () => {
    const r = selectCases([candidate({ state: "APPROVED" })]);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]!.state).toBe("APPROVED"); // carried for the report only
  });

  it("refuses open PRs and everything at or after the contamination cutoff", () => {
    const open = selectCases([candidate({ prState: "OPEN" })]);
    expect(open.cases).toHaveLength(0);
    expect(open.rejected[0]!.reason).toContain("still open");
    const late = selectCases([candidate({ submittedAt: "2026-05-20T00:00:00Z" })]);
    expect(late.cases).toHaveLength(0);
    expect(late.rejected[0]!.reason).toContain("contamination cutoff");
  });

  it("caps per reviewer, so the loudest reviewer is not the set", () => {
    const pool = [1, 2, 3, 4, 5, 6].map((n) => candidate({ pr: n, reviewer: "gfrost" }));
    const r = selectCases(pool, { perReviewerCap: 2 });
    expect(r.cases).toHaveLength(2);
    expect(r.rejected.filter((x) => x.reason.includes("per-reviewer cap"))).toHaveLength(4);
  });
});

describe("the committed case set", () => {
  it("is small, stratified, and drawn across verdicts", () => {
    expect(readFileSync(SET_PATH, "utf8").length).toBeLessThan(120_000);
    expect(set.cases.length).toBeGreaterThanOrEqual(8);
    const reviewers = new Set(set.cases.map((c) => c.reviewer));
    expect(reviewers.size).toBeGreaterThanOrEqual(4);
    for (const r of reviewers)
      expect(set.cases.filter((c) => c.reviewer === r).length).toBeLessThanOrEqual(3);
    // Direct evidence that the verdict did not select these: the set contains
    // reviews that APPROVED and reviews that merely COMMENTED.
    const states = new Set(set.cases.map((c) => c.state));
    expect(states.has("APPROVED")).toBe(true);
    expect(states.has("COMMENTED")).toBe(true);
  });

  it("clears the substance bar everywhere and stays inside the trusted era", () => {
    for (const c of set.cases) {
      expect(c.prState).not.toBe("OPEN");
      expect(c.submittedAt < CONTAMINATION_CUTOFF).toBe(true);
      for (const f of c.findings) expect(f.substance.rung).toBeGreaterThanOrEqual(QUALIFYING_RUNG);
    }
  });

  // The anti-ratchet property. If every finding were `expected-catch`, the set
  // would encode "be more like this human" as the goal.
  it("carries all three expectation labels, and expected-catch is a minority", () => {
    const all = set.cases.flatMap((c) => c.findings);
    const kinds = new Set(all.map((f) => f.expectation));
    expect(kinds).toEqual(new Set(["expected-catch", "out-of-remit", "expected-divergence"]));
    expect(all.filter((f) => f.expectation === "expected-catch").length).toBeLessThan(
      all.length / 2,
    );
    // Anything not expected-catch is a judgment and must say why.
    for (const f of all) if (f.expectation !== "expected-catch") expect(f.note ?? "").not.toBe("");
  });

  it("refuses a malformed or empty set rather than scoring it clean", () => {
    expect(() => parseCaseSet({ cases: [] })).toThrow(/empty/);
    expect(() =>
      parseCaseSet({
        cases: [
          {
            ...set.cases[0]!,
            findings: [{ ...set.cases[0]!.findings[0]!, expectation: "nice-to-have" }],
          },
        ],
      }),
    ).toThrow(/unknown expectation/);
  });
});

describe("matching", () => {
  it("keeps backticked identifiers, which is most of a short human finding", () => {
    expect(findingTheme("use `scenario_id` here").has("scenario_id")).toBe(true);
  });

  it("matches on the same file by theme or by proximity, and misses otherwise", () => {
    const human = set.cases[0]!.findings[0]!;
    const near: SandboxFinding[] = [
      { path: human.path, line: human.line + 2, text: "unrelated wording entirely" },
    ];
    expect(matchFinding(human, near).matched).toBe(true);
    const elsewhere: SandboxFinding[] = [
      { path: "other/file.py", line: human.line, text: human.text },
    ];
    expect(matchFinding(human, elsewhere).matched).toBe(false);
    expect(matchFinding(human, []).matched).toBe(false);
  });

  it("returns the nearest same-file finding even when it scores zero", () => {
    const human = set.cases[0]!.findings[0]!;
    const far: SandboxFinding = {
      path: human.path,
      line: human.line + 500,
      text: "zzqx wholly unrelated",
    };
    const m = matchFinding(human, [far]);
    expect(m.matched).toBe(false);
    expect(m.best).toBe(far);
  });

  // Same basename is not the same file: `src/a/index.ts` and `src/b/index.ts`
  // are different places, and proximity alone must not bridge them.
  it("keeps repo-relative file identity: a same-named file elsewhere is not a match", () => {
    const human = { ...set.cases[0]!.findings[0]!, path: "src/a/index.ts", line: 40 };
    const sibling: SandboxFinding[] = [
      { path: "src/b/index.ts", line: 45, text: "unrelated wording entirely" },
    ];
    expect(matchFinding(human, sibling).matched).toBe(false);
    // A path the session wrote with a tree prefix (or `./`) is still the same file.
    for (const path of ["./src/a/index.ts", "/opt/quickreview/state/regression/pr-1/src/a/index.ts"])
      expect(matchFinding(human, [{ path, line: 45, text: "unrelated" }]).matched).toBe(true);
    // A relative path is the file it names: a bare basename, or a root file
    // against a nested one, never bridges two files.
    expect(matchFinding(human, [{ path: "index.ts", line: 40, text: "unrelated" }]).matched).toBe(
      false,
    );
    const root = { ...human, path: "index.ts" };
    expect(
      matchFinding(root, [{ path: "src/index.ts", line: 40, text: "unrelated" }]).matched,
    ).toBe(false);
  });
});

describe("scoring reads the expectation label", () => {
  const c: RegressionCase = {
    id: "pr-1-alice",
    pr: 1,
    reviewer: "alice",
    submittedAt: "2025-01-01T00:00:00Z",
    state: "CHANGES_REQUESTED",
    prState: "MERGED",
    headSha: "abc",
    changedFiles: 2,
    churn: 30,
    findings: [
      {
        path: "a.py",
        line: 10,
        text: "null deref because token may be None",
        substance: classifySubstance("x", "x"),
        resolved: true,
        gotReply: true,
        expectation: "expected-catch",
      },
      {
        path: "b.py",
        line: 10,
        text: "rename this to userId please",
        substance: classifySubstance("x", "x"),
        resolved: true,
        gotReply: false,
        expectation: "out-of-remit",
        note: "naming taste",
      },
      {
        path: "c.py",
        line: 10,
        text: "extract this helper",
        substance: classifySubstance("x", "x"),
        resolved: false,
        gotReply: true,
        expectation: "expected-divergence",
        note: "argued down",
      },
    ],
  };

  it("scores silence on an out-of-remit finding as CORRECT, not as a miss", () => {
    const s = scoreCase(c, []);
    expect(s.findings.map((f) => f.outcome)).toEqual([
      "not-reached",
      "correctly-silent",
      "divergence",
    ]);
  });

  it("never scores an expected-divergence either way as wrong", () => {
    const raised = scoreCase(c, [{ path: "c.py", line: 10, text: "extract this helper" }]);
    expect(raised.findings[2]!.outcome).toBe("divergence");
  });

  it("flags a case that produced nothing as VACUOUS rather than clean", () => {
    expect(scoreCase(c, []).vacuous).toBe(true);
    expect(scoreCase(c, [{ path: "a.py", line: 10, text: "token may be None here" }]).vacuous).toBe(
      false,
    );
  });

  it("counts sandbox findings nobody matched without calling them failures", () => {
    const s = scoreCase(c, [{ path: "z.py", line: 1, text: "unbounded query" }]);
    expect(s.sandboxOnly).toHaveLength(1);
    expect(s.findings.every((f) => f.outcome !== "reached")).toBe(true);
  });
});

describe("the run asserts dry-run in its own code", () => {
  it("refuses to start against a live gate", async () => {
    await expect(
      runRegression(set.cases, { replay: async () => [], gate: LIVE }),
    ).rejects.toBeInstanceOf(ReplayRefused);
    await expect(runRegression(set.cases, { replay: async () => [], gate: LIVE })).rejects.toThrow(
      /does not report dry-run/,
    );
  });

  it("never replays an open PR or a contaminated case", () => {
    expect(() => assertReplaySafe([{ ...set.cases[0]!, prState: "OPEN" }], DRY)).toThrow(
      /still-open/,
    );
    expect(() =>
      assertReplaySafe([{ ...set.cases[0]!, submittedAt: "2026-06-01T00:00:00Z" }], DRY),
    ).toThrow(/contamination cutoff/);
  });

  it("does not replay a single case when the gate check fails", async () => {
    const seen: number[] = [];
    await expect(
      runRegression(set.cases, { replay: async (c) => (seen.push(c.pr), []), gate: LIVE }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  // Rule 1 and the corpus safety note: the replay must not be the live daemon,
  // and this module must not be able to become one.
  it("imports nothing that could reach GitHub or the daemon", () => {
    const src = readFileSync(SRC_PATH, "utf8");
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    expect(imports).toEqual([]);
    for (const forbidden of [
      "daemon.js",
      "wire.js",
      "github.js",
      "gate.js",
      "dispatch.js",
      "loadConfig",
      "dry_run",
    ]) {
      expect(src).not.toContain(`from "./${forbidden}"`);
    }
    expect(src).not.toMatch(/loadConfig|config\.gate|process\.env/);
  });
});

describe("a failure is an investigation, not a veto", () => {
  const replayNothing = {
    replay: async () => [] as SandboxFinding[],
    gate: DRY,
    now: () => new Date("2026-08-25T10:00:00Z"),
  };

  it("returns exit code 0 and a recommendation even when everything is missed", async () => {
    const run = await runRegression(set.cases, replayNothing);
    expect(run.exitCode).toBe(0);
    expect(run.recommendation).not.toBe("veto");
    expect(["look-at-these", "ask-owner"]).toContain(run.recommendation);
    expect(run.markdown).toContain("This is not a gate.");
    expect(run.markdown).toContain("The goal is not to imitate a reviewer.");
  });

  it("blames the harness, not the reviewer, when the replay produced nothing at all", async () => {
    const run = await runRegression(set.cases, replayNothing);
    expect(run.recommendation).toBe("ask-owner");
    expect(run.headline).toContain("Suspect the replay harness");
    expect(run.markdown).toContain("produced no sandbox findings at all");
  });

  it("recommends no action when every expected-catch finding was reached", async () => {
    const run = await runRegression(set.cases, {
      gate: DRY,
      replay: async (c) => c.findings.map((f) => ({ path: f.path, line: f.line, text: f.text })),
    });
    expect(run.recommendation).toBe("no-action");
    expect(run.markdown).toContain("## Findings to look at");
    expect(run.markdown).toContain("None.");
    expect(run.exitCode).toBe(0);
  });

  it("puts the human's own words, the hunk and a question in front of the reader", async () => {
    const one = set.cases.find((c) => c.findings.some((f) => f.expectation === "expected-catch"))!;
    const target = one.findings.find((f) => f.expectation === "expected-catch")!;
    const run = await runRegression([one], { gate: DRY, replay: async () => [] });
    expect(run.markdown).toContain(target.text.split("\n")[0]!.slice(0, 40));
    expect(run.markdown).toContain("is this in the reviewer's remit at all?");
    expect(run.markdown).toContain("not why it was selected"); // the verdict is context, not the criterion
  });

  it("warns when one reviewer dominates the scored findings", () => {
    const skewed = renderInvestigation({
      cases: [],
      changeUnderTest: "x",
      ranAt: "now",
      recommendation: "look-at-these",
      headline: "h",
      reviewerSkew: 0.9,
      exitCode: 0,
    });
    expect(skewed).toContain("measuring one person's habits");
  });
});
