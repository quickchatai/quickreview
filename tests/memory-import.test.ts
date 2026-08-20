// the curated-memory import, exercised end to end over the seam:
// an archived memory file read by the SOURCE reader, a fake destination store, no
// subprocess, no ssh, no filesystem except the injected archive seam.
//
// What is pinned here is the ticket's spec: what crosses (pinned standing
// instructions, curated learnings, open bug/feedback threads), what
// deliberately does not (raw daily working notes), that re-running does not
// duplicate, and — because the owner ratified a best-effort import with NO gate
// — that the log names every skipped entry and every failed write.
import { describe, expect, it } from "vitest";
import {
  archiveReadOnly,
  classify,
  importKey,
  importMemory,
  importedText,
  recordingMemoryStore,
  type ArchiveFs,
  type ImportReport,
} from "../src/memory/import.js";
import { parseLegacyMemory as parseMemory } from "../src/memory/legacy-file.js";
import type { MemoryEntry, MemoryOp, MemoryStore, MemoryWriteResult } from "../src/memory/store.js";

const SAMPLE = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#pinned #manual always cite the sha the passes actually read.

#manual never dismiss an approval — ever.

#false-positive #eod-learning [[pr-5308]] compare transforms with the merge base first.

<!-- 2026-08-19 19:02:00 [01a01ac0] -->
#bug #operations guard 2 suppressed a same-head substantive review; evidence PR 5312.

#feedback human [feedback] by pmercier on PR 5320: "too picky about naming" — 2026-08-19

#bug #resolved head_drift logged on every round — fixed in c6ab326.

ran qcr today; dispatched pr-5312 round 2 and watched the ledger tick over.

