// The TUI's memory model: timeline ordering and defect selection.
//
// Engine-free by construction — both functions take `MemoryEntry[]` and know
// nothing about where the entries came from. The seam's one implementation is
// exercised in `openviking-store.test.ts`.
import { describe, expect, it } from "vitest";
import { parseLegacyMemory } from "../src/memory/legacy-file.js";
import { defectEntries, timelineOrder } from "../src/tui/memory.js";

// Entry fixtures, written in the archived file's shape and parsed by the
// read-only reader — the shortest honest way to spell four entries with real
// tags, links, days and pin flags.
const SAMPLE = `<!-- 2026-08-18 23:03:08 [01a0165a] -->
#bug #operations [[pass-registry]] On 2026-08-18, built pass definitions
existed but dist omitted the extension.

<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive #eod-learning [[pr-5308]] type: false-positive — compare
transforms with the merge base first.

#refuted #eod-learning [[pr-5242]] type: refuted — External Apps omission is
deliberate.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#pinned #repo-gotcha guard 2 can suppress a same-head substantive review.
`;

const entries = (): ReturnType<typeof parseLegacyMemory> => parseLegacyMemory(SAMPLE);

describe("the entry fixtures", () => {
  it("carry tags, links and multi-line text", () => {
    const e = entries();
    expect(e).toHaveLength(4);
    expect(e[0]!.tags).toEqual(["bug", "operations"]);
    expect(e[0]!.links).toEqual(["pass-registry"]);
    expect(e[0]!.text).toContain("dist omitted the extension.");
    expect(e[1]!.tags).toContain("eod-learning");
    expect(e[3]!.pinned).toBe(true);
  });
});

describe("timelineOrder", () => {
  it("floats pinned first, then newest ts", () => {
    const ordered = timelineOrder(entries());
    expect(ordered[0]!.pinned).toBe(true);
    expect(ordered[1]!.ts).toBe("2026-08-19 18:13:54");
    expect(ordered[ordered.length - 1]!.day).toBe("2026-08-18");
  });
});

describe("defectEntries", () => {
  it("selects #bug entries only", () => {
    const defects = defectEntries(entries());
    expect(defects).toHaveLength(1);
    expect(defects[0]!.id).toBe("01a0165a");
  });
});
