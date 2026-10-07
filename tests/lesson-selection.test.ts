// lesson SELECTION (src/memory/selection.ts): filters on the
// typed header, a deterministic ranking, caps with every cut listed. Pure.
import { describe, expect, it } from "vitest";
import {
  capSelection,
  casesQuery,
  createdOfUri,
  filterCaseHits,
  filterLessonHits,
  inArea,
  lessonRowQuery,
  MAX_FINDS_PER_ROUND,
  parseCaseHeader,
  planFinds,
  rankCases,
  rankLessons,
  selectRound,
  SELECTION_CAPS,
  type FindHit,
  type FindOutcome,
  type SelectionRow,
} from "../src/memory/selection.js";

const ROOT = "viking://user/reviewer/memories";
const EXP = `${ROOT}/experiences`;
const CASES = `${ROOT}/finding-cases`;

/** A typed lesson's text (the header `viking_write` writes, then prose). */
function lesson(
  kind: string,
  over: Partial<{ lens: string; cls: string; paths: string; evidence: string; body: string }> = {},
): string {
  return [
    `#lesson kind=${kind} lens=${over.lens ?? "pass-baseline"} class=${over.cls ?? "baseline.scope"} ` +
      `paths=${over.paths ?? "**"} evidence=${over.evidence ?? "pr:1"}`,
    over.body ?? "A lesson body.",
  ].join("\n");
}

function hit(name: string, text: string, score = 0.5, area = EXP): FindHit {
  return { uri: `${area}/${name}`, score, text };
}

const ctx = {
  root: ROOT,
  lens: "pass-baseline",
  files: ["backend/api/views.py", "docs/guide.md"],
  retired: new Set<string>(),
  suppressed: new Set<string>(),
};

describe("filterLessonHits — the typed header decides eligibility", () => {
  it("keeps a lesson for its lens whose path glob matches a file", () => {
    const { eligible, dropped } = filterLessonHits(
      [hit("20261001T100000-a.md", lesson("dont-raise", { paths: "docs/**" }))],
      ctx,
    );
    expect(eligible.map((c) => c.uri)).toEqual([`${EXP}/20261001T100000-a.md`]);
    expect(eligible[0]!.pathHit).toBe(true);
    expect(dropped).toEqual({});
  });

  it("drops everything outside the searched area — folders, blurbs, other areas", () => {
    const { eligible, dropped } = filterLessonHits(
      [
        { uri: EXP, score: 0.9, text: lesson("look-for") },
        hit(".abstract.md", lesson("look-for")),
        hit("x.md", lesson("look-for"), 0.9, `${ROOT}/events`),
        hit("x.md", lesson("look-for"), 0.9, `${ROOT}/preferences/pinned`),
        { uri: `${EXP}/sub/x.md`, score: 0.9, text: lesson("look-for") },
        hit("x.md", lesson("look-for"), 0.9, "viking://resources"),
      ],
      ctx,
    );
    expect(eligible).toEqual([]);
    expect(dropped["out_of_area"]).toBe(6);
  });

  it("NEVER selects a retired, moved or suppressed entry — by header or by list", () => {
    const retiredByList = hit("b.md", lesson("dont-raise"));
    const { eligible, dropped } = filterLessonHits(
      [
        hit("a.md", `#retired ${lesson("dont-raise")}`),
        retiredByList,
        hit("c.md", "#retired #moved moved-to=experiences/z.md\nThis entry moved."),
        hit("d.md", lesson("dont-raise")),
      ],
      { ...ctx, retired: new Set([retiredByList.uri]), suppressed: new Set([`${EXP}/d.md`]) },
    );
    expect(eligible).toEqual([]);
    expect(dropped).toEqual({ retired: 2, moved: 1, suppressed: 1 });
  });

  it("an event, an ops note or prose is no lesson; a lesson of unknown polarity reaches nobody", () => {
    const { eligible, dropped } = filterLessonHits(
      [
        hit("f.md", "#feedback kind=feedback pr=5 type: false-positive — no"),
        hit("o.md", "kind=ops area=operations the daemon restarted"),
        hit("p.md", "Just some prose about the repo."),
        hit("u.md", "#eod-learning Something learned, polarity never said."),
      ],
      ctx,
    );
    expect(eligible).toEqual([]);
    expect(dropped).toEqual({ not_lesson: 3, kind_unknown: 1 });
  });

  it("the row's lens must be in lens=, and a named path glob must match one of the row's files", () => {
    const { eligible, dropped } = filterLessonHits(
      [
        hit("l.md", lesson("dont-raise", { lens: "pass-security" })),
        hit("p.md", lesson("dont-raise", { paths: "frontend/**" })),
        hit("ok.md", lesson("dont-raise", { lens: "pass-security,pass-baseline" })),
      ],
      ctx,
    );
    expect(eligible.map((c) => c.uri)).toEqual([`${EXP}/ok.md`]);
    expect(dropped).toEqual({ lens: 1, paths: 1 });
  });

  it("a legacy convention names no lens and no path: it is for every lens", () => {
    const { eligible } = filterLessonHits(
      [hit("c.md", "#convention #corpus topic=naming source=docs/x.md Use snake_case.")],
      { ...ctx, lens: "pass-ui" },
    );
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.lesson.kind).toBe("convention");
    expect(eligible[0]!.pathHit).toBe(false);
  });

  it("as_of keeps only lessons created strictly before it — an undated one is not provably older", () => {
    const { eligible, dropped } = filterLessonHits(
      [
        hit("20260901T080000-old.md", lesson("look-for")),
        hit("20261005-eod-new.md", lesson("look-for")),
        hit("20261003T000000-sameday.md", lesson("look-for")),
        hit("undated.md", lesson("look-for")),
      ],
      { ...ctx, asOf: "2026-10-03" },
    );
    expect(eligible.map((c) => c.uri)).toEqual([`${EXP}/20260901T080000-old.md`]);
    expect(dropped).toEqual({ as_of: 3 });
    // Without as_of, all four stand.
    expect(
      filterLessonHits(
        [hit("undated.md", lesson("look-for")), hit("20261005-eod-new.md", lesson("look-for"))],
        ctx,
      ).eligible,
    ).toHaveLength(2);
  });

  it("a duplicate URI counts once", () => {
    const { eligible, dropped } = filterLessonHits(
      [hit("a.md", lesson("look-for"), 0.2), hit("a.md", lesson("look-for"), 0.9)],
      ctx,
    );
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.score).toBe(0.9);
    expect(dropped).toEqual({ duplicate: 1 });
  });
});

