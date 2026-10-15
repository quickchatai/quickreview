// Defect auto-filer (reads reviewer memory in OpenViking) against a temp
// tracker: id claim via exclusive create, the two dedup guards (the
// entry's own `filed=` tag and the ticket-side Memory-key stamp), actor
// qcr-tui, never-throws contract.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEventTags } from "../src/memory/eventtags.js";
import type { MemoryOp, MemoryStore } from "../src/memory/store.js";
import {
  autofileDefects,
  claimNextId,
  filedAs,
  filedKeys,
  memoryKey,
  ticketBody,
  withFiledTag,
  type TrackerPaths,
} from "../src/tui/autofile.js";
import type { MemoryEntry } from "../src/tui/memory.js";

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "reviewer:experiences/20260820T090142-a1b2c3d4.md",
  ts: "2026-08-20 09:01:42",
  day: "2026-08-20",
  block: 0,
  text: "#bug #operations [[stale-recheck-cleanup]] PR #5180 lingering stale_recheck can misclassify the next re-review.",
  tags: ["bug", "operations"],
  links: ["stale-recheck-cleanup"],
  pinned: false,
  hash: "sha256:" + "a".repeat(64),
  ...over,
});

/** Records what the filer wrote back; refuses when told to. */
function recordingStore(ok = true): MemoryStore & { ops: MemoryOp[] } {
  const ops: MemoryOp[] = [];
  return {
    ops,
    read: async () => [],
    search: async () => [],
    apply: async (op) => {
      ops.push(op);
      return ok
        ? { ok: true, message: "updated" }
        : { ok: false, message: "refused: the entry changed since you read it" };
    },
  };
}

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

  it("files a ticket with actor qcr-tui and the Memory-key stamp", async () => {
    const filed = await autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z");
    expect(filed).toHaveLength(1);
    const body = readFileSync(join(root, "efforts/review-sandbox/tickets", filed[0]!.file), "utf8");
    expect(body).toContain("Created: 2026-08-20T10:00:00Z by qcr-tui");
    expect(body).toContain(`Memory-key: ${memoryKey(entry())}`);
    expect(body).toContain("Parent: FT-0026");
    expect(body).toContain("Labels: review-ops, auto-filed");
    expect(body).toContain("stale_recheck");
  });

  it("dedupes: a filed key is never filed twice, across calls", async () => {
    await autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z");
    const again = await autofileDefects(paths, [entry()], "2026-08-20T11:00:00Z");
    expect(again).toHaveLength(0);
    expect(readdirSync(join(root, "efforts/review-sandbox/tickets"))).toHaveLength(1);
  });

  it("stamps the dedup key back onto the entry as a `filed=` tag", async () => {
    const store = recordingStore();
    const filed = await autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z", store);
    expect(store.ops).toHaveLength(1);
    const op = store.ops[0]!;
    expect(op.op).toBe("edit");
    if (op.op !== "edit") throw new Error("unreachable");
    // Addressed at the entry it read, carrying the hash it saw.
    expect(op.id).toBe(entry().id);
    expect(op.expect).toBe(entry().hash);
    expect(parseEventTags(op.text)["filed"]).toBe(filed[0]!.ticketId);
  });

  it("an entry already carrying `filed=` is never filed again — no tracker read needed", async () => {
    const already = entry({ text: withFiledTag(entry().text, "FT-0199") });
    expect(filedAs(already)).toBe("FT-0199");
    const filed = await autofileDefects(paths, [already], "2026-08-20T10:00:00Z");
    expect(filed).toEqual([]);
    expect(readdirSync(join(root, "efforts/review-sandbox/tickets"))).toHaveLength(0);
  });

  it("a refused stamp still cannot produce a duplicate — the Memory-key backstop holds", async () => {
    const store = recordingStore(false);
    await autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z", store);
    const again = await autofileDefects(paths, [entry()], "2026-08-20T11:00:00Z", store);
    expect(again).toEqual([]);
    expect(readdirSync(join(root, "efforts/review-sandbox/tickets"))).toHaveLength(1);
  });

  it("the key survives pin and the filer's own stamp", () => {
    const e = entry();
    const pinned = entry({ text: `#pinned ${e.text}`, pinned: true, tags: [...e.tags, "pinned"] });
    expect(memoryKey(pinned)).toBe(memoryKey(e));
    expect(memoryKey(entry({ text: withFiledTag(e.text, "FT-0199") }))).toBe(memoryKey(e));
  });

  it("withFiledTag lands the tag in the header, where parseEventTags reads it", () => {
    expect(withFiledTag("#bug kind=bug pr=5180 lingering flag.", "FT-0170")).toBe(
      "#bug kind=bug pr=5180 filed=FT-0170 lingering flag.",
    );
    expect(parseEventTags(withFiledTag("#bug lingering flag.", "FT-0170"))["filed"]).toBe(
      "FT-0170",
    );
    // Prose quoting a tag cannot mint one — the header scan stops at the prose.
    expect(
      filedAs(entry({ text: "#bug the author wrote filed=FT-9999 in a comment." })),
    ).toBeUndefined();
  });

  // Only the header's `filed=` is the filer's; one in the prose is the
  // reporter's words. MUTATION: strip `filed=` tokens from the whole text — red.
  it("a `filed=` word in the prose is part of the defect, not bookkeeping", () => {
    const a = entry({ text: "#bug parser rejects filed=one requests" });
    const b = entry({ text: "#bug parser rejects filed=two requests" });
    expect(memoryKey(a)).not.toBe(memoryKey(b));
    expect(memoryKey(entry({ text: withFiledTag(a.text, "FT-0199") }))).toBe(memoryKey(a));
  });

  // The stamp goes through the vocabulary's one header editor, so the body
  // keeps its own shape. MUTATION: rebuild the text with single spaces — red.
  it("the stamp keeps the entry's paragraph breaks", () => {
    expect(withFiledTag("#bug\n\nDescription line.\n\nMore.", "FT-0170")).toBe(
      "#bug filed=FT-0170\n\nDescription line.\n\nMore.",
    );
    expect(withFiledTag("plain prose only", "FT-0170")).toBe("filed=FT-0170\nplain prose only");
  });

  // A ticket is written aside and renamed into place (so the Memory-key scan
  // never takes a torn file for a filing); the staging file never lingers.
  it("a filed ticket leaves no staging file behind", async () => {
    const filed = await autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z");
    expect(readdirSync(join(root, "efforts/review-sandbox/tickets"))).toEqual([filed[0]!.file]);
  });

  it("two distinct defects get two keys and two tickets", async () => {
    const filed = await autofileDefects(
      paths,
      [entry(), entry({ id: "reviewer:experiences/b.md", text: "#bug another defect entirely." })],
      "2026-08-20T10:00:00Z",
    );
    expect(filed).toHaveLength(2);
    expect(new Set(filed.map((f) => f.key)).size).toBe(2);
  });

  it("filedKeys reads stamps back from ticket bodies", async () => {
    await autofileDefects(paths, [entry()], "2026-08-20T10:00:00Z");
    expect(filedKeys(paths).has(memoryKey(entry()))).toBe(true);
  });

  it("never throws when the tracker is missing", async () => {
    const gone: TrackerPaths = {
      root: join(root, "nope"),
      effort: "review-sandbox",
      parent: "FT-0026",
    };
    await expect(autofileDefects(gone, [entry()], "2026-08-20T10:00:00Z")).resolves.toEqual([]);
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
