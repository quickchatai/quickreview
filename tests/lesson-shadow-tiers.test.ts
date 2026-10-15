// Shadow matching at lens level. A dont-raise lesson marks a posted finding
// of one of its lenses on a path its `paths=` globs match, even when the
// finding's class differs; the class match, when present, is recorded as the
// stronger tier. Pinned here: the two tiers on the mark, the no-paths rule,
// P0 exempt on both tiers, the report's tier columns (separately and in
// total), the status headline, and the once-only migration of a class-only ledger
// (existing rows kept as `class`). Every I/O is faked: the state database is
// in memory, the clock is fixed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Learner } from "../src/learner/learner.js";
import { LessonLedger, type ShadowMarkRow } from "../src/lessonledger.js";
import {
  lensAttributable,
  lessonDeliveryStatus,
  markRound,
  matchShadow,
  renderShadowReport,
  shadowReport,
  strongerTier,
  type MatchFinding,
} from "../src/lessonshadow.js";
import type { RoleSelection, SelectedLesson } from "../src/memory/selection.js";
import {
  lessonDeliveryPhrase,
  lessonHeadline,
  lessonTierLine,
  type LessonDeliveryStatus,
} from "../src/memory/shadowstatus.js";
import { OutcomeCapture } from "../src/outcomes.js";
import { StateStore } from "../src/state.js";
import { lessonsHeadline } from "../src/tui/feedbacktab.js";
import { stripAnsi } from "../src/tui/paint.js";

const EXP = "viking://user/reviewer/memories/experiences";
const uri = (name: string): string => `${EXP}/20261001T000000-${name}.md`;

function sl(
  u: string,
  kind: SelectedLesson["kind"],
  cls: string | null,
  lens: string[],
  paths: string[],
): SelectedLesson {
  return {
    uri: u,
    kind,
    class: cls,
    lens,
    paths,
    evidence: 1,
    format: cls ? "typed" : "legacy",
    tokens: 10,
    score: 0.5,
    created: "2026-10-01",
  };
}

const base = { query: "q", status: "ok" as const, cases: [], cuts: [], dropped: {} };
function row(n: number, lens: string, lessons: SelectedLesson[]): RoleSelection {
  return { ...base, role: "row", row: n, lens, agent: lens, lessons };
}
function validator(lessons: SelectedLesson[]): RoleSelection {
  return { ...base, role: "validator", row: 9, lens: "pass-validate", agent: "v", lessons };
}

function mf(
  key: string,
  lens: string,
  kind: string,
  path: string | null,
  severity = "P2",
): MatchFinding {
  return { finding_key: key, path, lens, lens_ids: null, kind, severity, disposition: "posted" };
}

const tiersOf = (marks: ReturnType<typeof matchShadow>): string[] =>
  marks.map((m) => `${m.finding_key}:${m.lesson_uri.slice(EXP.length + 17, -3)}:${m.match}`);

// ---- the matcher: two tiers --------------------------------------------------------