describe("rankLessons — pinned > path hit > lens hit > evidence > recency > URI, never the score", () => {
  it("orders by the keys, and the engine's score never decides", () => {
    const hits = [
      hit(
        "20260101T000000-recent-low.md",
        lesson("look-for", { lens: "pass-baseline", paths: "**", evidence: "pr:1" }),
        0.99,
      ),
      hit(
        "20250101T000000-path.md",
        lesson("look-for", { paths: "backend/**", evidence: "pr:1" }),
        0.01,
      ),
      hit("20250101T000000-evidence.md", lesson("look-for", { evidence: "pr:1,pr:2,pr:3" }), 0.02),
      hit("nolens.md", "#convention #corpus topic=x source=y conv", 0.98),
      hit("20250101T000000-a.md", lesson("look-for"), 0.5),
      hit("20250101T000000-b.md", lesson("look-for"), 0.6),
    ];
    const { eligible } = filterLessonHits(hits, ctx);
    const order = rankLessons(eligible, "pass-baseline").map((c) => c.uri.slice(EXP.length + 1));
    // `**` is a path hit like any other glob that matched; the convention
    // (no paths, no lens) ranks last.
    expect(order).toEqual([
      "20250101T000000-evidence.md",
      "20260101T000000-recent-low.md",
      "20250101T000000-a.md",
      "20250101T000000-b.md",
      "20250101T000000-path.md",
      "nolens.md",
    ]);
  });
});

describe("rankLessons — a path hit outranks a lens hit, and a lens hit outranks neither", () => {
  it("path-only > lens-only > plain, whatever the evidence and the date", () => {
    const hits = [
      // Lens hit, no paths=: more evidence and newer than the path-only one.
      hit(
        "20261001T000000-lens-only.md",
        "#lesson kind=look-for lens=pass-baseline class=baseline.x evidence=pr:1,pr:2,pr:3,pr:4\nBody.",
      ),
      // Path hit, no lens=.
      hit(
        "20250101T000000-path-only.md",
        "#lesson kind=look-for class=baseline.y paths=backend/** evidence=pr:1\nBody.",
      ),
      // Neither: a lens-less, path-less lesson (every lens's), the most evidence of all.
      hit(
        "20261005T000000-plain.md",
        "#lesson kind=look-for class=baseline.z evidence=pr:1,pr:2,pr:3,pr:4,pr:5,pr:6\nBody.",
      ),
    ];
    const { eligible } = filterLessonHits(hits, ctx);
    expect(eligible).toHaveLength(3);
    expect(rankLessons(eligible, "pass-baseline").map((c) => c.uri.slice(EXP.length + 1))).toEqual([
      "20250101T000000-path-only.md",
      "20261001T000000-lens-only.md",
      "20261005T000000-plain.md",
    ]);
  });
});