HANDOFF compacted session state: 3 PRs in flight, overseer idle.
`;

const sourceEntries = (): MemoryEntry[] => parseMemory(SAMPLE);

const rig = (opts: { seed?: MemoryEntry[] } = {}) => {
  const source = recordingMemoryStore(sourceEntries());
  const dest = recordingMemoryStore(opts.seed ?? []);
  return { source, dest };
};

const run = async (over: Partial<Parameters<typeof importMemory>[0]> = {}): Promise<{ report: ImportReport; dest: ReturnType<typeof recordingMemoryStore> }> => {
  const { source, dest } = rig();
  const report = await importMemory({ source, dest, ...over });
  return { report, dest };
};

const byExcerpt = (report: ImportReport, needle: string) => report.imported.find((r) => r.excerpt.includes(needle));
const skipFor = (report: ImportReport, needle: string) => report.skipped.find((s) => s.excerpt.includes(needle));

describe("classify", () => {
  const of = (text: string): MemoryEntry => parseMemory(`<!-- 2026-08-20 10:00:00 [t] -->\n${text}\n`)[0]!;

  it("pinned standing instructions land in the pinned category", () => {
    expect(classify(of("#pinned #manual always cite the sha"))).toEqual({ keep: true, category: "pinned" });
  });

  it("#manual without a pin is a standing instruction", () => {
    expect(classify(of("#manual never dismiss an approval"))).toEqual({ keep: true, category: "standing" });
  });

  it.each([
    "#eod-learning [[pr-1]] lesson",
    "#false-positive [[pr-1]] lesson",
    "#missed-finding [[pr-1]] lesson",
    "#refuted [[pr-1]] lesson",
    "#wontfix-pattern [[pr-1]] lesson",
    "#repo-gotcha [[pr-1]] lesson",
    "#rejected-proposal simplicity-tone-2026-08-19 — too broad",
  ])("curated learning crosses: %s", (text) => {
    expect(classify(of(text))).toEqual({ keep: true, category: "learning" });
  });

  it("open bug and feedback threads keep their own categories", () => {
    expect(classify(of("#bug #operations guard 2 suppressed a review"))).toEqual({ keep: true, category: "bug" });
    expect(classify(of('#feedback human [feedback] on PR 5320: "too picky"'))).toEqual({ keep: true, category: "feedback" });
  });

  it("a closed thread stays behind", () => {
    expect(classify(of("#bug #resolved head_drift — fixed"))).toEqual({ keep: false, reason: "closed-thread" });
    expect(classify(of("#feedback #superseded old shape note"))).toEqual({ keep: false, reason: "closed-thread" });
  });

  it("#wontfix-pattern is a learning, not a closed thread", () => {
    // The closing-tag set is matched exactly — a substring rule would read
    // `wontfix-pattern` as `wontfix` and drop a whole class of lessons.
    expect(classify(of("#bug #wontfix-pattern authors always refuse this"))).toEqual({ keep: true, category: "bug" });
  });

  it("raw daily working notes — no curated tag — do not cross", () => {
    expect(classify(of("ran qcr today; dispatched pr-5312 round 2"))).toEqual({ keep: false, reason: "raw-daily-note" });
    // A bare PR reference parses as a tag token but is not a curated one.
    expect(classify(of("looked at PR #5312 and the ledger"))).toEqual({ keep: false, reason: "raw-daily-note" });
  });

  it("a compaction handoff block is not a lesson", () => {
    expect(classify(of("HANDOFF compacted session state: 3 PRs in flight"))).toEqual({ keep: false, reason: "session-handoff" });
  });
});

describe("importMemory — what crosses", () => {
  it("imports exactly the curated set and skips the rest", async () => {
    const { report } = await run();
    expect(report.sourceEntries).toBe(8);
    expect(report.imported.map((r) => r.category).sort()).toEqual(["bug", "feedback", "learning", "pinned", "standing"]);
    expect(report.failed).toEqual([]);
    expect(report.skipped.map((s) => s.reason).sort()).toEqual(["closed-thread", "raw-daily-note", "session-handoff"]);
  });

  it("writes each entry verbatim under a provenance header, tags preserved", async () => {
    const { dest } = await run();
    const learning = dest.entries.find((e) => e.text.includes("merge base"))!;
    expect(learning.text).toContain("#false-positive #eod-learning [[pr-5308]] compare transforms with the merge base first.");
    expect(learning.tags).toEqual(expect.arrayContaining(["imported", "learning", "false-positive", "eod-learning"]));
    expect(learning.links).toContain("pr-5308");
    expect(learning.text).toContain("from pi-memory 2026-08-19 18:13:54 [01a01ab3#2]");
  });

  it("machine writes go through `note`, never `add` (they carry their own tags)", async () => {
    const { dest } = await run();
    expect(dest.ops.filter((o) => o.op === "add")).toEqual([]);
    expect(dest.ops.filter((o) => o.op === "note")).toHaveLength(5);
  });

  it("pinned entries are pinned in the destination, not merely tagged", async () => {
    const { report, dest } = await run();
    const pins = dest.ops.filter((o) => o.op === "pin");
    expect(pins).toHaveLength(1);
    expect(report.pins).toHaveLength(1);
    expect(report.pins[0]!.ok).toBe(true);
    // The pinned area is the head — that is what survives injection truncation.
    expect(dest.entries[0]!.pinned).toBe(true);
    expect(dest.entries[0]!.text).toContain("always cite the sha");
  });

  it("a #manual entry that is not pinned is imported without a pin", async () => {
    const { report } = await run();
    expect(byExcerpt(report, "never dismiss an approval")!.category).toBe("standing");
    expect(report.pins.map((p) => p.excerpt).join()).not.toContain("never dismiss");
  });
});

describe("importMemory — idempotency", () => {
  it("a second run over the same source imports nothing", async () => {
    const source = recordingMemoryStore(sourceEntries());
    const dest = recordingMemoryStore();
    const first = await importMemory({ source, dest });
    expect(first.imported).toHaveLength(5);

    const writesAfterFirst = dest.ops.length;
    const second = await importMemory({ source, dest });
    expect(second.imported).toEqual([]);
    expect(second.skipped.filter((s) => s.reason === "already-imported")).toHaveLength(5);
    expect(dest.ops.length).toBe(writesAfterFirst);
  });

  it("identity survives the source entry being pinned or moved afterwards", async () => {
    const source = recordingMemoryStore(sourceEntries());
    const dest = recordingMemoryStore();
    await importMemory({ source, dest });

    // Same words, new address and a pin — the shapes a tidy-up produces.
    const moved = sourceEntries().map((e, i) => ({ ...e, id: "later-batch", ts: "2026-08-21 09:00:00", block: i + 10 }));
    const again = await importMemory({ source: recordingMemoryStore(moved), dest });
    expect(again.imported).toEqual([]);
    expect(again.skipped.filter((s) => s.reason === "already-imported")).toHaveLength(5);
  });

  it("an entry the destination already holds by another route is not duplicated", async () => {
    const already = parseMemory(`<!-- 2026-08-20 08:00:00 [pre] -->\n#manual never dismiss an approval — ever.\n`);
    const { source, dest } = rig({ seed: already });
    const report = await importMemory({ source, dest });
    expect(report.imported).toHaveLength(4);
    expect(skipFor(report, "never dismiss an approval")!.reason).toBe("already-imported");
  });

  it("the same words twice in the source cross once", async () => {
    const dup = [...sourceEntries(), { ...sourceEntries()[1]!, id: "other", block: 0 }];
    const report = await importMemory({ source: recordingMemoryStore(dup), dest: recordingMemoryStore() });
    expect(report.imported).toHaveLength(5);
    expect(report.skipped.filter((s) => s.reason === "duplicate-in-source")).toHaveLength(1);
  });

  it("re-pins an entry an earlier run wrote but left unpinned", async () => {
    const source = recordingMemoryStore(sourceEntries());
    const dest = recordingMemoryStore();
    // Pretend the pin op failed last time: the entry is there, unpinned.
    const pinnedSource = sourceEntries()[0]!;
    const key = importKey(pinnedSource.text);
    const text = importedText(pinnedSource, "pinned", key).replace(/(^|\s)#pinned(?=\s|$)/g, "$1");
    await dest.apply({ op: "note", text });
    dest.entries[0] = { ...dest.entries[0]!, pinned: false, tags: dest.entries[0]!.tags.filter((t) => t !== "pinned") };

    const report = await importMemory({ source, dest });
    expect(report.pins.filter((p) => p.repaired && p.ok)).toHaveLength(1);
    expect(dest.entries[0]!.pinned).toBe(true);
  });
});