describe("matchShadow at lens level — the tier on every mark", () => {
  it("lens + path is enough; the class match, when present, is the stronger `class` tier", () => {
    const LD = uri("dr-docs");
    const sels = [
      row(0, "pass-baseline", [
        sl(LD, "dont-raise", "baseline.scope", ["pass-baseline"], ["docs/**"]),
      ]),
    ];
    const marks = matchShadow(sels, [
      mf("a", "pass-baseline", "scope", "docs/a.md"), // class tier
      mf("b", "pass-baseline", "correctness", "docs/b.md"), // lens tier: class differs
      mf("d", "pass-baseline", "correctness", "backend/d.py"), // path fails: nothing
      mf("e", "pass-ui", "scope", "docs/e.md"), // lens fails: nothing
    ]);
    expect(tiersOf(marks)).toEqual(["a:dr-docs:class", "b:dr-docs:lens"]);
    // The class tier keeps the learner's coverage rule: a dot-prefix covers.
    const broad = matchShadow(
      [
        row(0, "pass-baseline", [
          sl(uri("dr-base"), "dont-raise", "baseline", ["pass-baseline"], ["docs/**"]),
        ]),
      ],
      [mf("b", "pass-baseline", "correctness", "docs/b.md")],
    );
    expect(tiersOf(broad)).toEqual(["b:dr-base:class"]);
    expect(marks[1]).toMatchObject({
      finding_class: "baseline.correctness",
      lesson_class: "baseline.scope",
      match: "lens",
    });
    expect(marks[1]!.why).toBe(
      "lens pass-baseline in the lesson's lens=; path docs/b.md matches docs/**; " +
        "lens tier: class baseline.correctness differs from baseline.scope; selected for row:0",
    );
    expect(marks[0]!.why).toContain("class tier: baseline.scope ~ baseline.scope");
  });

  it("a lesson with no class marks on the lens tier, its lesson_class null", () => {
    const LN = uri("legacy-docs");
    const marks = matchShadow(
      [row(0, "pass-baseline", [sl(LN, "dont-raise", null, ["pass-baseline"], ["docs/**"])])],
      [
        mf("a", "pass-baseline", "scope", "docs/a.md"),
        mf("b", "pass-baseline", "scope", "src/b.ts"),
      ],
    );
    expect(tiersOf(marks)).toEqual(["a:legacy-docs:lens"]);
    expect(marks[0]).toMatchObject({ lesson_class: null, finding_class: "baseline.scope" });
    expect(marks[0]!.why).toContain(
      "lens tier: the lesson names no class (finding baseline.scope)",
    );
  });

  it("on the lens tier the finding's class is the one under the lens the lesson names", () => {
    const LS = uri("dr-sec");
    const marks = matchShadow(
      [validator([sl(LS, "dont-raise", "security.authz", ["pass-security"], ["api/**"])])],
      [mf("a", "pass-baseline + pass-security", "xss", "api/a.py")],
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      match: "lens",
      finding_class: "security.xss",
      lens: ["pass-baseline", "pass-security"],
      via: ["validator"],
    });
  });

  it("a lesson covering EVERY lens records the class under the finding's FIRST lens", () => {
    // pass-validate (the validator judges every lens) or no lens named: no
    // lens of the finding's is the lesson's, so the lens tier rests on the
    // finding's first lens.
    for (const lens of [["pass-validate"], []]) {
      const marks = matchShadow(
        [validator([sl(uri("v"), "dont-raise", null, lens, ["api/**"])])],
        [mf("a", "pass-baseline + pass-security", "xss", "api/a.py")],
      );
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({
        match: "lens",
        finding_class: "baseline.xss",
        lens: ["pass-baseline", "pass-security"],
      });
    }
  });

  it("the no-paths rule: with no `paths=` the lens tier needs EXACTLY ONE discovery lens", () => {
    const finding = mf("f", "pass-baseline", "correctness", "anywhere/f.py");
    const other = mf("g", "pass-ui", "correctness", "anywhere/g.tsx");
    const one = (l: SelectedLesson) =>
      matchShadow([row(0, "pass-baseline", [l])], [finding, other]);
    // One lens, no paths, no class: attributable — marks that lens's finding anywhere.
    expect(tiersOf(one(sl(uri("one"), "dont-raise", null, ["pass-baseline"], [])))).toEqual([
      "f:one:lens",
    ]);
    // Two lenses, no lens, or only pass-validate (it covers every lens): too broad.
    for (const lens of [["pass-baseline", "pass-ui"], [], ["pass-validate"]]) {
      expect(one(sl(uri("broad"), "dont-raise", null, lens, []))).toEqual([]);
      // …and with a class it still marks on its CLASS — never on lens alone.
      expect(
        tiersOf(one(sl(uri("broad"), "dont-raise", "baseline.correctness", lens, []))),
      ).toEqual(["f:broad:class"]);
      expect(one(sl(uri("broad"), "dont-raise", "baseline.scope", lens, []))).toEqual([]);
    }
    // No lens but paths: the paths attribute it — any lens's finding on them.
    expect(tiersOf(one(sl(uri("paths"), "dont-raise", null, [], ["anywhere/**"])))).toEqual([
      "f:paths:lens",
      "g:paths:lens",
    ]);
    expect(lensAttributable({ lens: ["pass-baseline"], paths: [] })).toBe(true);
    expect(lensAttributable({ lens: [], paths: ["a/**"] })).toBe(true);
    expect(lensAttributable({ lens: ["pass-validate"], paths: ["a/**"] })).toBe(true);
    expect(lensAttributable({ lens: ["pass-validate"], paths: [] })).toBe(false);
    expect(lensAttributable({ lens: ["pass-a", "pass-b"], paths: [] })).toBe(false);
    expect(lensAttributable({ lens: [], paths: [] })).toBe(false);
  });

  it("a P0 is MARKED on either tier (the report exempts it); look-for lessons and unposted findings never", () => {
    const LD = uri("dr");
    const sels = [
      row(0, "pass-baseline", [
        sl(LD, "dont-raise", "baseline.scope", ["pass-baseline"], ["**"]),
        sl(uri("lf"), "look-for", "baseline.correctness", ["pass-baseline"], ["**"]),
      ]),
    ];
    const marks = matchShadow(sels, [
      mf("p0", "pass-baseline", "correctness", "x.py", "P0"),
      { ...mf("k", "pass-baseline", "correctness", "x.py"), disposition: "killed" },
    ]);
    expect(tiersOf(marks)).toEqual(["p0:dr:lens"]);
    expect(marks[0]!.severity).toBe("P0");
  });

  it("is deterministic: the same input in any order gives the same marks", () => {
    const sels = [
      row(0, "pass-baseline", [
        sl(uri("a"), "dont-raise", "baseline.scope", ["pass-baseline"], ["**"]),
      ]),
      validator([
        sl(uri("a"), "dont-raise", "baseline.scope", ["pass-baseline"], ["**"]),
        sl(uri("b"), "dont-raise", null, ["pass-security"], []),
      ]),
    ];
    const fs = [
      mf("1", "pass-baseline", "scope", "x"),
      mf("2", "pass-security", "authz", "y"),
      mf("3", "pass-baseline", "perf", "z"),
    ];
    const marks = matchShadow(sels, fs);
    expect(tiersOf(marks)).toEqual(["1:a:class", "2:b:lens", "3:a:lens"]);
    expect(marks[0]!.via).toEqual(["row:0", "validator"]);
    expect(matchShadow([...sels].reverse(), [...fs].reverse())).toEqual(marks);
    expect(strongerTier("lens", "class")).toBe("class");
    expect(strongerTier("class", "lens")).toBe("class");
    expect(strongerTier("lens", "lens")).toBe("lens");
  });
});

