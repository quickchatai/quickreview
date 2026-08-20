// pure filter helpers for the board and the memory timeline.
import { describe, expect, it } from "vitest";
import { applyBoardFilter, applyMemoryFilter, filterLabel, isEmptyBoardFilter, memoryFilterLabel } from "../src/tui/filters.js";

const prs = [
  { number: 1, state: "reviewing", author: "JBennett" },
  { number: 2, state: "queued", author: "mnovak" },
  { number: 3, state: "reviewing", author: "mnovak" },
  { number: 4, state: "awaiting_author" }, // no author field at all
];

describe("applyBoardFilter", () => {
  it("author matches as a case-insensitive substring", () => {
    expect(applyBoardFilter(prs, { author: "bennett" }).map((p) => p.number)).toEqual([1]);
    expect(applyBoardFilter(prs, { author: "NOVAK" }).map((p) => p.number)).toEqual([2, 3]);
  });

  it("a PR with no author never matches an author filter", () => {
    expect(applyBoardFilter(prs, { author: "a" }).map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("state matches exactly — no substring, no case folding", () => {
    expect(applyBoardFilter(prs, { state: "reviewing" }).map((p) => p.number)).toEqual([1, 3]);
    expect(applyBoardFilter(prs, { state: "review" })).toEqual([]);
    expect(applyBoardFilter(prs, { state: "Reviewing" })).toEqual([]);
  });

  it("author + state AND together", () => {
    expect(applyBoardFilter(prs, { author: "novak", state: "reviewing" }).map((p) => p.number)).toEqual([3]);
  });

  it("null/undefined/empty filters return the SAME array unchanged", () => {
    expect(applyBoardFilter(prs, null)).toBe(prs);
    expect(applyBoardFilter(prs, undefined)).toBe(prs);
    expect(applyBoardFilter(prs, {})).toBe(prs);
    expect(applyBoardFilter(prs, { author: "", state: "" })).toBe(prs);
  });

  it("isEmptyBoardFilter agrees with the pass-through cases", () => {
    expect(isEmptyBoardFilter(null)).toBe(true);
    expect(isEmptyBoardFilter({})).toBe(true);
    expect(isEmptyBoardFilter({ author: "" })).toBe(true);
    expect(isEmptyBoardFilter({ author: "x" })).toBe(false);
    expect(isEmptyBoardFilter({ state: "queued" })).toBe(false);
  });
});

describe("filterLabel", () => {
  it("renders both parts and the clear hint", () => {
    expect(filterLabel({ author: "jbennett", state: "reviewing" })).toBe("⛉ author:jbennett · state:reviewing — F clears");
  });

  it("renders single-part filters", () => {
    expect(filterLabel({ author: "jbennett" })).toBe("⛉ author:jbennett — F clears");
    expect(filterLabel({ state: "queued" })).toBe("⛉ state:queued — F clears");
  });

  it("is empty when nothing filters", () => {
    expect(filterLabel(null)).toBe("");
    expect(filterLabel({})).toBe("");
  });
});

const entries = [
  { id: "a", tags: ["bug", "pinned"] },
  { id: "b", tags: ["Bug"] },
  { id: "c", tags: [] },
  { id: "d", tags: ["debug"] }, // substring of nothing — tag match is exact
];

describe("applyMemoryFilter", () => {
  it("tag matches exactly, case-insensitive", () => {
    expect(applyMemoryFilter(entries, "bug").map((e) => e.id)).toEqual(["a", "b"]);
    expect(applyMemoryFilter(entries, "BUG").map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("a leading '#' on the query is ignored", () => {
    expect(applyMemoryFilter(entries, "#bug").map((e) => e.id)).toEqual(["a", "b"]);
    expect(applyMemoryFilter(entries, "##pinned").map((e) => e.id)).toEqual(["a"]);
  });

  it("exact means exact — 'bug' never matches 'debug'", () => {
    expect(applyMemoryFilter(entries, "bug").map((e) => e.id)).not.toContain("d");
  });

  it("null/undefined/empty tag returns the SAME array unchanged", () => {
    expect(applyMemoryFilter(entries, null)).toBe(entries);
    expect(applyMemoryFilter(entries, undefined)).toBe(entries);
    expect(applyMemoryFilter(entries, "")).toBe(entries);
    expect(applyMemoryFilter(entries, "#")).toBe(entries);
  });
});

describe("memoryFilterLabel", () => {
  it("normalizes the tag and carries the clear hint", () => {
    expect(memoryFilterLabel("#Bug")).toBe("⛉ #bug — F clears");
    expect(memoryFilterLabel("pinned")).toBe("⛉ #pinned — F clears");
  });

  it("is empty when inactive", () => {
    expect(memoryFilterLabel(null)).toBe("");
    expect(memoryFilterLabel("")).toBe("");
  });
});