describe("importMemory — batching", () => {
  it("splits the writes into batches and re-reads between them", async () => {
    const { source, dest } = rig();
    const reads: number[] = [];
    const counting: MemoryStore = {
      read: async () => {
        const entries = await dest.read();
        reads.push(entries.length);
        return entries;
      },
      search: (q, o) => dest.search(q, o),
      apply: (op) => dest.apply(op),
    };
    const report = await importMemory({ source, dest: counting, batchSize: 2 });
    expect(report.batches).toBe(3);
    expect(report.imported).toHaveLength(5);
    expect(reads.length).toBeGreaterThan(3); // initial + per-batch + pin read-back
  });

  it("an entry another writer lands mid-import is not written twice", async () => {
    const { source, dest } = rig();
    let batch = 0;
    const racing: MemoryStore = {
      read: async () => {
        batch += 1;
        if (batch === 2) {
          // Between batches, someone else writes the entry we planned next.
          const pending = sourceEntries()[2]!;
          await dest.apply({ op: "note", text: importedText(pending, "learning", importKey(pending.text)) });
        }
        return dest.read();
      },
      search: (q, o) => dest.search(q, o),
      apply: (op) => dest.apply(op),
    };
    const report = await importMemory({ source, dest: racing, batchSize: 2 });
    const learningWrites = dest.entries.filter((e) => e.text.includes("merge base"));
    expect(learningWrites).toHaveLength(1);
    expect(report.skipped.some((s) => s.reason === "already-imported" && s.excerpt.includes("merge base"))).toBe(true);
  });
});

describe("importMemory — best effort, no gate", () => {
  const failingDest = (fail: (op: MemoryOp) => boolean, mode: "refuse" | "throw" = "refuse"): MemoryStore & { entries: MemoryEntry[] } => {
    const inner = recordingMemoryStore();
    return {
      entries: inner.entries,
      read: () => inner.read(),
      search: (q, o) => inner.search(q, o),
      apply: (op: MemoryOp): Promise<MemoryWriteResult> => {
        if (!fail(op)) return inner.apply(op);
        if (mode === "throw") return Promise.reject(new Error("transport died"));
        return Promise.resolve({ ok: false, message: "refused: quota exhausted" });
      },
    };
  };

  it("a refused write is recorded and the import carries on", async () => {
    const source = recordingMemoryStore(sourceEntries());
    const dest = failingDest((op) => op.op === "note" && op.text.includes("merge base"));
    const report = await importMemory({ source, dest });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.message).toBe("refused: quota exhausted");
    expect(report.imported).toHaveLength(4); // no abort — the rest still crossed
  });

  it("a throwing destination is an answer, not an exception", async () => {
    const source = recordingMemoryStore(sourceEntries());
    const dest = failingDest(() => true, "throw");
    const report = await importMemory({ source, dest });
    expect(report.imported).toEqual([]);
    expect(report.failed).toHaveLength(5);
    expect(report.failed[0]!.message).toContain("transport died");
  });

  it("a failed pin does not fail the entry that was written", async () => {
    const source = recordingMemoryStore(sourceEntries());
    const dest = failingDest((op) => op.op === "pin");
    const report = await importMemory({ source, dest });
    expect(report.imported).toHaveLength(5);
    expect(report.pins[0]!.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("pin failed:");
  });
});