// ---- the report: both tiers, separately and in total --------------------------------

const LD = uri("dr-docs"); // class baseline.scope, pass-baseline, docs/**
const LN = uri("dr-legacy"); // no class, pass-baseline only, no paths: lens tier anywhere
const LS = uri("dr-sec"); // class security.authz, pass-security only, no paths
const LB = uri("dr-broad"); // class baseline.authz, two lenses, no paths: class tier only
const LU = uri("dr-unmeasurable"); // no class, two lenses, no paths: neither tier

function reportSelections(): RoleSelection[] {
  return [
    row(0, "pass-baseline", [
      sl(LD, "dont-raise", "baseline.scope", ["pass-baseline"], ["docs/**"]),
      sl(LN, "dont-raise", null, ["pass-baseline"], []),
    ]),
    row(1, "pass-security", [sl(LS, "dont-raise", "security.authz", ["pass-security"], [])]),
    validator([
      sl(LB, "dont-raise", "baseline.authz", ["pass-baseline", "pass-security"], []),
      sl(LU, "dont-raise", null, ["pass-baseline", "pass-ui"], []),
    ]),
  ];
}

describe("the shadow report's tiers over a fixture joined with fates", () => {
  let store: StateStore;
  let ledger: LessonLedger;
  const clock = new Date("2026-10-05T10:00:00Z");
  beforeEach(() => {
    store = new StateStore(":memory:", () => clock);
    ledger = new LessonLedger(store, () => clock);
    new OutcomeCapture({ store, botLogin: "bot" });
    new Learner({
      store,
      root: "/nonexistent",
      eodTime: "18:00",
      timeZone: "Europe/Warsaw",
      botLogin: "bot",
      baseBranch: "master",
    });
  });
  afterEach(() => store.close());

  const roundRow = (round_id: number, pr: number, round_no: number) => ({
    round_id,
    pr,
    round_no,
    mode: "shadow" as const,
    state: "selected" as const,
    finds: 2,
    answered: 2,
    timeouts: 0,
    refused: 0,
    prefetch_ms: 100,
    retired_list: 1,
    suppressed: 0,
    as_of: null,
    note: null,
  });
  const fate = (pr: number, round: number, key: string, f: string, carried: string | null = null) =>
    store.db
      .prepare(
        "INSERT INTO finding_outcomes (pr, round_no, finding_key, fate, human_replies, carried_to, fate_changed_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 'x', 'x')",
      )
      .run(pr, round, key, f, carried);
  const fnd = (key: string, lens: string, kind: string, path: string, severity = "P2") => ({
    key,
    path,
    line: 1,
    lens,
    severity,
    kind,
    disposition: "posted",
  });

  function seed(): void {
    ledger.recordRound(roundRow(21, 200, 1), reportSelections());
    store.recordRoundFindings({ pr: 200, round_id: 21, round_no: 1, head_sha: "h" }, [
      fnd("a", "pass-baseline", "scope", "docs/a.md"), // LD class + LN lens → class; fixed
      fnd("b", "pass-baseline", "correctness", "docs/b.md"), // LD lens + LN lens → lens; refuted
      fnd("c", "pass-baseline", "correctness", "backend/c.py", "P0"), // LN lens → lens; P0
      fnd("d", "pass-security", "authz", "backend/d.py"), // LS class → class; unknown
      fnd("e", "pass-security", "xss", "backend/e.py"), // LS lens → lens; open at close
      fnd("f", "pass-baseline", "authz", "backend/f.py", "P1"), // LB class + LN lens → class; upheld
      fnd("g", "pass-ui", "scope", "docs/g.md"), // nothing: LU is unmeasurable
    ]);
    fate(200, 1, "a", "fixed");
    fate(200, 1, "b", "refuted_conceded");
    fate(200, 1, "c", "fixed");
    fate(200, 1, "d", "unknown");
    fate(200, 1, "e", "open_at_close");
    fate(200, 1, "f", "upheld_after_reply");
  }

  it("markRound records each mark's tier; the event counts both", () => {
    seed();
    const marks = markRound(ledger, store, 200, 1)!;
    expect(tiersOf(marks)).toEqual([
      "a:dr-docs:class",
      "a:dr-legacy:lens",
      "b:dr-docs:lens",
      "b:dr-legacy:lens",
      "c:dr-legacy:lens",
      "d:dr-sec:class",
      "e:dr-sec:lens",
      "f:dr-broad:class",
      "f:dr-legacy:lens",
    ]);
    const stored = ledger.marks(200, 1);
    expect(stored.map((m) => m.match)).toEqual(marks.map((m) => m.match));
    expect(stored.find((m) => m.lesson_uri === LN)!.lesson_class).toBeNull();
    const ev = store.db
      .prepare("SELECT payload FROM events WHERE kind = 'lesson_shadow_marked'")
      .get() as { payload: string };
    expect(JSON.parse(ev.payload)).toEqual({
      round_no: 1,
      marks: 9,
      findings: 6,
      by_tier: { class: 3, lens: 6 },
    });
  });

  it("totals, each finding on its strongest tier; the tiers add up to the total; P0 exempt on the lens tier", () => {
    seed();
    markRound(ledger, store, 200, 1);
    const r = shadowReport(ledger, { days: 7, mode: "shadow", now: () => clock });
    expect(r.marks).toBe(9);
    expect(r.marks_by_tier).toEqual({ class: 3, lens: 6 });
    expect(r.findings).toEqual({
      total: 6,
      harm: 1,
      help_refuted: 1,
      help_set_aside: 0,
      upheld: 1,
      ignored: 1,
      unknown: 1,
      exempt_p0: 1,
    });
    expect(r.findings_by_tier.class).toEqual({
      total: 3, // a (both tiers touched it — class wins), d, f
      harm: 1, // a: fixed
      help_refuted: 0,
      help_set_aside: 0,
      upheld: 1, // f
      ignored: 0,
      unknown: 1, // d
      exempt_p0: 0,
    });
    expect(r.findings_by_tier.lens).toEqual({
      total: 3, // b, c, e
      harm: 0,
      help_refuted: 1, // b
      help_set_aside: 0,
      upheld: 0,
      ignored: 1, // e
      unknown: 0,
      exempt_p0: 1, // c: a P0 — fixed, but never demoted, on any tier
    });
    for (const k of Object.keys(r.findings) as Array<keyof typeof r.findings>)
      expect(r.findings_by_tier.class[k] + r.findings_by_tier.lens[k]).toBe(r.findings[k]);
  });

  it("per lesson and per lens, by tier; the class-only and unmeasurable lessons listed", () => {
    seed();
    markRound(ledger, store, 200, 1);
    const r = shadowReport(ledger, { days: 7, mode: "shadow", now: () => clock });
    const lesson = (u: string) => r.per_lesson.find((l) => l.uri === u)!;
    expect(lesson(LD)).toMatchObject({
      class: "baseline.scope",
      marks: 2,
      harm: 1,
      help_refuted: 1,
    });
    expect(lesson(LD).by_tier.class).toMatchObject({ marks: 1, harm: 1 });
    expect(lesson(LD).by_tier.lens).toMatchObject({ marks: 1, help_refuted: 1 });
    expect(lesson(LN)).toMatchObject({ class: null, marks: 4, selected_rounds: 1 });
    expect(lesson(LN).by_tier.class.marks).toBe(0);
    expect(lesson(LN).by_tier.lens).toMatchObject({
      marks: 4,
      harm: 1,
      help_refuted: 1,
      exempt_p0: 1,
      upheld: 1,
    });
    expect(lesson(LS).by_tier).toMatchObject({
      class: { marks: 1, unknown: 1 },
      lens: { marks: 1, ignored: 1 },
    });
    expect(lesson(LB).by_tier).toMatchObject({
      class: { marks: 1, upheld: 1 },
      lens: { marks: 0 },
    });
    expect(r.per_lesson.find((l) => l.uri === LU)).toBeUndefined();
    const lens = (n: string) => r.per_lens.find((l) => l.lens === n)!;
    expect(lens("pass-baseline")).toMatchObject({ marks: 4 }); // a b c f
    expect(lens("pass-baseline").by_tier.class).toMatchObject({ marks: 2, harm: 1, upheld: 1 });
    expect(lens("pass-baseline").by_tier.lens).toMatchObject({
      marks: 2,
      help_refuted: 1,
      exempt_p0: 1,
    });
    expect(lens("pass-security").by_tier).toMatchObject({
      class: { marks: 1, unknown: 1 },
      lens: { marks: 1, ignored: 1 },
    });
    expect(r.class_tier_only_dont_raise).toEqual([LB]);
    expect(r.unmeasurable_dont_raise).toEqual([LU]);
  });

  it("renders both tiers separately and in total, at every level", () => {
    seed();
    markRound(ledger, store, 200, 1);
    const text = renderShadowReport(
      shadowReport(ledger, { days: 7, mode: "shadow", now: () => clock }),
    );
    // The total is "marked": it holds lens-tier findings the
    // validator's license never reaches — only the class tier would demote.
    expect(text).toContain(
      "marked: 9 mark(s) on 6 posted finding(s) — class tier (would-demote) 3 finding(s) (3 mark(s)), lens tier (evidence only) 3 finding(s) (6 mark(s))",
    );
    expect(text).not.toMatch(/^would-demote:/m);
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("marked:"));
    expect(lines.slice(at + 1, at + 4)).toEqual([
      "  all    harm 1 · help 1 (refuted 1, set aside 0) · upheld 1 · ignored 1 · unknown 1 · P0 exempt 1",
      "  class  harm 1 · help 0 (refuted 0, set aside 0) · upheld 1 · ignored 0 · unknown 1 · P0 exempt 0",
      "  lens   harm 0 · help 1 (refuted 1, set aside 0) · upheld 0 · ignored 1 · unknown 0 · P0 exempt 1",
    ]);
    expect(text).toContain("A finding both tiers touched counts on the class tier");
    expect(text).toContain(
      "experiences/20261001T000000-dr-legacy.md  class (none)  selected in 1 round(s)  marks 4 (class 0, lens 4)",
    );
    expect(text).toContain("  pass-baseline  marks 4 (class 2, lens 2)");
    expect(text).toContain(
      "Dont-raise lessons too broad for the lens tier (no paths=, and not exactly one discovery lens — they mark on their class alone): experiences/20261001T000000-dr-broad.md",
    );
    expect(text).toContain(
      "Dont-raise lessons neither tier can check (no class, no paths=, and not exactly one discovery lens — they mark nothing): experiences/20261001T000000-dr-unmeasurable.md",
    );
    // Under `on` only the CLASS tier is within the validator's license to
    // demote: the lens tier widens the evidence, never the authority.
    const on = renderShadowReport(shadowReport(ledger, { days: 7, mode: "on", now: () => clock }));
    expect(on).toContain(
      "the CLASS-tier marks below are the matches within the validator's license to demote",
    );
    expect(on).toContain("the lens tier is outside that license");
  });

  it("a finding posted again is ONE finding on the strongest tier any of its postings got", () => {
    seed();
    markRound(ledger, store, 200, 1);
    // Round 2 posts b again (the outcome capture carries round 1's b to b2) — this time with
    // kind `scope`, so LD matches it on its CLASS.
    ledger.recordRound(roundRow(22, 200, 2), reportSelections());
    store.recordRoundFindings({ pr: 200, round_id: 22, round_no: 2, head_sha: "h2" }, [
      fnd("b2", "pass-baseline", "scope", "docs/b.md"),
    ]);
    fate(200, 2, "b2", "refuted_conceded");
    store.db
      .prepare(
        "UPDATE finding_outcomes SET carried_to = '2:b2' WHERE pr = 200 AND round_no = 1 AND finding_key = 'b'",
      )
      .run();
    markRound(ledger, store, 200, 2);
    const r = shadowReport(ledger, { days: 7, mode: "shadow", now: () => clock });
    expect(r.findings.total).toBe(6); // b and b2 one chain
    expect(r.findings_by_tier.class.total).toBe(4); // a d f + the b chain
    expect(r.findings_by_tier.lens.total).toBe(2); // c e
    expect(r.findings_by_tier.class.help_refuted).toBe(1);
    const ld = r.per_lesson.find((l) => l.uri === LD)!;
    expect(ld.marks).toBe(2); // a and the b chain — once
    expect(ld.by_tier.class.marks).toBe(2);
    expect(ld.by_tier.lens.marks).toBe(0);
    // Per lens too: the b chain's first marks (round 1) are lens-tier, its
    // round-2 mark class-tier — it counts on the class tier.
    const pb = r.per_lens.find((l) => l.lens === "pass-baseline")!;
    expect(pb.marks).toBe(4); // a, the b chain, c, f
    expect(pb.by_tier.class.marks).toBe(3); // a, the b chain, f
    expect(pb.by_tier.lens.marks).toBe(1); // c
  });

  it("the status headline carries the tiers; qcr status and the TUI show them", () => {
    seed();
    markRound(ledger, store, 200, 1);
    const s = lessonDeliveryStatus(ledger, "shadow", { now: () => clock });
    expect(s).toMatchObject({ marks: 6, harm: 1, help: 1, unknown: 1 });
    expect(s.tiers).toEqual({
      class: { marks: 3, harm: 1, help: 0, unknown: 1 },
      lens: { marks: 3, harm: 0, help: 1, unknown: 0 },
    });
    // The total is "marked" (it holds the lens tier); "would-demote" is the
    // class tier's, the lens tier "evidence only".
    expect(lessonDeliveryPhrase(s)).toBe(
      "; lessons shadow 7d: 1 rounds, 6 marked (harm 1, help 1, unknown 1)" +
        " — by tier: class 3 would-demote (harm 1, help 0, unknown 1)" +
        " · lens 3 evidence only (harm 0, help 1, unknown 0)",
    );
    const snap = { written_at: "x", dry_run: false, prs: [], memory: { lessons: s } } as never;
    const painted = lessonsHeadline(snap);
    expect(stripAnsi(painted.lines.join("\n"))).toBe(
      "lessons shadow 7d: 1 rounds, 6 marked (harm 1, help 1, unknown 1)\n" +
        "by tier: class 3 would-demote (harm 1, help 0, unknown 1) · lens 3 evidence only (harm 0, help 1, unknown 0)",
    );
  });
});

