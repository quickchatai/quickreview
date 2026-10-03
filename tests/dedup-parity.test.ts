// The duplicate merge runs on the code path BOTH routes execute
// (docs/duplicate-merge.md, decision 12: the bench matches a live round 1).
// Given the same findings record and the same config, the live render route
// (scripts/render-review.sh → src/reviewrendercli.ts renderRound) and the
// bench route (src/bench/runner.ts renderBenchOutputs) post the same set, write
// the same body and record the same dispositions.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRound } from "../src/reviewrendercli.js";
import { renderBenchOutputs } from "../src/bench/runner.js";
import type { PostedRenderConfig } from "../src/reviewrender.js";

const RECORD = {
  verdict: "REQUEST_CHANGES",
  summary: "The retry change can loop forever. Two smaller issues ride along.",
  lenses_applied: "baseline, sweep, tests",
  comments_posted: 4,
  findings: [
    { id: "F1", lens: "pass-sweep", disposition: "posted", posted_as: "nit", severity: "P3", path: "src/retry.ts", line: 40, group: "G1", title: "`backoff` resets on every `retry`", body: "Nit body." },
    { id: "F2", lens: "pass-baseline", disposition: "posted", posted_as: "blocker", severity: "P1", confidence: 1, path: "src/retry.ts", line: 42, group: "G2", title: "`retry` loops forever when `maxAttempts` is 0", body: "Blocker body." },
    { id: "F3", lens: "pass-tests", disposition: "posted", posted_as: "question", severity: "P2", path: "tests/retry.test.ts", line: 10, title: "Does the test cover `maxAttempts` of 0?", body: "Question body." },
    { id: "F4", lens: "pass-baseline", disposition: "posted", posted_as: "nit", severity: "P3", path: "src/other.ts", line: 3, title: "typo in a log message", body: "Typo." },
    { id: "F5", lens: "pass-sweep", disposition: "killed", path: "src/retry.ts", line: 41, title: "`retry` dup", reason: "duplicate" },
  ],
};

function bothRoutes(cfg: PostedRenderConfig) {
  const root = mkdtempSync(join(tmpdir(), "qcr-dedup-parity-"));
  try {
    mkdirSync(join(root, "state", "findings"), { recursive: true });
    const recPath = join(root, "state", "findings", "pr-7-round-1.json");
    writeFileSync(recPath, JSON.stringify(RECORD));
    const live = renderRound(root, 7, 1, cfg);
    if ("error" in live) throw new Error(live.error);
    const liveComments = JSON.parse(readFileSync(live.comments, "utf8"));
    const liveBody = readFileSync(live.body, "utf8");
    const liveRecord = JSON.parse(readFileSync(recPath, "utf8"));
    const bench = renderBenchOutputs(structuredClone(RECORD), undefined, cfg);
    return {
      live: { comments: liveComments, body: liveBody, record: liveRecord },
      bench: { comments: bench.rendered.comments, body: bench.rendered.body, record: bench.record },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("live render route ≡ bench render route", () => {
  it("with the duplicate merge on: the same posted set, body and dispositions", () => {
    const { live, bench } = bothRoutes({ review: { dedup_merge: true }, github: { bot_login: "qc-bot" } });
    expect(live.comments).toEqual(bench.comments);
    expect(live.body).toBe(bench.body);
    expect(live.record).toEqual(JSON.parse(JSON.stringify(bench.record)));
    // and the post-check actually ran: F1 merged into F2, 3 inline comments
    expect(live.comments).toHaveLength(3);
    const f1 = (live.record.findings as Array<Record<string, unknown>>).find((f) => f.id === "F1")!;
    expect(f1).toMatchObject({ disposition: "merged", word: "post-check", merged_into: "F2" });
    expect(live.record.comments_posted).toBe(3);
  });

  it("with it off: the same, and nothing merged", () => {
    const { live, bench } = bothRoutes({ review: { dedup_merge: false }, github: { bot_login: "qc-bot" } });
    expect(live.comments).toEqual(bench.comments);
    expect(live.body).toBe(bench.body);
    expect(live.comments).toHaveLength(4);
    expect(live.record).toEqual(RECORD); // the record is not rewritten when nothing changed
  });
});

// The profile's `[posting]` cut moved into the same render step
// (applyPostingPolicyToRecord), so the live shell route enforces it too.
describe("the [posting] cut on both render routes", () => {
  const policy = {
    max_comments: 2,
    nits: "off" as const,
    questions: "post" as const,
    repeat_sites: false,
    body: "full" as const,
    comment_style: "full" as const,
  };
  it("cuts the same items on both routes and records them withheld", () => {
    const { live, bench } = bothRoutes({ review: { dedup_merge: false }, github: { bot_login: "qc-bot" }, posting: policy });
    expect(live.comments).toEqual(bench.comments);
    expect(live.body).toBe(bench.body);
    expect(live.record).toEqual(JSON.parse(JSON.stringify(bench.record)));
    // nits off → F1 and F4 withheld; the blocker and the question post
    const f = live.record.findings as Array<Record<string, unknown>>;
    expect(f.filter((e) => e.disposition === "withheld").map((e) => [e.id, e.word])).toEqual([
      ["F1", "nits-off"],
      ["F4", "nits-off"],
    ]);
    expect(live.comments).toHaveLength(2);
    expect(live.body).toContain("**Verdict: Changes requested** — 1 blocker, 1 question.");
  });
  it("body = verdict renders the verdict line and one sentence on both routes", () => {
    const { live, bench } = bothRoutes({ review: { dedup_merge: true }, posting: { ...policy, body: "verdict" } });
    expect(live.body).toBe(bench.body);
    expect(live.body).toBe("**Verdict: Changes requested** — 1 blocker, 1 question.\n\nThe retry change can loop forever.\n");
  });
  it("a follower row (same_as) is withheld as a repeat site when repeat_sites = false", () => {
    const rec = {
      ...RECORD,
      findings: [
        { id: "L", disposition: "posted", posted_as: "blocker", severity: "P1", path: "a.ts", line: 1, title: "`x` is wrong", body: "b" },
        { id: "S", disposition: "posted", posted_as: "blocker", severity: "P1", path: "b.ts", line: 9, title: "same root cause", body: "f", same_as: "L" },
      ],
    };
    const out = renderBenchOutputs(rec, undefined, { review: {}, posting: { ...policy, nits: "post", max_comments: 0 } });
    expect(out.withheld.map((w) => [w.id, w.word])).toEqual([["S", "repeat-site"]]);
    expect(out.rendered.comments).toHaveLength(1);
  });
  it("a default policy cuts nothing and leaves the record untouched", () => {
    const out = renderBenchOutputs(structuredClone(RECORD), undefined, {
      review: { dedup_merge: false },
      posting: { ...policy, max_comments: 0, nits: "post", repeat_sites: true },
    });
    expect(out.withheld).toEqual([]);
    expect(out.record).toEqual(RECORD);
  });
});