describe("the log", () => {
  it("names every skipped entry with its reason", async () => {
    const lines: string[] = [];
    const { report } = await run({ log: (l) => lines.push(l) });
    const text = lines.join("\n");
    expect(text).toBe(report.lines.join("\n"));

    expect(text).toContain("skipped 3:");
    for (const s of report.skipped) {
      expect(text).toContain(`${s.reason} (1):`);
      expect(text).toContain(s.excerpt);
      expect(text).toContain(`[${s.id}#${s.block}]`);
    }
  });

  it("reports counts, categories and batches, and never claims a verdict", async () => {
    const { report } = await run();
    const text = report.lines.join("\n");
    expect(text).toContain("source holds 8 entries, destination holds 0");
    expect(text).toContain("pinned 1, standing 1, learning 1, bug 1, feedback 1");
    expect(text).toContain("batch 1/1: 5 write(s), 5 ok, 0 failed");
    expect(text).toContain("done: 5 imported, 0 failed, 3 skipped — best-effort import, no gate");
  });

  it("names failed writes with the store's own refusal", async () => {
    const source = recordingMemoryStore(sourceEntries());
    const inner = recordingMemoryStore();
    const dest: MemoryStore = {
      read: () => inner.read(),
      search: (q, o) => inner.search(q, o),
      apply: (op) => (op.op === "note" && op.text.includes("pmercier") ? Promise.resolve({ ok: false, message: "refused: too long" }) : inner.apply(op)),
    };
    const report = await importMemory({ source, dest });
    const text = report.lines.join("\n");
    expect(text).toContain("failed 1 (left behind — best effort, fix forward):");
    expect(text).toContain("refused: too long");
    expect(text).toContain("too picky about naming");
  });
});

describe("archiveReadOnly", () => {
  const fakeFs = (mode: number): ArchiveFs & { chmodded: Array<{ path: string; mode: number }> } => {
    const chmodded: Array<{ path: string; mode: number }> = [];
    return {
      chmodded,
      stat: () => Promise.resolve({ mode }),
      chmod: (path, m) => {
        chmodded.push({ path, mode: m });
        return Promise.resolve();
      },
    };
  };

  it("leaves the file in place and makes it read-only", async () => {
    const fs = fakeFs(0o100644);
    const res = await archiveReadOnly("/opt/quickreview/MEMORY.md", fs);
    expect(res.ok).toBe(true);
    expect(fs.chmodded).toEqual([{ path: "/opt/quickreview/MEMORY.md", mode: 0o444 }]);
    expect(res.message).toContain("left in place, 0644 → 0444");
  });

  it("an already read-only file is left alone", async () => {
    const fs = fakeFs(0o100444);
    const res = await archiveReadOnly("/m.md", fs);
    expect(res.ok).toBe(true);
    expect(fs.chmodded).toEqual([]);
  });

  it("a failure is reported, never thrown", async () => {
    const res = await archiveReadOnly("/nope.md", { stat: () => Promise.reject(new Error("ENOENT")), chmod: () => Promise.resolve() });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("NOT archived");
  });

  it("the archive result rides the report and the log", async () => {
    const { source, dest } = rig();
    const report = await importMemory({ source, dest, archive: () => archiveReadOnly("/m.md", fakeFs(0o100644)) });
    expect(report.archive?.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("archive: /m.md left in place");
  });

  it("a throwing archive seam does not fail the import", async () => {
    const { source, dest } = rig();
    const report = await importMemory({ source, dest, archive: () => Promise.reject(new Error("read-only fs")) });
    expect(report.imported).toHaveLength(5);
    expect(report.archive?.ok).toBe(false);
  });
});

// The destination is deliberately typed as the seam, never a concrete engine:
// this is the property that let the import be written before OpenViking's
// store existed. If someone narrows it, this stops compiling.
describe("the seam", () => {
  it("takes any MemoryStore as its destination", () => {
    const dest: MemoryStore = recordingMemoryStore();
    expect(typeof dest.apply).toBe("function");
  });
});
