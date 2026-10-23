// Typed lessons: the header grammar and the tolerant reader.
//
//   * `#lesson kind=<repo-fact|look-for|dont-raise|convention> lens=<ids>
//     class=<slug> paths=<globs> evidence=<refs>` — rendered from structured
//     fields, unknown lens ids refused (the vendored `viking_write` half is
//     pinned against this one in tests/openviking-fork.test.ts);
//   * a tolerant reader for the legacy formats the live store holds, which
//     never reads body fields from an event entry, never derives placement or
//     retirement from the body, and records where its fields came from;
//   * the health metric: the look-for : don't-raise balance.
import { describe, expect, it } from "vitest";
import {
  balancePhrase,
  candidateIdOfRef,
  coveringLessons,
  LESSON_LENS_IDS,
  lessonBalance,
  parseLesson,
  renderLessonHeader,
  validateLessonFields,
  type IndexedLesson,
} from "../src/memory/lessons.js";
import { ALL_PASSES } from "@quickchatai/pi-quickreview/src/passes.js";

const fields = {
  kind: "look-for",
  lens: ["pass-baseline", "delivery"],
  class: "missed.backend",
  paths: ["backend/**"],
  evidence: ["pr:5312", "cand:c7"],
};

describe("the typed header", () => {
  it("renders on one line and reads back field for field", () => {
    const v = validateLessonFields(fields);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const header = renderLessonHeader(v.fields);
    expect(header).toBe(
      "#lesson kind=look-for lens=pass-baseline,pass-delivery class=missed.backend paths=backend/** evidence=pr:5312,cand:c7",
    );
    const parsed = parseLesson(
      `${header}\n\nTrace None-producing held replies, not just empty text.`,
    );
    expect(parsed).toEqual({
      format: "typed",
      kind: "look-for",
      legacyType: null,
      lens: ["pass-baseline", "pass-delivery"],
      class: "missed.backend",
      paths: ["backend/**"],
      evidence: ["pr:5312", "cand:c7"],
      candidates: [7],
      fieldsSource: "header",
    });
  });

  it("names built passes only — the validator included, an unknown id refused", () => {
    expect([...LESSON_LENS_IDS]).toEqual([...ALL_PASSES]);
    expect(validateLessonFields({ ...fields, lens: ["pass-validate"] }).ok).toBe(true);
    const bad = validateLessonFields({ ...fields, lens: ["pass-baseline", "pass-made-up"] });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toContain("Unknown lens id(s): pass-made-up");
  });

  it("reads only the HEADER: a quoted header in the body mints nothing", () => {
    const text =
      "#refuted #eod-learning\n\ntype: refuted — quoting a comment that said `#lesson kind=look-for class=x`";
    expect(parseLesson(text)?.format).toBe("legacy");
    expect(parseLesson(text)?.kind).toBe("dont-raise");
    // A body line shaped like a typed header is prose.
    expect(
      parseLesson(
        "Just prose.\n#lesson kind=look-for lens=pass-baseline class=a paths=** evidence=pr:1",
      ),
    ).toBeNull();
  });

  it("reads the candidates an evidence list cites", () => {
    expect(candidateIdOfRef("cand:c42")).toBe(42);
    expect(candidateIdOfRef("cand:42")).toBe(42);
    expect(candidateIdOfRef("pr:42")).toBeNull();
    expect(candidateIdOfRef("cand:cx")).toBeNull();
  });
});