describe("capSelection — items and tokens, every cut listed", () => {
  it("cuts past the item cap and past the token budget; a smaller later item still fits", () => {
    const items = [
      { uri: "a", tokens: 500 },
      { uri: "b", tokens: 600 },
      { uri: "c", tokens: 300 },
      { uri: "d", tokens: 50 },
      { uri: "e", tokens: 10 },
    ];
    const { selected, cuts } = capSelection(items, { items: 3, tokens: 1200 });
    expect(selected.map((s) => s.uri)).toEqual(["a", "b", "d"]);
    expect(cuts).toEqual([
      { uri: "c", reason: "tokens" },
      { uri: "e", reason: "items" },
    ]);
  });

  it("the contract's caps", () => {
    expect(SELECTION_CAPS).toEqual({
      row: { items: 6, tokens: 1200 },
      cases: { items: 8, tokens: 2000 },
      validator: { items: 20, tokens: 2500 },
    });
  });
});

describe("cases", () => {
  const caseText = (
    over: Partial<{
      pr: number;
      path: string;
      lens: string;
      replies: number;
      posted: string;
      retired: boolean;
    }> = {},
  ) =>
    `${over.retired ? "#retired " : ""}#case kind=case case=${over.pr ?? 9}-r1-abc pr=${over.pr ?? 9} round=1 rounds=1 lens=${over.lens ?? "pass-baseline"} ` +
    `finding_kind=scope severity=P2 path=${(over.path ?? "backend/api/views.py").replace(/ /g, "%20")} lines=10 fate=refuted_conceded ` +
    `posted=${over.posted ?? "2026-09-01T10:00:00Z"} replies=${over.replies ?? 1}\nA finding the reviewer posted…`;

  it("parses the case header (path decoded) and refuses a withdrawn one", () => {
    expect(parseCaseHeader(caseText({ path: "a dir/x.py" }))).toMatchObject({
      pr: 9,
      path: "a dir/x.py",
      lens: ["pass-baseline"],
      fate: "refuted_conceded",
      replies: 1,
    });
    expect(parseCaseHeader(caseText({ retired: true }))).toBeNull();
    expect(parseCaseHeader("#lesson kind=case pr=1")).toBeNull();
  });

  it("keeps only other PRs' cases on THIS PR's files, ranked by shared lens > replies > recency", () => {
    const hits = [
      hit("case-9-r1-a.md", caseText({ replies: 1 }), 0.9, CASES),
      hit("case-8-r1-b.md", caseText({ pr: 8, replies: 5 }), 0.1, CASES),
      hit("case-7-r1-c.md", caseText({ pr: 7, lens: "pass-ui", replies: 9 }), 0.5, CASES),
      hit("case-6-r1-d.md", caseText({ pr: 6, path: "other/file.py" }), 0.5, CASES),
      hit("case-5-r1-e.md", caseText({ pr: 5 }), 0.5, CASES),
      hit("case-4-r1-f.md", caseText({ pr: 42 }), 0.5, CASES),
      hit("case-3-r1-g.md", caseText({ pr: 3, retired: true }), 0.5, CASES),
    ];
    const { eligible, dropped } = filterCaseHits(hits, {
      root: ROOT,
      pr: 42,
      files: ["backend/api/views.py"],
      lenses: ["pass-baseline"],
      retired: new Set(),
      suppressed: new Set([`${CASES}/case-5-r1-e.md`]),
    });
    expect(dropped).toEqual({ same_pr: 1, paths: 1, suppressed: 1, retired: 1 });
    expect(eligible.map((c) => c.uri.slice(CASES.length + 1)).sort()).toEqual([
      "case-7-r1-c.md",
      "case-8-r1-b.md",
      "case-9-r1-a.md",
    ]);
    // The ORDER: a shared lens first (more replies first among those), then
    // the rest — the most-replied case without a shared lens ranks last.
    expect(rankCases(eligible).map((c) => c.uri.slice(CASES.length + 1))).toEqual([
      "case-8-r1-b.md", // pass-baseline, 5 replies
      "case-9-r1-a.md", // pass-baseline, 1 reply
      "case-7-r1-c.md", // pass-ui, 9 replies
    ]);
  });

  it("ties on lens and replies break by recency, then URI — and never by the engine's score", () => {
    const hits = [
      hit("case-1-r1-a.md", caseText({ pr: 1, posted: "2026-09-01T00:00:00Z" }), 0.99, CASES),
      hit("case-2-r1-b.md", caseText({ pr: 2, posted: "2026-09-03T00:00:00Z" }), 0.01, CASES),
      hit("case-3-r1-c.md", caseText({ pr: 3, posted: "2026-09-02T00:00:00Z" }), 0.5, CASES),
      hit("case-4-r1-d.md", caseText({ pr: 4, posted: "2026-09-02T00:00:00Z" }), 0.7, CASES),
    ];
    const ctx2 = {
      root: ROOT,
      pr: 42,
      files: ["backend/api/views.py"],
      lenses: ["pass-baseline"],
      retired: new Set<string>(),
      suppressed: new Set<string>(),
    };
    const order = (h: FindHit[]) =>
      rankCases(filterCaseHits(h, ctx2).eligible).map((c) => c.uri.slice(CASES.length + 1));
    expect(order(hits)).toEqual([
      "case-2-r1-b.md",
      "case-3-r1-c.md",
      "case-4-r1-d.md",
      "case-1-r1-a.md",
    ]);
    expect(order([...hits].reverse().map((h, i) => ({ ...h, score: i / 4 })))).toEqual(order(hits));
  });

  it("as_of holds out a case posted on or after it; a moved case is no case", () => {
    const { eligible, dropped } = filterCaseHits(
      [
        hit("case-8-r1-new.md", caseText({ pr: 8, posted: "2026-09-01T10:00:00Z" }), 0.5, CASES),
        hit("case-7-r1-old.md", caseText({ pr: 7, posted: "2026-08-31T10:00:00Z" }), 0.5, CASES),
      ],
      {
        root: ROOT,
        pr: 42,
        files: ["backend/api/views.py"],
        lenses: ["pass-baseline"],
        retired: new Set(),
        suppressed: new Set(),
        asOf: "2026-09-01",
      },
    );
    expect(eligible.map((c) => c.uri.slice(CASES.length + 1))).toEqual(["case-7-r1-old.md"]);
    expect(dropped).toEqual({ as_of: 1 });
    expect(parseCaseHeader(`#retired #moved moved-to=finding-cases/x.md ${caseText()}`)).toBeNull();
    expect(parseCaseHeader(`#moved ${caseText()}`)).toBeNull();
  });
});

