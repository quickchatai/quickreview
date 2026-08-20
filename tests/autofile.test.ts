// Defect auto-filer (FT-0129 §9) against a temp tracker: id claim via
// exclusive create, Memory-key dedup, actor qcr-tui, never-throws contract.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autofileDefects, claimNextId, filedKeys, memoryKey, ticketBody, type TrackerPaths } from "../src/tui/autofile.js";
import type { MemoryEntry } from "../src/tui/memory.js";

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "01a01b03",
  ts: "2026-08-20 09:01:42",
  day: "2026-08-20",
  block: 0,
  text: "#bug #operations [[stale-recheck-cleanup]] PR #5180 lingering stale_recheck can misclassify the next re-review.",
  tags: ["bug", "operations"],
  links: ["stale-recheck-cleanup"],
  pinned: false,
  ...over,
});

let root: string;
let paths: TrackerPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tracker-"));
  mkdirSync(join(root, ".ids"), { recursive: true });
  mkdirSync(join(root, "efforts/review-sandbox/tickets"), { recursive: true });
  writeFileSync(join(root, ".ids", "0132"), "efforts/review-sandbox/tickets/FT-0132-x.md\n");
  paths = { root, effort: "review-sandbox", parent: "FT-0026" };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("autofile", () => {
  it("claims the next id above the current maximum", () => {
    const id = claimNextId(root, (n) => `t/${n}.md`);
    expect(id).toBe("0133");
    expect(readFileSync(join(root, ".ids", "0133"), "utf8")).toContain("t/0133.md");
  });

  it("files a ticket with actor qcr-tui and the Memory-key stamp", () => {
    const filed = autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z");
    expect(filed).toHaveLength(1);
    const body = readFileSync(join(root, "efforts/review-sandbox/tickets", filed[0]!.file), "utf8");
    expect(body).toContain("Created: 2026-08-20T10:00:00Z by qcr-tui");
    expect(body).toContain(`Memory-key: ${memoryKey(entry())}`);
    expect(body).toContain("Parent: FT-0026");
    expect(body).toContain("Labels: review-ops, auto-filed");
    expect(body).toContain("stale_recheck");
  });

  it("dedupes: a filed key is never filed twice, across calls", () => {
    autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z");
    const again = autofileDefects(paths, [entry()], "2026-08-20T11:00:00Z");
    expect(again).toHaveLength(0);
    expect(readdirSync(join(root, "efforts/review-sandbox/tickets"))).toHaveLength(1);
  });

  it("same batch, different blocks = different keys", () => {
    const filed = autofileDefects(paths, [entry(), entry({ block: 1, text: "#bug another defect entirely." })], "2026-08-20T10:00:00Z");
    expect(filed).toHaveLength(2);
    expect(new Set(filed.map((f) => f.key)).size).toBe(2);
  });

  it("filedKeys reads stamps back from ticket bodies", () => {
    autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z");
    expect(filedKeys(paths).has(memoryKey(entry()))).toBe(true);
  });

  it("never throws when the tracker is missing", () => {
    const gone: TrackerPaths = { root: join(root, "nope"), effort: "review-sandbox", parent: "FT-0026" };
    expect(autofileDefects(gone, [entry()], "2026-08-20T10:00:00Z")).toEqual([]);
  });

  it("ticket header follows the grammar (H1, blank, Id: block)", () => {
    const { content } = ticketBody("0133", entry(), paths, "2026-08-20T10:00:00Z");
    const lines = content.split("\n");
    expect(lines[0]!.startsWith("# ")).toBe(true);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("Id: FT-0133");
    expect(content).toMatch(/^Status: open$/m);
  });
});