describe("the tolerant reader — the live store's legacy shapes", () => {
  it("August EOD lessons: the type from the header, lens and PR from the body", () => {
    const p = parseLesson(
      "#refuted #eod-learning\n\ntype: refuted — Do not frame a stale UI cache as lost workflow state. Lens: UI/backcompat. Evidence: https://github.com/example-org/example-app/pull/4844 (thread X). Date: 2026-08-21.\n\nTags: #refuted #eod-learning",
    );
    expect(p).toMatchObject({
      format: "legacy",
      kind: "dont-raise",
      legacyType: "refuted",
      lens: ["pass-ui", "pass-backcompat"],
      class: null,
      evidence: ["pr:4844"],
      fieldsSource: "body",
    });
  });

  it("the curated pi-memory import: the type sits mid-line after its own tags", () => {
    const p = parseLesson(
      "#imported #learning import-key:sha1:2f3c9494425c8aab — from pi-memory 2026-08-20 18:04:46 [01a01fbe#2]\n#wontfix-pattern #eod-learning [[pr-5197]] type: wontfix-pattern — Do not demand exactly-once delivery here.",
    );
    expect(p).toMatchObject({
      kind: "dont-raise",
      legacyType: "wontfix-pattern",
      evidence: ["pr:5197"],
    });
  });

  it("an imported tag-only lesson keeps the type its source header named", () => {
    // The source `#false-positive #eod-learning …` parses as dont-raise; the
    // import's provenance line in front of it must not lose that.
    const source =
      "#false-positive #eod-learning [[pr-5308]] compare transforms with the merge base.";
    expect(parseLesson(source)?.kind).toBe("dont-raise");
    const p = parseLesson(
      `#imported #learning import-key:sha1:aaaaaaaaaaaaaaaa — from pi-memory 2026-08-19 [01a#1]\n${source}`,
    );
    expect(p).toMatchObject({ kind: "dont-raise", legacyType: "false-positive" });
    // a hash tag in the source's BODY is still not a header
    expect(
      parseLesson(
        "#imported #learning import-key:sha1:bbbbbbbbbbbbbbbb — from pi-memory 2026-08-19 [01a#2]\nnote about #refuted things",
      )?.kind,
    ).toBeNull();
  });

  it("the `# type=… lens=…` header shape", () => {
    const p = parseLesson(
      "# type=false-positive date=2026-08-28 lens=security,data-safety\n\nLesson: prove each sink.",
    );
    expect(p).toMatchObject({
      kind: "dont-raise",
      legacyType: "false-positive",
      lens: ["pass-security", "pass-data-safety"],
    });
  });

  it("an inherited property name is never a legacy type", () => {
    expect(parseLesson("#constructor some note")).toBeNull();
    expect(parseLesson("# Note\n\ntype: constructor")).toBeNull();
    expect(parseLesson("# type=toString lens=security")).toBeNull();
  });

  it("October's headerless shape: type and lens lines", () => {
    const p = parseLesson(
      "# Trace None-producing held replies\n\ntype: missed-finding\nlens: pass-baseline, pass-delivery\ndate: 2026-10-05\nLesson: Independently optional text…",
    );
    expect(p).toMatchObject({
      kind: "look-for",
      legacyType: "missed-finding",
      lens: ["pass-baseline", "pass-delivery"],
      fieldsSource: "body",
    });
    expect(parseLesson("# Gotcha\n\ntype: repo-gotcha\nlens: pass-tests")?.kind).toBe("repo-fact");
  });

  it("corpus conventions: kind convention, a class from the topic", () => {
    expect(
      parseLesson(
        "#convention #corpus topic=typing source=FT-9238 day=2026-08-25 Typing conventions…",
      ),
    ).toMatchObject({ kind: "convention", class: "convention.typing", fieldsSource: "header" });
  });

  it("never reads body fields from an event entry, and never a retired one", () => {
    for (const text of [
      "#feedback kind=feedback pr=5387 day=2026-08-26 signal=feedback_comment … type: refuted — fake",
      "#adjudication #feedback pr=5359 episode=x … type: false-positive — fake",
      "#operations #bug filed=FT-9251 PR #5085 … type: missed-finding",
      "#case kind=case case=5100-r1-abc type: refuted",
      "kind=bug area=operations type: refuted — a defect",
      "#retired #refuted #eod-learning type: refuted — superseded",
      "#retired #moved moved-to=experiences/x.md",
      // An event's `kind=` header with a lesson-shaped body (the relayout's
      // ops entries): the header decides, the body is never read.
      "kind=ops area=operations\n\ntype: refuted\nlens: pass-baseline",
      "kind=bug area=operations\n\n#eod-learning type: false-positive",
      // A typed header with a kind no lesson has is not a lesson either.
      "#lesson kind=nope lens=pass-baseline class=baseline.scope paths=** evidence=pr:1",
    ])
      expect(parseLesson(text), text).toBeNull();
  });

  it("prose with no lesson shape is not a lesson", () => {
    expect(parseLesson("# filed=FT-9291 PR #5374 round 36\n\n#operations #bug")).toBeNull();
    expect(parseLesson("A plain note about the weather.")).toBeNull();
  });
});

describe("the health metric and coverage", () => {
  const typed = (
    id: string,
    kind: string,
    cls: string,
    lens: string[] = ["pass-baseline"],
  ): IndexedLesson => {
    const v = validateLessonFields({ kind, lens, class: cls, paths: ["**"], evidence: ["pr:1"] });
    if (!v.ok) throw new Error(v.error);
    return { ...parseLesson(renderLessonHeader(v.fields))!, id };
  };

  it("counts lessons by kind; the ratio is look-for over dont-raise, null over zero", () => {
    const lessons = [
      typed("experiences/a", "look-for", "missed.backend"),
      typed("experiences/b", "dont-raise", "baseline.scope"),
      typed("experiences/c", "dont-raise", "security.inherited"),
      { ...parseLesson("#refuted #eod-learning\n\ntype: refuted — x")!, id: "experiences/d" },
      { ...parseLesson("#convention topic=logging x")!, id: "experiences/e" },
    ];
    const b = lessonBalance(lessons);
    expect(b).toEqual({
      look_for: 1,
      dont_raise: 3,
      repo_fact: 0,
      convention: 1,
      unknown: 0,
      ratio: 0.33,
      typed: 3,
    });
    expect(balancePhrase(b)).toBe("look-for:dont-raise 1:3 (0.33)");
    expect(lessonBalance([lessons[0]!]).ratio).toBeNull();
  });

  it("a class is covered by a lesson of it, above it or below it; a legacy lesson by its lens", () => {
    const lessons = [
      typed("experiences/a", "dont-raise", "baseline"),
      typed("experiences/b", "dont-raise", "baseline.scope.inherited"),
      typed("experiences/c", "dont-raise", "security.scope"),
      {
        ...parseLesson("#refuted #eod-learning\n\ntype: refuted — x Lens: pass-ui.")!,
        id: "experiences/d",
      },
    ];
    expect(coveringLessons(lessons, "baseline.scope", ["pass-baseline"])).toEqual([
      "experiences/a",
      "experiences/b",
    ]);
    expect(coveringLessons(lessons, "ui.copy", ["pass-ui"])).toEqual(["experiences/d"]);
    expect(coveringLessons(lessons, "missed.backend", [])).toEqual([]);
  });
});