describe("the tier line is honest-unknown", () => {
  const S: LessonDeliveryStatus = {
    delivery: "shadow",
    delivering: false,
    lessons_off: false,
    suppressed: 0,
    window_days: 7,
    rounds: 3,
    timeouts: 0,
    unreadable: 0,
    marks: 2,
    harm: 1,
    help: 1,
    unknown: 0,
    as_of: "2026-10-07T10:00:00.000Z",
  };
  it("a daemon that predates lens-level matching reports no tiers: UNKNOWN, never an empty split", () => {
    expect(lessonTierLine(S)).toBe(
      "by tier: UNKNOWN (this daemon predates lens-level matching)",
    );
    expect(lessonDeliveryPhrase(S)).toContain(" — by tier: UNKNOWN");
    expect(lessonDeliveryPhrase(S)).not.toMatch(/class 0|lens 0/);
    // Its marks are all class-tier (the strict matcher): its total keeps
    // "would-demote"; a two-tier status's total is "marked".
    expect(lessonHeadline(S)).toContain("2 would-demote (harm 1, help 1, unknown 0)");
    const r9 = {
      ...S,
      tiers: {
        class: { marks: 1, harm: 1, help: 0, unknown: 0 },
        lens: { marks: 1, harm: 0, help: 1, unknown: 0 },
      },
    };
    expect(lessonHeadline(r9)).toContain("2 marked (harm 1, help 1, unknown 0)");
    expect(lessonHeadline(r9)).not.toContain("would-demote");
    const painted = lessonsHeadline({
      written_at: "x",
      dry_run: false,
      prs: [],
      memory: { lessons: S },
    } as never);
    expect(stripAnsi(painted.lines[1]!)).toContain("by tier: UNKNOWN");
  });
  it("nothing to split: no line where the headline counts nothing", () => {
    expect(lessonTierLine(null)).toBeNull();
    expect(lessonTierLine({ ...S, delivery: "off" })).toBeNull();
    expect(lessonTierLine({ ...S, lessons_off: true })).toBeNull();
    expect(lessonDeliveryPhrase({ ...S, lessons_off: true })).toBe(
      `; ${lessonHeadline({ ...S, lessons_off: true })}`,
    );
  });
});

