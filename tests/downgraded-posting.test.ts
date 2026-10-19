// A validator `downgrade` keeps a finding at the severity it names, so a
// `downgraded` entry that went out under a tag is a posted survivor. The
// renderer, the post-check, the record parser and the bench readers used to
// read only `posted`, which dropped these survivors silently.
import { describe, expect, it } from "vitest";
import { entryDisposition } from "../src/findingkey.js";
import { parseFindingsRecord } from "../src/findingsrecord.js";
import { applyPostingPolicyToRecord, renderReviewFromRecord } from "../src/reviewrender.js";
import { policeBenchOutput } from "../src/bench/benchposting.js";
import { DEFAULT_POSTING_POLICY } from "../src/postingpolicy.js";

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

describe("the posting policy applies to a downgraded survivor like any posted entry", () => {
  const nitsOff = { ...DEFAULT_POSTING_POLICY, nits: "off" as const };

  it("production: nits-off withholds it, so nothing renders", () => {
    const out = applyPostingPolicyToRecord(record([entry(downgraded)]), nitsOff);
    expect(out.withheld).toHaveLength(1);
    expect(renderReviewFromRecord(out.record as Record<string, unknown>).comments).toHaveLength(0);
  });

  it("bench export: nits-off withholds a body-only downgraded survivor", () => {
    const out = policeBenchOutput({
      comments: [],
      reviewMd: "",
      record: record([entry({ ...downgraded, inline: false })]),
      outcome: { verdict: "COMMENT", summary: "s" },
      policy: nitsOff,
    });
    expect(out.report.withheld).toHaveLength(1);
    const f = (out.record as { findings: Array<Record<string, unknown>> }).findings[0]!;
    expect(entryDisposition(f)).toBe("withheld");
  });
});

describe("a downgraded entry with no tag is never silent", () => {
  it("the renderer reports it as a problem", () => {
    const r = renderReviewFromRecord(record([entry({ ...downgraded, posted_as: undefined })]));
    expect(r.problems.some((p) => /downgraded with no posted_as/.test(p))).toBe(true);
  });
});
