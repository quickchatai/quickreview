// A validator `downgrade` keeps a finding at the severity it names, so a
// `downgraded` entry that went out under a tag is a posted survivor. The
// renderer, the post-check and the record parser used to read only `posted`,
// which dropped these silently (dbeaver D2 on smoke10, about five comments a
// run — tracker plan/final1-vs-master-2026-10-19.md).
import { describe, expect, it } from "vitest";
import { entryDisposition } from "../src/findingkey.js";
import { parseFindingsRecord } from "../src/findingsrecord.js";
import { renderReviewFromRecord } from "../src/reviewrender.js";

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "c3",
    path: "src/stream.ts",
    line: 40,
    lens: "pass-duplication",
    severity: "P3",
    confidence: 0.8,
    reachability: "routine",
    disposition: "posted",
    posted_as: "nit",
    request: "Reuse the existing stream-opening helper.",
    title: "Reuse the existing stream-opening contract",
    body: "This re-implements openStream; call the existing helper instead.",
    reason: "Duplicate of an existing helper.",
    ...over,
  };
}

function record(findings: Array<Record<string, unknown>>) {
  return {
    pr: 7,
    round_no: 1,
    head_sha: "abc",
    comments_posted: 1,
    verdict: "COMMENT",
    summary: "One nit.",
    lenses_applied: "pass-duplication",
    findings,
  };
}

const downgraded = { disposition: "downgraded", word: "inflated", axis: "severity" };

describe("entryDisposition", () => {
  it("reads a downgraded entry that went out under a tag as posted", () => {
    expect(entryDisposition(entry(downgraded))).toBe("posted");
  });

  it("keeps a downgraded entry with no tag as downgraded", () => {
    expect(entryDisposition(entry({ ...downgraded, posted_as: undefined }))).toBe("downgraded");
    expect(entryDisposition(entry({ ...downgraded, posted_as: "  " }))).toBe("downgraded");
  });

  it("leaves every other disposition as the parser normalises it", () => {
    expect(entryDisposition(entry({}))).toBe("posted");
    expect(entryDisposition(entry({ disposition: "killed" }))).toBe("killed");
    expect(entryDisposition(entry({ disposition: "doubted" }))).toBe("doubted");
    expect(entryDisposition(entry({ disposition: "downgrade" }))).toBe("posted");
  });
});

describe("a validator-downgraded survivor reaches the PR", () => {
  it("is rendered as an inline comment at its downgraded tag", () => {
    const r = renderReviewFromRecord(record([entry(downgraded)]));
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.body).toMatch(/^\[nit\] Reuse the existing stream-opening contract/);
  });

  it("is not rendered when it carries no tag", () => {
    const r = renderReviewFromRecord(record([entry({ ...downgraded, posted_as: undefined })]));
    expect(r.comments).toHaveLength(0);
  });

  it("is recorded as posted, keeping the downgrade's word and axis", () => {
    const parsed = parseFindingsRecord(record([entry(downgraded)]), 7, 1);
    expect(parsed.status).toBe("ok");
    const row = parsed.record!.findings[0]!;
    expect(row.disposition).toBe("posted");
    expect(row.word).toBe("inflated");
    expect(row.axis).toBe("severity");
  });
});