// ---- the migration of a class-only ledger ------------------------------------------------

describe("a ledger without lens tiers migrates once: existing rows kept as `class`, the lens tier added", () => {
  const S9A_SCHEMA = readFileSync(
    resolve(process.cwd(), "tests/fixtures/lesson-ledger-s9a.sql"),
    "utf8",
  );
  const T_ROUND = "2026-10-06T09:00:00.000Z";
  const T_FINDINGS = "2026-10-06T09:30:00.000Z";
  const T_MARKED = "2026-10-06T09:31:00.000Z";
  let store: StateStore;
  beforeEach(() => {
    store = new StateStore(":memory:", () => new Date(T_FINDINGS));
    store.db.exec(S9A_SCHEMA);
  });
  afterEach(() => store.close());

  const LDm = uri("m-docs"); // class baseline.scope, pass-baseline, docs/**
  function oldRound(roundId: number, pr: number, roundNo: number, state = "selected"): void {
    store.db
      .prepare(
        `INSERT INTO lesson_rounds (round_id, pr, round_no, mode, state, finds, answered, prefetch_ms, recorded_at)
         VALUES (?, ?, ?, 'shadow', ?, 2, 2, 50, ?)`,
      )
      .run(roundId, pr, roundNo, state, T_ROUND);
    store.db
      .prepare(
        `INSERT INTO lesson_selections (round_id, pr, round_no, role, row, lens, agent, query, status, lessons, recorded_at)
         VALUES (?, ?, ?, 'row', 0, 'pass-baseline', 'a', 'q', 'ok', ?, ?)`,
      )
      .run(
        roundId,
        pr,
        roundNo,
        JSON.stringify([sl(LDm, "dont-raise", "baseline.scope", ["pass-baseline"], ["docs/**"])]),
        T_ROUND,
      );
  }
  const finding = (key: string, kind: string, path: string) => ({
    key,
    path,
    line: 1,
    lens: "pass-baseline",
    severity: "P2",
    kind,
    disposition: "posted",
  });
  const OLD_ROW = {
    pr: 300,
    round_no: 1,
    finding_key: "a",
    lesson_uri: LDm,
    round_id: 31,
    lens: '["pass-baseline"]',
    finding_class: "baseline.scope",
    lesson_class: "baseline.scope",
    severity: "P2",
    path: "docs/a.md",
    via: '["row:0"]',
    why: "the class matcher's own words",
    marked_at: T_MARKED,
  };

  function seedOld(): void {
    // Round 300/1: marked by the strict matcher (a), and a lens-tier finding
    // (b) it never marked. Round 301/1: never marked at all. Round 302/1:
    // the kill switch was off — nothing to match.
    oldRound(31, 300, 1);
    oldRound(32, 301, 1);
    oldRound(33, 302, 1, "lessons_off");
    store.recordRoundFindings({ pr: 300, round_id: 31, round_no: 1, head_sha: "h" }, [
      finding("a", "scope", "docs/a.md"),
      finding("b", "correctness", "docs/b.md"),
    ]);
    store.recordRoundFindings({ pr: 301, round_id: 32, round_no: 1, head_sha: "h" }, [
      finding("c", "scope", "docs/c.md"),
      finding("d", "perf", "docs/d.md"),
    ]);
    store.recordRoundFindings({ pr: 302, round_id: 33, round_no: 1, head_sha: "h" }, [
      finding("e", "perf", "docs/e.md"),
    ]);
    store.db
      .prepare(
        `INSERT INTO lesson_shadow_marks (pr, round_no, finding_key, lesson_uri, round_id, lens, finding_class,
           lesson_class, severity, path, via, why, marked_at)
         VALUES (@pr, @round_no, @finding_key, @lesson_uri, @round_id, @lens, @finding_class,
           @lesson_class, @severity, @path, @via, @why, @marked_at)`,
      )
      .run(OLD_ROW);
  }

  const all = (): ShadowMarkRow[] =>
    store.db
      .prepare("SELECT * FROM lesson_shadow_marks ORDER BY pr, round_no, finding_key, lesson_uri")
      .all() as ShadowMarkRow[];
  const migratedEvents = () =>
    (
      store.db
        .prepare("SELECT payload FROM events WHERE kind = 'lesson_shadow_tiers_migrated'")
        .all() as Array<{ payload: string }>
    ).map((e) => JSON.parse(e.payload) as unknown);

  it("keeps every existing row byte for byte as `class`, adds the lens-tier marks, and records it", () => {
    seedOld();
    new LessonLedger(store, () => new Date("2026-10-07T12:00:00Z"));
    const rows = all();
    expect(rows.find((m) => m.pr === 300 && m.finding_key === "a")).toEqual({
      ...OLD_ROW,
      match: "class",
    });
    expect(rows.map((m) => `${m.pr}:${m.finding_key}:${m.match}:${m.marked_at}`)).toEqual([
      `300:a:class:${T_MARKED}`, // the class-only row, untouched
      `300:b:lens:${T_MARKED}`, // stamped with the round's own marking time
      `301:c:class:${T_FINDINGS}`, // a round never marked gets both tiers…
      `301:d:lens:${T_FINDINGS}`, // …stamped when its findings landed
    ]);
    expect(migratedEvents()).toEqual([
      { kept_as_class: 1, rounds_backfilled: 2, marks_added: { class: 1, lens: 2 } },
    ]);
    // The new shape: `match` with its default and CHECK, lesson_class nullable,
    // the window index back on the table.
    const cols = store.db.prepare("PRAGMA table_info(lesson_shadow_marks)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(cols.find((c) => c.name === "match")).toMatchObject({
      notnull: 1,
      dflt_value: "'class'",
    });
    expect(cols.find((c) => c.name === "lesson_class")!.notnull).toBe(0);
    expect(
      store.db
        .prepare(
          "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'lesson_shadow_marks_at'",
        )
        .get(),
    ).toEqual({ tbl_name: "lesson_shadow_marks" });
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'lesson_shadow_marks_before_tiers'")
        .get(),
    ).toBeUndefined();
    expect(() =>
      store.db
        .prepare(
          "INSERT INTO lesson_shadow_marks (pr, round_no, finding_key, lesson_uri, lens, finding_class, match, via, why, marked_at) VALUES (1, 1, 'k', 'u', '[]', 'x', 'guess', '[]', 'w', 'x')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("runs once: a second ledger on the same database changes nothing", () => {
    seedOld();
    new LessonLedger(store);
    const once = all();
    new LessonLedger(store);
    expect(all()).toEqual(once);
    expect(migratedEvents()).toHaveLength(1);
  });

  it("a second opener that read the OLD shape before the first migrated finds the work done inside its transaction", () => {
    // The daemon and `qcr lessons shadow-report` both open the database: the
    // second can read the old shape, then win the IMMEDIATE lock only after
    // the first committed. Rebuilding again would copy every row — the
    // lens-tier ones included — as `class`.
    seedOld();
    new LessonLedger(store);
    const once = all();
    expect(once.some((m) => m.match === "lens")).toBe(true);
    // The outer check (before the transaction) reads the old shape; the one
    // inside it reads the truth.
    const proto = LessonLedger.prototype as unknown as { marksHaveTiers(): boolean };
    const spy = vi.spyOn(proto, "marksHaveTiers").mockReturnValueOnce(false);
    try {
      new LessonLedger(store);
    } finally {
      spy.mockRestore();
    }
    expect(all()).toEqual(once);
    expect(migratedEvents()).toHaveLength(1);
  });

  it("the migrated ledger reports the lens tier for rounds recorded before tiers — never a zero it never measured", () => {
    seedOld();
    const ledger = new LessonLedger(store, () => new Date("2026-10-07T12:00:00Z"));
    const r = shadowReport(ledger, {
      days: 7,
      mode: "shadow",
      now: () => new Date("2026-10-07T12:00:00Z"),
    });
    expect(r.marks_by_tier).toEqual({ class: 2, lens: 2 });
    expect(r.findings_by_tier.lens.total).toBe(2);
    // A later re-mark (a findings record landing again) writes the same rows.
    markRound(ledger, store, 300, 1);
    expect(ledger.marks(300, 1).map((m) => `${m.finding_key}:${m.match}`)).toEqual([
      "a:class",
      "b:lens",
    ]);
  });

  it("a fresh database is created in the tiered shape and never migrates", () => {
    const fresh = new StateStore(":memory:");
    try {
      new LessonLedger(fresh);
      const cols = (
        fresh.db.prepare("PRAGMA table_info(lesson_shadow_marks)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain("match");
      expect(
        fresh.db.prepare("SELECT 1 FROM events WHERE kind = 'lesson_shadow_tiers_migrated'").get(),
      ).toBeUndefined();
    } finally {
      fresh.close();
    }
  });
});
