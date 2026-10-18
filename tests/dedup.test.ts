// src/dedup.ts — the duplicate merge's two deterministic halves
// (docs/duplicate-merge.md): candidate groups before the validator, and the
// render-time post-check over the posted findings.
import { describe, expect, it } from "vitest";
import { clusterFindings, identifiersOf, postCheckRecord, renderGroups } from "../src/dedup.js";
import { renderReviewFromRecord } from "../src/reviewrender.js";

describe("identifiersOf", () => {
  it("takes named identifiers from code spans, not prose, paths or common words", () => {
    const ids = identifiersOf(
      "The `getUserById` call in `src/users.ts` returns `null`; `this.cache.lookup` stale",
    );
    expect([...ids].sort()).toEqual(["cache", "getUserById", "lookup", "this.cache.lookup"].sort());
    expect(identifiersOf("plain prose about users and caches").size).toBe(0);
  });
});

describe("clusterFindings — any one signal joins two candidates", () => {
  it("groups the same file within 10 lines", () => {
    const r = clusterFindings([
      { id: "A", path: "a.py", line: 10, title: "x" },
      { id: "B", path: "a.py", line: 19, title: "y" },
      { id: "C", path: "a.py", line: 40, title: "z" },
    ]);
    expect(r.groups).toEqual([
      { group: "G1", members: ["A", "B"], signals: ["close-lines"], identifiers: [] },
    ]);
    expect(r.singletons).toEqual(["C"]);
  });
  it("groups across files on a shared identifier, and transitively", () => {
    const r = clusterFindings([
      { id: "A", path: "svc.ts", line: 5, title: "`computeCap` floors instead of rounding" },
      { id: "B", path: "svc.test.ts", line: 90, title: "test pins `computeCap` to the wrong cap" },
      { id: "C", path: "svc.test.ts", line: 95, title: "assertion message typo" },
      { id: "D", path: "other.ts", line: 1, title: "unrelated" },
    ]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.members).toEqual(["A", "B", "C"]);
    expect(r.groups[0]!.signals).toEqual(["close-lines", "shared-identifier"]);
    expect(r.groups[0]!.identifiers).toEqual(["computeCap"]);
    expect(r.singletons).toEqual(["D"]);
  });
  it("groups on the same fix target", () => {
    const r = clusterFindings([
      { id: "A", path: "x.go", line: 1, fix_target: "`pkg.Init`" },
      { id: "B", path: "y.go", line: 300, fix_target: "pkg.init" },
    ]);
    expect(r.groups[0]!.signals).toEqual(["same-fix-target"]);
  });
  it("is deterministic and leaves unrelated candidates alone", () => {
    const c = [
      { id: "A", path: "a.py", line: 1, title: "`foo` breaks" },
      { id: "B", path: "b.py", line: 200, title: "`bar` breaks" },
    ];
    expect(clusterFindings(c)).toEqual(clusterFindings(c));
    expect(clusterFindings(c).groups).toEqual([]);
  });
  it("renders groups for the validator task string", () => {
    const c = [
      {
        id: "A",
        path: "a.py",
        line: 1,
        severity: "P1",
        lens: "pass-baseline",
        title: "`foo` breaks",
      },
      { id: "B", path: "a.py", line: 3, severity: "P3", lens: "pass-sweep", title: "`foo` again" },
    ];
    const text = renderGroups(clusterFindings(c), new Map(c.map((x) => [x.id, x])));
    expect(text).toContain("**G1** (close-lines)");
    expect(text).toContain("A `a.py:1` [P1] pass-baseline");
  });
});