describe("planFinds", () => {
  const rows: SelectionRow[] = [
    { row: 0, lens: "pass-baseline", agent: "pass-baseline--sol-med" },
    { row: 1, lens: "pass-baseline", agent: "pass-baseline--sol-med" },
    { row: 2, lens: "pass-sweep", agent: "pass-sweep--sol-low", focus: ["docs/guide.md"] },
    { row: 3, lens: "pass-validate", agent: "pass-validate--sol-high" },
  ];

  it("asks identical queries once, the cases find first", () => {
    const plan = planFinds({
      title: "Add a guide",
      rows,
      prFiles: ["docs/guide.md", "backend/x.py"],
    });
    expect(plan.finds[0]!.area).toBe("finding-cases");
    expect(plan.casesKey).toBe(plan.finds[0]!.key);
    expect(plan.rowKey.get(0)).toBe(plan.rowKey.get(1));
    expect(plan.finds).toHaveLength(4);
    expect(plan.finds.find((f) => f.key === plan.rowKey.get(2))!.query).toContain("docs");
    expect(lessonRowQuery({ title: "T", lens: "pass-sweep", files: ["docs/a.md"] })).toBe(
      "T — docs .md — sweep",
    );
    expect(casesQuery({ title: "T", files: ["b.py", "a.py", "b.py"] })).toBe("T — a.py b.py");
  });

  it("caps the finds per round; the rows past it are recorded find_cap", () => {
    const many: SelectionRow[] = Array.from({ length: 40 }, (_, i) => ({
      row: i,
      lens: "pass-sweep",
      agent: "pass-sweep--sol-low",
      focus: [`dir${i}/f.py`],
    }));
    const plan = planFinds({ title: "Wide", rows: many, prFiles: ["x.py"] });
    expect(plan.finds).toHaveLength(MAX_FINDS_PER_ROUND);
    const sel = selectRound({
      pr: 1,
      title: "Wide",
      rows: many,
      prFiles: ["x.py"],
      root: ROOT,
      plan,
      outcomes: new Map(plan.finds.map((f) => [f.key, { status: "ok", hits: [] } as FindOutcome])),
      retired: new Set(),
      suppressed: new Set(),
    });
    expect(sel.filter((s) => s.status === "find_cap")).toHaveLength(40 - (MAX_FINDS_PER_ROUND - 1));
  });
});

