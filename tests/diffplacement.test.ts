// Where inline comments can go on GitHub's diff (src/diffplacement.ts): the
// pre-POST split, the body fold, and which 422s are about a comment's line.
import { describe, expect, it } from "vitest";
import {
  bodyOnlyPayload,
  foldIntoBody,
  foldPayload,
  isAnchorRejection,
  placeable,
  splitByDiff,
} from "../src/diffplacement.js";
import type { FileList } from "../src/github.js";
import type { InlineComment } from "../src/posting.js";

const c = (path: string, line: number, over: Partial<InlineComment> = {}): InlineComment => ({
  path,
  line,
  side: "RIGHT",
  body: `[nit] on ${path}:${line}`,
  ...over,
});

// Two hunks: new lines 10–13 and 40–41; old lines 10–12 and 38–40.
const PATCH = [
  "@@ -10,3 +10,4 @@ head",
  " a",
  "-b",
  "+b2",
  "+b3",
  " c",
  "@@ -38,3 +40,2 @@",
  " d",
  "-e",
  " f",
].join("\n");

const files = (extra: Partial<FileList> = {}): FileList =>
  Object.assign(
    [
      { filename: "src/x.ts", additions: 2, deletions: 2, status: "modified", patch: PATCH },
      { filename: "translation/id.json", additions: 8300, deletions: 0, status: "added" },
    ],
    extra,
  ) as FileList;

describe("placeable", () => {
  it("places a line inside a hunk, context lines included", () => {
    expect(placeable(files(), c("src/x.ts", 10))).toBe(true); // context
    expect(placeable(files(), c("src/x.ts", 12))).toBe(true); // added
    expect(placeable(files(), c("src/x.ts", 41))).toBe(true);
  });

  it("refuses a line between or past the hunks", () => {
    expect(placeable(files(), c("src/x.ts", 20))).toBe(false);
    expect(placeable(files(), c("src/x.ts", 42))).toBe(false);
    expect(placeable(files(), c("src/x.ts", 9))).toBe(false);
  });

  it("reads a LEFT comment against the old side", () => {
    expect(placeable(files(), c("src/x.ts", 39, { side: "LEFT" }))).toBe(true);
    expect(placeable(files(), c("src/x.ts", 13, { side: "LEFT" }))).toBe(false);
  });

  // MUTATION: test only `line` against the span (drop the start check) — this fails.
  it("needs a range to lie inside ONE hunk", () => {
    expect(placeable(files(), c("src/x.ts", 13, { start_line: 11 }))).toBe(true);
    expect(placeable(files(), c("src/x.ts", 41, { start_line: 12 }))).toBe(false);
  });

  // A large generated file the files API lists with no patch at all.
  it("refuses any line of a file GitHub serves no patch for", () => {
    expect(placeable(files(), c("translation/id.json", 3863))).toBe(false);
  });

  it("refuses a path the diff does not list, unless the list was cut short", () => {
    expect(placeable(files(), c("elsewhere.ts", 1))).toBe(false);
    expect(placeable(files({ truncated: true }), c("elsewhere.ts", 1))).toBeUndefined();
  });

  it("does not judge a range whose two ends are on different sides", () => {
    const x = { ...c("src/x.ts", 12, { start_line: 11 }), start_side: "LEFT" } as InlineComment;
    expect(placeable(files(), x)).toBeUndefined();
  });
});

describe("splitByDiff", () => {
  it("keeps placeable and unjudgeable comments inline and folds the rest, in order", () => {
    const list = [c("src/x.ts", 12), c("translation/id.json", 3863), c("src/x.ts", 20)];
    const { placed, folded } = splitByDiff(list, files());
    expect(placed).toEqual([list[0]]);
    expect(folded).toEqual([list[1], list[2]]);
  });
});

describe("foldIntoBody", () => {
  it("returns the text unchanged with nothing to fold", () => {
    expect(foldIntoBody("body", [], "why")).toBe("body");
  });

  it("appends one section with each comment's place and full text", () => {
    const out = foldIntoBody(
      "body\n",
      [c("a.ts", 5, { start_line: 3 }), c("b.ts", 2, { side: "LEFT" })],
      "why",
    );
    expect(out).toBe(
      "body\n\n### Comments given here instead of inline\n\nwhy" +
        "\n\n---\n\n**`a.ts:3–5`**\n\n[nit] on a.ts:5" +
        "\n\n---\n\n**`b.ts:2` (a removed line)**\n\n[nit] on b.ts:2",
    );
  });

  // MUTATION: drop the `max` check — this fails (the body outgrows the cap).
  it("stops before the cap and says how many were left out", () => {
    const long = Array.from({ length: 5 }, (_, i) => c(`f${i}.ts`, 1, { body: "x".repeat(400) }));
    const out = foldIntoBody("body", long, "why", 1200);
    expect(out.length).toBeLessThanOrEqual(1200);
    expect(out).toMatch(/_3 more comment\(s\) did not fit in the review body\._$/);
  });
});

describe("foldPayload / bodyOnlyPayload", () => {
  const marker = "<!-- qcr-post:v1:7:1:abc -->";
  const payload = {
    commit_id: "h",
    event: "COMMENT" as const,
    body: `Review\n\n${marker}`,
    comments: [c("a.ts", 1), c("b.ts", 2)],
  };

  it("keeps the posting marker the body's last line, exactly once", () => {
    const out = bodyOnlyPayload(payload, marker);
    expect(out.comments).toEqual([]);
    expect(out.body.startsWith("Review\n\n### Comments given here instead of inline")).toBe(true);
    expect(out.body.endsWith(`\n\n${marker}`)).toBe(true);
    expect(out.body.split(marker)).toHaveLength(2);
    expect(out.body).toContain("**`a.ts:1`**");
    expect(out.body).toContain("**`b.ts:2`**");
    expect(payload.comments).toHaveLength(2); // the snapshot is not changed
  });

  it("folds some and keeps the rest inline", () => {
    const out = foldPayload(payload, [payload.comments[1]!], [payload.comments[0]!], "why", marker);
    expect(out.comments).toEqual([payload.comments[0]]);
    expect(out.body).toContain("**`b.ts:2`**");
    expect(out.body).not.toContain("**`a.ts:1`**");
  });

  // An unkeyed post has no marker: the whole body is the text.
  it("folds the whole body when there is no marker", () => {
    const out = bodyOnlyPayload({ ...payload, body: "Plain" });
    expect(out.body.startsWith("Plain\n\n### Comments given here instead of inline")).toBe(true);
  });
});

describe("isAnchorRejection", () => {
  it("reads GitHub's answers about a comment's place", () => {
    expect(isAnchorRejection("Line could not be resolved, and Line could not be resolved")).toBe(
      true,
    );
    expect(isAnchorRejection("Path could not be resolved")).toBe(true);
    expect(isAnchorRejection("Pull request review thread line must be part of the diff")).toBe(
      true,
    );
    expect(
      isAnchorRejection(
        "pull_request_review_thread.start_line must be part of the same hunk as the line.",
      ),
    ).toBe(true);
  });

  it("does not read other refusals as one", () => {
    expect(isAnchorRejection("Body is too long (maximum is 65536 characters)")).toBe(false);
    expect(isAnchorRejection("(GitHub gave no validation detail)")).toBe(false);
    // MUTATION: widen the pattern back to a bare `could not be resolved` — this fails.
    expect(isAnchorRejection("Commit could not be resolved")).toBe(false);
    expect(isAnchorRejection("pull_request_review_thread.body is too long")).toBe(false);
  });
});