describe("postCheckRecord — one root cause posted twice becomes one comment", () => {
  const rec = () => ({
    comments_posted: 3,
    findings: [
      {
        id: "F1",
        disposition: "posted",
        posted_as: "nit",
        severity: "P3",
        path: "a.ts",
        line: 10,
        group: "G1",
        title: "`retry` misses",
        body: "nit body",
      },
      {
        id: "F2",
        disposition: "posted",
        posted_as: "blocker",
        severity: "P1",
        path: "a.ts",
        line: 12,
        group: "G2",
        title: "`retry` loops forever",
        body: "blocker body",
      },
      {
        id: "F3",
        disposition: "posted",
        posted_as: "nit",
        severity: "P3",
        path: "a.ts",
        line: 11,
        group: "G3",
        title: "unrelated `other`",
        body: "b",
      },
      { id: "F4", disposition: "killed", path: "a.ts", line: 10, title: "`retry`" },
    ],
  });
  it("merges same file + overlapping lines + shared identifier; the higher severity leads", () => {
    const input = rec();
    const { record, merges } = postCheckRecord(input);
    expect(merges).toEqual([{ follower: "F1", lead: "F2", path: "a.ts", line: 10 }]);
    const f = (record as { findings: Array<Record<string, unknown>> }).findings;
    expect(f[0]).toMatchObject({
      id: "F1",
      disposition: "merged",
      word: "post-check",
      merged_into: "F2",
      withheld_as: "nit",
    });
    expect(f[0]!.posted_as).toBeUndefined();
    expect(f[1]!.body).toBe("blocker body\n\nAlso at `a.ts:10`.");
    expect(f[2]!.disposition).toBe("posted"); // no shared identifier
    expect(f[3]!.disposition).toBe("killed");
    expect((record as { comments_posted: number }).comments_posted).toBe(2);
    expect(input.findings[0]!.disposition).toBe("posted"); // input not mutated
  });
  it("keeps existing repeat-site followers in the surviving post-check root cause", () => {
    const input = rec();
    const follower = { id: "repeat", disposition: "posted", posted_as: "nit", same_as: "F1",
      path: "a.ts", line: 90, title: "A repeated site", body: "same cause" };
    const { record } = postCheckRecord({ ...input, findings: [...input.findings.slice(0, 2), follower] });
    const rendered = renderReviewFromRecord(record, { verdict: "REQUEST_CHANGES", bodyMode: "verdict" });
    expect(rendered.body.split("\n")[0]).toContain("1 blocker");
    expect(rendered.body.split("\n")[0]).not.toContain("nit");
  });
  it("a lead later merged into a stronger one hands on every site it absorbed", () => {
    const entry = (id: string, posted_as: string, severity: string, line: number) => ({
      id,
      disposition: "posted",
      posted_as,
      severity,
      path: "a.ts",
      line,
      group: `G-${id}`,
      title: "`retry` misbehaves",
      body: `${id} body`,
    });
    const { record, merges } = postCheckRecord({
      findings: [
        entry("Q", "question", "P2", 10),
        entry("N", "nit", "P3", 11),
        entry("B", "blocker", "P1", 12),
      ],
    });
    expect(merges).toEqual([
      { follower: "N", lead: "Q", path: "a.ts", line: 11 },
      { follower: "Q", lead: "B", path: "a.ts", line: 10 },
    ]);
    const f = (record as { findings: Array<Record<string, unknown>> }).findings;
    expect(f[2]).toMatchObject({ disposition: "posted" });
    expect(f[2]!.body).toBe("B body\n\nAlso at `a.ts:10`.\n\nAlso at `a.ts:11`.");
  });
  it("is a no-op (same object) when nothing merges", () => {
    const r = {
      findings: [
        { id: "X", disposition: "posted", path: "a.ts", line: 1, group: "G1", title: "`a`" },
      ],
    };
    expect(postCheckRecord(r).record).toBe(r);
    expect(postCheckRecord(null).merges).toEqual([]);
  });
  it("leaves a follower row the session already linked", () => {
    const r = {
      findings: [
        {
          id: "L",
          disposition: "posted",
          posted_as: "blocker",
          path: "a.ts",
          line: 1,
          group: "G1",
          title: "`x` bad",
        },
        {
          id: "S",
          disposition: "posted",
          posted_as: "blocker",
          path: "a.ts",
          line: 2,
          group: "G2",
          title: "`x` bad",
          same_as: "L",
        },
      ],
    };
    expect(postCheckRecord(r).merges).toEqual([]);
  });
  // With bare identifiers recognised, the post-check must not fuse defects
  // the validator judged in one group and kept apart — that merge hides
  // distinct defects.
  const pair = (ga?: string, gb?: string) => ({
    findings: [
      {
        id: "A",
        disposition: "posted",
        posted_as: "blocker",
        severity: "P1",
        path: "a.ts",
        line: 10,
        ...(ga ? { group: ga } : {}),
        title: "`rowCache` keyed by index",
        body: "a",
      },
      {
        id: "B",
        disposition: "posted",
        posted_as: "question",
        severity: "P2",
        path: "a.ts",
        line: 11,
        ...(gb ? { group: gb } : {}),
        title: "`rowCache` never cleared",
        body: "b",
      },
    ],
  });
  it("never merges two survivors the validator judged in one group", () => {
    expect(postCheckRecord(pair("G4", "G4")).merges).toEqual([]);
  });
  it("never merges when either finding carries no group (cannot tell, so no merge)", () => {
    expect(postCheckRecord(pair()).merges).toEqual([]);
    expect(postCheckRecord(pair("G4")).merges).toEqual([]);
    expect(postCheckRecord(pair(undefined, "G5")).merges).toEqual([]);
  });
  it("merges leftovers of different groups, the cases the validator never compared", () => {
    expect(postCheckRecord(pair("G4", "G5")).merges).toEqual([
      { follower: "B", lead: "A", path: "a.ts", line: 11 },
    ]);
  });
  it("ranks [ask your human] and [deferred] by the tag their severity posts under", () => {
    for (const marker of ["ask your human", "[deferred]"]) {
      const r = pair("G4", "G5");
      Object.assign(r.findings[0]!, { posted_as: "nit", severity: "P3" });
      Object.assign(r.findings[1]!, { posted_as: marker, severity: "P1" });
      expect(postCheckRecord(r).merges).toEqual([
        { follower: "A", lead: "B", path: "a.ts", line: 10 },
      ]);
    }
  });
  it("reads a severity in any case, as the posting policy does", () => {
    const r = pair("G4", "G5");
    Object.assign(r.findings[0]!, { posted_as: "question", severity: "P2" });
    Object.assign(r.findings[1]!, { posted_as: "question", severity: " p1 " });
    expect(postCheckRecord(r).merges).toEqual([
      { follower: "A", lead: "B", path: "a.ts", line: 10 },
    ]);
  });
  it("never compares a LEFT (base) line with a RIGHT (head) line", () => {
    const r = pair("G4", "G5");
    Object.assign(r.findings[0]!, { side: "LEFT" });
    expect(postCheckRecord(r).merges).toEqual([]);
    Object.assign(r.findings[1]!, { side: "left" });
    expect(postCheckRecord(r).merges).toEqual([
      { follower: "B", lead: "A", path: "a.ts", line: 11 },
    ]);
  });
  it("a chain of merges never fuses two findings the validator kept apart in one group", () => {
    const entry = (
      id: string,
      group: string,
      posted_as: string,
      severity: string,
      line: number,
    ) => ({
      id,
      disposition: "posted",
      posted_as,
      severity,
      path: "a.ts",
      line,
      group,
      title: "`retry` misbehaves",
      body: `${id} body`,
    });
    const { record, merges } = postCheckRecord({
      findings: [
        entry("A", "G1", "nit", "P3", 10),
        entry("B", "G2", "question", "P2", 11),
        entry("C", "G1", "blocker", "P1", 12),
      ],
    });
    // A folds into B; B (now speaking for G1 too) must not fold into C (G1).
    expect(merges).toEqual([{ follower: "A", lead: "B", path: "a.ts", line: 10 }]);
    const f = (record as { findings: Array<Record<string, unknown>> }).findings;
    expect(f.map((e) => e.disposition)).toEqual(["merged", "posted", "posted"]);
    // Rendering the written-back record again protects the same split.
    const again = postCheckRecord(record);
    expect(again.merges).toEqual([]);
    expect(again.record).toBe(record);
  });
  it("ranks a tag as the renderer reads it, whitespace inside the brackets too", () => {
    const r = pair("G4", "G5");
    Object.assign(r.findings[0]!, { posted_as: "nit", severity: "P3" });
    Object.assign(r.findings[1]!, { posted_as: "[ Blocker ]", severity: "P1" });
    expect(postCheckRecord(r).merges).toEqual([
      { follower: "A", lead: "B", path: "a.ts", line: 10 },
    ]);
  });
  it("reads every spelling of `posted` the record parser folds", () => {
    for (const disposition of ["survived", "Posted", " post "]) {
      const r = pair("G4", "G5");
      for (const e of r.findings) e.disposition = disposition;
      expect(postCheckRecord(r).merges).toEqual([
        { follower: "B", lead: "A", path: "a.ts", line: 11 },
      ]);
    }
  });
  it("names a lead with no id by its record key (`key`, else the parser's fallback)", () => {
    const r = pair("G4", "G5") as { findings: Array<Record<string, unknown>> };
    delete r.findings[0]!.id;
    r.findings[0]!.key = "L";
    delete r.findings[1]!.id;
    r.findings[1]!.lens = "pass-x";
    const { record, merges } = postCheckRecord(r);
    expect(merges).toEqual([{ follower: "pass-x@a.ts:11#1", lead: "L", path: "a.ts", line: 11 }]);
    expect((record as typeof r).findings[1]!.merged_into).toBe("L");
  });
  it("a lead with no body gets the follower's site on the reason it posts", () => {
    const r = pair("G4", "G5") as { findings: Array<Record<string, unknown>> };
    delete r.findings[0]!.body;
    r.findings[0]!.reason = "The cache never shrinks.";
    const f = (postCheckRecord(r).record as typeof r).findings;
    expect(f[0]!.body).toBe("The cache never shrinks.\n\nAlso at `a.ts:11`.");
  });
});