/** A finding case's text for PR `pr` on `backend/api/views.py` (the
 * selectRound fixture's changed file). */
function caseText(
  pr: number,
  over: Partial<{ replies: number; lens: string; posted: string }> = {},
): string {
  return (
    `#case kind=case case=${pr}-r1-x pr=${pr} round=1 rounds=1 lens=${over.lens ?? "pass-baseline"} ` +
    `finding_kind=scope severity=P2 path=backend/api/views.py lines=10 fate=fixed ` +
    `posted=${over.posted ?? "2026-09-01T10:00:00Z"} replies=${over.replies ?? 1}\nA finding.`
  );
}

describe("selectRound", () => {
  const rows: SelectionRow[] = [
    { row: 0, lens: "pass-baseline", agent: "pass-baseline--sol-med" },
    { row: 1, lens: "pass-security", agent: "pass-security--sol-high" },
    { row: 2, lens: "pass-validate", agent: "pass-validate--sol-high" },
  ];
  const prFiles = ["backend/api/views.py", "docs/guide.md"];

  function outcomesFor(
    plan: ReturnType<typeof planFinds>,
    byRow: Record<number, FindOutcome>,
    cases: FindOutcome = { status: "ok", hits: [] },
  ): Map<string, FindOutcome> {
    const m = new Map<string, FindOutcome>();
    for (const [row, o] of Object.entries(byRow)) m.set(plan.rowKey.get(Number(row))!, o);
    if (plan.casesKey) m.set(plan.casesKey, cases);
    return m;
  }

  const baselineHits: FindHit[] = [
    hit("20261001T000000-dr1.md", lesson("dont-raise", { paths: "docs/**" })),
    hit("20261001T000000-lf1.md", lesson("look-for", { cls: "missed.backend" })),
    hit("20261001T000000-rf1.md", lesson("repo-fact", { cls: "repo.ci" })),
  ];
  const securityHits: FindHit[] = [
    hit(
      "20261001T000000-dr2.md",
      lesson("dont-raise", { lens: "pass-security", cls: "security.scope" }),
    ),
  ];
  const validatorHits: FindHit[] = [
    hit(
      "20261001T000000-v1.md",
      lesson("repo-fact", { lens: "pass-validate", cls: "validate.ci" }),
    ),
    hit("20261001T000000-v2.md", lesson("look-for", { lens: "pass-baseline", cls: "baseline.x" })),
  ];

  it("selects per row; the validator gets every row's dont-raise lessons plus its own", () => {
    const plan = planFinds({ title: "T", rows, prFiles });
    const sel = selectRound({
      pr: 42,
      title: "T",
      rows,
      prFiles,
      root: ROOT,
      plan,
      outcomes: outcomesFor(plan, {
        0: { status: "ok", hits: baselineHits },
        1: { status: "ok", hits: securityHits },
        2: { status: "ok", hits: validatorHits },
      }),
      retired: new Set(),
      suppressed: new Set(),
    });
    expect(sel.map((s) => `${s.role}:${s.row}`)).toEqual([
      "row:0",
      "row:1",
      "validator:2",
      "cases:-1",
    ]);
    expect(sel[0]!.lessons.map((l) => l.uri.slice(EXP.length + 1)).sort()).toEqual([
      "20261001T000000-dr1.md",
      "20261001T000000-lf1.md",
      "20261001T000000-rf1.md",
    ]);
    expect(sel[2]!.lessons.map((l) => l.uri.slice(EXP.length + 1)).sort()).toEqual([
      "20261001T000000-dr1.md",
      "20261001T000000-dr2.md",
      "20261001T000000-v1.md",
    ]);
    expect(sel[2]!.lessons.find((l) => l.uri.endsWith("dr1.md"))).toMatchObject({
      kind: "dont-raise",
      class: "baseline.scope",
      lens: ["pass-baseline"],
      paths: ["docs/**"],
      evidence: 1,
      format: "typed",
    });
  });

  it("a timed-out find delivers nothing for its row; the validator still gets the rows' dont-raise", () => {
    const plan = planFinds({ title: "T", rows, prFiles });
    const sel = selectRound({
      pr: 42,
      title: "T",
      rows,
      prFiles,
      root: ROOT,
      plan,
      outcomes: outcomesFor(
        plan,
        {
          0: { status: "ok", hits: baselineHits },
          1: { status: "timeout" },
          2: { status: "timeout" },
        },
        { status: "unreadable", reason: "find 503: down" },
      ),
      retired: new Set(),
      suppressed: new Set(),
    });
    expect(sel[1]).toMatchObject({ role: "row", status: "timeout", lessons: [] });
    expect(sel[2]).toMatchObject({ role: "validator", status: "timeout" });
    expect(sel[2]!.lessons.map((l) => l.uri)).toEqual([`${EXP}/20261001T000000-dr1.md`]);
    expect(sel[3]).toMatchObject({ role: "cases", status: "unreadable", reason: "find 503: down" });
  });

  it("is DETERMINISTIC over a fake engine: shuffled hits and jittered scores select the same", () => {
    const plan = planFinds({ title: "T", rows, prFiles });
    const many: FindHit[] = Array.from({ length: 12 }, (_, i) =>
      hit(
        `202609${String(10 + i)}T000000-l${i}.md`,
        lesson(i % 3 === 0 ? "dont-raise" : "look-for", {
          evidence: Array.from({ length: (i % 4) + 1 }, (_, k) => `pr:${k + 1}`).join(","),
          paths: i % 2 === 0 ? "backend/**" : "**",
        }),
        i / 12,
      ),
    );
    const run = (hits: FindHit[]) =>
      selectRound({
        pr: 42,
        title: "T",
        rows,
        prFiles,
        root: ROOT,
        plan,
        outcomes: outcomesFor(plan, {
          0: { status: "ok", hits },
          1: { status: "ok", hits: [] },
          2: { status: "ok", hits: [] },
        }),
        retired: new Set(),
        suppressed: new Set(),
      });
    const a = run(many);
    const shuffled = [...many].reverse().map((h, i) => ({ ...h, score: ((i * 7) % 12) / 12 }));
    const b = run(shuffled);
    const strip = (s: ReturnType<typeof run>) =>
      s.map((r) => ({ ...r, lessons: r.lessons.map(({ score: _s, ...l }) => l) }));
    expect(strip(b)).toEqual(strip(a));
    // The row's cap held and every cut is listed.
    expect(a[0]!.lessons).toHaveLength(SELECTION_CAPS.row.items);
    expect(a[0]!.cuts.map((c) => c.reason)).toEqual(
      Array(12 - SELECTION_CAPS.row.items).fill("items"),
    );
  });

  it("each role gets ITS cap: the validator 20 of 25 eligible, the cases 8 of 12 — every cut listed", () => {
    // Five discovery rows, five dont-raise lessons each: 25 the validator may take.
    const LENSES = ["pass-baseline", "pass-security", "pass-ui", "pass-contracts", "pass-data-safety"];
    const five: SelectionRow[] = [
      ...LENSES.map((lens, i) => ({ row: i, lens, agent: `${lens}--sol-med` })),
      { row: 5, lens: "pass-validate", agent: "pass-validate--sol-high" },
    ];
    const plan = planFinds({ title: "T", rows: five, prFiles });
    const byRow: Record<number, FindOutcome> = {};
    for (let i = 0; i < 5; i++)
      byRow[i] = {
        status: "ok",
        hits: Array.from({ length: 5 }, (_, k) =>
          hit(
            `20260901T0000${String(i)}${String(k)}-dr.md`,
            lesson("dont-raise", { lens: LENSES[i]!, cls: `l${i}.k${k}`, body: "Short." }),
          ),
        ),
      };
    byRow[5] = { status: "ok", hits: [] };
    const cases: FindHit[] = Array.from({ length: 12 }, (_, i) =>
      hit(`case-${100 + i}-r1-x.md`, caseText(100 + i), 0.5, CASES),
    );
    const sel = selectRound({
      pr: 42,
      title: "T",
      rows: five,
      prFiles,
      root: ROOT,
      plan,
      outcomes: outcomesFor(plan, byRow, { status: "ok", hits: cases }),
      retired: new Set(),
      suppressed: new Set(),
    });
    const validator = sel.find((x) => x.role === "validator")!;
    expect(validator.lessons).toHaveLength(SELECTION_CAPS.validator.items);
    expect(validator.cuts.map((c) => c.reason)).toEqual(Array(5).fill("items"));
    const casesRec = sel.find((x) => x.role === "cases")!;
    expect(casesRec.cases).toHaveLength(SELECTION_CAPS.cases.items);
    expect(casesRec.cuts.map((c) => c.reason)).toEqual(Array(4).fill("items"));
    // Each row still holds its own 5 (under the row cap of 6).
    expect(sel.filter((x) => x.role === "row").every((x) => x.lessons.length === 5)).toBe(true);
  });

  it("each role's token budget binds — the cases stop at 2,000, the validator at 2,500", () => {
    const big = "x".repeat(4 * 560); // ≈ 585 tokens with a lesson header, ≈ 610 with a case one
    const plan = planFinds({ title: "T", rows, prFiles });
    const sel = selectRound({
      pr: 42,
      title: "T",
      rows,
      prFiles,
      root: ROOT,
      plan,
      outcomes: outcomesFor(
        plan,
        {
          0: {
            status: "ok",
            hits: Array.from({ length: 6 }, (_, k) =>
              hit(`20260901T00000${k}-big.md`, lesson("dont-raise", { cls: `b.k${k}`, body: big })),
            ),
          },
          1: { status: "ok", hits: [] },
          2: { status: "ok", hits: [] },
        },
        {
          status: "ok",
          hits: Array.from({ length: 6 }, (_, i) =>
            hit(`case-${200 + i}-r1-y.md`, `${caseText(200 + i)}\n${big}`, 0.5, CASES),
          ),
        },
      ),
      retired: new Set(),
      suppressed: new Set(),
    });
    const casesRec = sel.find((x) => x.role === "cases")!;
    const caseTokens = casesRec.cases.reduce((n, c) => n + c.tokens, 0);
    expect(casesRec.cases.length).toBe(3);
    expect(caseTokens).toBeLessThanOrEqual(SELECTION_CAPS.cases.tokens);
    expect(casesRec.cuts.map((c) => c.reason)).toEqual(Array(3).fill("tokens"));
    // The row's own budget (1,200) holds two; the validator's (2,500) four.
    const row0 = sel.find((x) => x.role === "row" && x.row === 0)!;
    expect(row0.lessons).toHaveLength(2);
    const validator = sel.find((x) => x.role === "validator")!;
    expect(validator.lessons).toHaveLength(4);
    expect(validator.cuts.map((c) => c.reason)).toEqual(Array(2).fill("tokens"));
  });

  it("a sweep row's lessons are judged against ITS focus files, not the whole PR", () => {
    const sweep: SelectionRow[] = [
      { row: 0, lens: "pass-sweep", agent: "pass-sweep--sol-low", focus: ["backend/x.py"] },
    ];
    const files = ["backend/x.py", "docs/a.md"];
    const plan = planFinds({ title: "T", rows: sweep, prFiles: files });
    const sel = selectRound({
      pr: 42,
      title: "T",
      rows: sweep,
      prFiles: files,
      root: ROOT,
      plan,
      outcomes: outcomesFor(plan, {
        0: {
          status: "ok",
          hits: [
            hit("20261001T000000-docs.md", lesson("dont-raise", { lens: "pass-sweep", paths: "docs/**" })),
          ],
        },
      }),
      retired: new Set(),
      suppressed: new Set(),
    });
    expect(sel[0]).toMatchObject({ role: "row", lessons: [] });
    expect(sel[0]!.dropped).toEqual({ paths: 1 });
  });

  it("the validator's own find: a lens-less DONT-RAISE lesson is its, a lens-less look-for is not", () => {
    const plan = planFinds({ title: "T", rows, prFiles });
    const sel = selectRound({
      pr: 42,
      title: "T",
      rows,
      prFiles,
      root: ROOT,
      plan,
      outcomes: outcomesFor(plan, {
        0: { status: "ok", hits: [] },
        1: { status: "ok", hits: [] },
        2: {
          status: "ok",
          hits: [
            hit(
              "20261001T000000-legacy-dr.md",
              "#lesson kind=dont-raise class=baseline.style evidence=pr:3\nDo not raise style.",
            ),
            hit(
              "20261001T000000-legacy-lf.md",
              "#lesson kind=look-for class=missed.y evidence=pr:4\nLook for y.",
            ),
          ],
        },
      }),
      retired: new Set(),
      suppressed: new Set(),
    });
    expect(sel[2]!.role).toBe("validator");
    expect(sel[2]!.lessons.map((l) => l.uri.slice(EXP.length + 1))).toEqual([
      "20261001T000000-legacy-dr.md",
    ]);
  });

  it("the validator ranks a path hit on ANY changed file, not just the row that found it", () => {
    // The row reviews only backend/; its lesson's glob matches only docs/,
    // which this PR also changes. The row drops it; the validator — which
    // judges the whole PR — finds it through its own find and ranks it a path hit.
    const focused: SelectionRow[] = [
      { row: 0, lens: "pass-sweep", agent: "pass-sweep--sol-low", focus: ["backend/api/views.py"] },
      { row: 1, lens: "pass-validate", agent: "pass-validate--sol-high" },
    ];
    const plan = planFinds({ title: "T", rows: focused, prFiles });
    const docsOnly = hit(
      "20250101T000000-docs-path.md",
      lesson("dont-raise", { lens: "pass-validate", cls: "v.docs", paths: "docs/**" }),
    );
    const noPath = hit(
      "20261001T000000-no-path.md",
      "#lesson kind=dont-raise lens=pass-validate class=v.any evidence=pr:1,pr:2,pr:3\nBody.",
    );
    const sel = selectRound({
      pr: 42,
      title: "T",
      rows: focused,
      prFiles,
      root: ROOT,
      plan,
      outcomes: outcomesFor(plan, {
        0: { status: "ok", hits: [] },
        1: { status: "ok", hits: [noPath, docsOnly] },
      }),
      retired: new Set(),
      suppressed: new Set(),
    });
    const validator = sel.find((x) => x.role === "validator")!;
    expect(validator.lessons.map((l) => l.uri.slice(EXP.length + 1))).toEqual([
      "20250101T000000-docs-path.md",
      "20261001T000000-no-path.md",
    ]);
  });

  it("the cases role is DETERMINISTIC too: shuffled hits and jittered scores select the same", () => {
    const plan = planFinds({ title: "T", rows, prFiles });
    const cases: FindHit[] = Array.from({ length: 12 }, (_, i) =>
      hit(
        `case-${300 + i}-r1-z.md`,
        caseText(300 + i, { replies: i % 4, lens: i % 3 === 0 ? "pass-ui" : "pass-baseline" }),
        i / 12,
        CASES,
      ),
    );
    const run = (h: FindHit[]) =>
      selectRound({
        pr: 42,
        title: "T",
        rows,
        prFiles,
        root: ROOT,
        plan,
        outcomes: outcomesFor(
          plan,
          { 0: { status: "ok", hits: [] }, 1: { status: "ok", hits: [] }, 2: { status: "ok", hits: [] } },
          { status: "ok", hits: h },
        ),
        retired: new Set(),
        suppressed: new Set(),
      }).find((x) => x.role === "cases")!;
    const a = run(cases);
    const b = run([...cases].reverse().map((h, i) => ({ ...h, score: ((i * 5) % 12) / 12 })));
    const strip = (r: ReturnType<typeof run>) => ({
      ...r,
      cases: r.cases.map(({ score: _s, ...c }) => c),
    });
    expect(strip(b)).toEqual(strip(a));
    expect(a.cases).toHaveLength(SELECTION_CAPS.cases.items);
    // A shared lens first: no pass-ui case is selected ahead of a pass-baseline one.
    const lenses = a.cases.map((c) => c.lens[0]);
    expect(lenses.lastIndexOf("pass-baseline")).toBeLessThan(
      lenses.includes("pass-ui") ? lenses.indexOf("pass-ui") : Infinity,
    );
  });

  it("small helpers", () => {
    expect(createdOfUri(`${EXP}/20261007T101500-x.md`)).toBe("2026-10-07T10:15:00");
    expect(createdOfUri(`${EXP}/20261007-eod-x.md`)).toBe("2026-10-07");
    expect(createdOfUri(`${EXP}/x.md`)).toBeNull();
    expect(inArea(`${EXP}/x.md`, ROOT, "experiences")).toBe(true);
    expect(inArea(`${EXP}/x.txt`, ROOT, "experiences")).toBe(false);
  });
});
