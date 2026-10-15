// The copy path end to end, below the App: the width table every coordinate
// rests on, the frame's row addressing, the mouse decoder, the cleanup of a
// copied block, and the companion's paste-buffer bridge (pi's `/copy`).
import { describe, expect, it } from "vitest";
import { cellWidth } from "../src/tui/cellwidth.js";
import type { DockerResult, DockerRunner } from "../src/tui/companion.js";
import { MouseDecoder } from "../src/tui/mouse.js";
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  Frame,
  cleanCopiedBlock,
  displayWidth,
  fit,
  sliceDisplay,
} from "../src/tui/paint.js";
import { BUFFER_TAG, CompanionSidebar, splitBufferListing } from "../src/tui/sidebar.js";

const cp = (s: string): number => s.codePointAt(0)!;

describe("cellWidth — the table the screen is laid out by", () => {
  it("counts the board's own East-Asian-Wide chips as two cells", () => {
    // ⛔ (pipeline failed / draining) and ⏳ (deploy drain) are painted by the
    // TUI itself; counted as one, every cell right of them would sit a column off.
    expect(cellWidth(cp("⛔"))).toBe(2);
    expect(cellWidth(cp("⏳"))).toBe(2);
  });

  it("counts the emoji an LLM writes as two cells", () => {
    for (const ch of ["✅", "❌", "⚡", "⭐", "🙂", "🚀"]) expect(cellWidth(cp(ch))).toBe(2);
  });

  it("counts combining marks, ZWJ and variation selectors as zero", () => {
    expect(cellWidth(0x0301)).toBe(0); // combining acute
    expect(cellWidth(0x200d)).toBe(0); // ZWJ
    expect(cellWidth(0xfe0f)).toBe(0); // VS16
    expect(displayWidth("é")).toBe(1);
  });

  it("keeps narrow and ambiguous symbols at one", () => {
    for (const ch of ["a", "─", "│", "✓", "✖", "⏸", "●", "⏎", "▸", "—"])
      expect(cellWidth(cp(ch))).toBe(1);
    expect(cellWidth(cp("漢"))).toBe(2);
  });

  it("fit() pads a row holding a wide glyph to exactly its width", () => {
    const row = fit("⛔ DRAINING — 2 rounds", 30);
    expect(displayWidth(row)).toBe(30);
    // and slicing past it lands on the cell the pointer is on
    expect(sliceDisplay("⛔ab", 2, 4)).toBe("ab");
    expect(sliceDisplay("⛔ab", 1, 3)).toBe(" a"); // half a glyph is a blank cell
  });
});

describe("Frame.render — rows are addressed, never flowed", () => {
  it("places every row with a cursor address", () => {
    const f = new Frame(10, 3);
    f.set(0, "one");
    f.set(1, "two");
    f.set(2, "three");
    const out = f.render();
    expect(out).toContain("\x1b[1;1Hone");
    expect(out).toContain("\x1b[2;1Htwo");
    expect(out).toContain("\x1b[3;1Hthree");
    expect(out.endsWith("\r\n")).toBe(false);
  });

  it("turns autowrap off for the TUI's lifetime and back on after", () => {
    expect(ALT_SCREEN_ON).toContain("\x1b[?7l");
    expect(ALT_SCREEN_OFF).toContain("\x1b[?7h");
  });
});

describe("MouseDecoder — a report split across two reads", () => {
  it("reassembles it instead of losing the point and leaking the tail as text", () => {
    const d = new MouseDecoder();
    const a = d.feed(Buffer.from("\x1b[<32;4"));
    expect(a.events).toEqual([]);
    expect(a.rest.length).toBe(0);
    const b = d.feed(Buffer.from("5;12M"));
    expect(b.events).toEqual([{ kind: "drag", x: 45, y: 12 }]);
    expect(b.rest.length).toBe(0);
  });

  it("never holds a bare Esc back", () => {
    const d = new MouseDecoder();
    expect(d.feed(Buffer.from("\x1b")).rest.toString()).toBe("\x1b");
  });

  it("passes keys through untouched", () => {
    const d = new MouseDecoder();
    const r = d.feed(Buffer.from("j\x1b[<0;3;4Mk"));
    expect(r.events).toEqual([{ kind: "click", x: 3, y: 4 }]);
    expect(r.rest.toString()).toBe("jk");
  });

  it("keeps a UTF-8 character split across two reads whole", () => {
    const d = new MouseDecoder();
    const a = d.feed(Buffer.from([0x61, 0xc3]));
    expect(a.rest.toString("utf8")).toBe("a");
    const b = d.feed(Buffer.from([0xa9, 0x62]));
    expect(b.rest.toString("utf8")).toBe("éb");
  });

  it("keeps a split character beside a split mouse report", () => {
    const d = new MouseDecoder();
    const a = d.feed(Buffer.concat([Buffer.from("x\x1b[<0;3;4M"), Buffer.from([0xe2, 0x82])]));
    expect(a.events).toEqual([{ kind: "click", x: 3, y: 4 }]);
    expect(a.rest.toString("utf8")).toBe("x");
    const b = d.feed(Buffer.concat([Buffer.from([0xac]), Buffer.from("\x1b[<0;5")]));
    expect(b.rest.toString("utf8")).toBe("€");
    const c = d.feed(Buffer.from(";6M"));
    expect(c.events).toEqual([{ kind: "click", x: 5, y: 6 }]);
    expect(c.rest.length).toBe(0);
  });
});

describe("cleanCopiedBlock — a block of screen made into text", () => {
  it("drops a border column caught at either edge", () => {
    expect(cleanCopiedBlock(["│ alpha   │", "│ beta    │"])).toBe("alpha\nbeta");
  });

  it("keeps a │ that is part of only one line's text", () => {
    expect(cleanCopiedBlock(["│ a", "b"])).toBe("│ a\nb");
  });

  it("removes the indent common to every line and keeps relative indent", () => {
    expect(cleanCopiedBlock(["   def f():", "       return 1", ""])).toBe("def f():\n    return 1");
  });

  it("drops leading and trailing blank rows and keeps interior ones", () => {
    expect(cleanCopiedBlock(["", "  one", "", "  two", "  "])).toBe("one\n\ntwo");
  });

  it("is empty for an all-blank block", () => {
    expect(cleanCopiedBlock(["   ", ""])).toBe("");
  });
});

describe("the companion's paste buffers reach the host clipboard (pi /copy)", () => {
  const CFG = { container_name: "qcr-companion", session: "companion" };
  const OK: DockerResult = { ok: true, stdout: "", stderr: "", code: 0 };
  const listing = (...bufs: string[]): string =>
    `pi output\n${bufs.map((b) => `${BUFFER_TAG}${b}\n`).join("")}`;

  it("tags the listing in plain ASCII — tmux -F prints anything else as `_`", () => {
    // Through docker exec (no UTF-8 locale) a non-ASCII marker such as `␞`
    // comes back as `_`, never matches, and no copy ever arrives.
    expect(BUFFER_TAG).toMatch(/^[\x20-\x7e]+$/);
  });

  it("splits the capture from the buffer listing that follows it", () => {
    expect(splitBufferListing(listing("buffer1 200 5", "buffer0 100 3"))).toEqual({
      capture: "pi output\n",
      buffers: ["buffer1 200 5", "buffer0 100 3"],
    });
    expect(splitBufferListing("just a capture\n")).toEqual({
      capture: "just a capture\n",
      buffers: [],
    });
  });

  function rig(listings: string[]) {
    const calls: string[][] = [];
    const docker: DockerRunner = async (argv) => {
      calls.push(argv);
      if (argv.includes("show-buffer")) return { ...OK, stdout: "the **message**\n— done" };
      return { ...OK, stdout: listings.shift() ?? "" };
    };
    const copied: string[] = [];
    const sb = new CompanionSidebar(CFG, docker, { onCopy: (t) => copied.push(t) });
    return { sb, calls, copied };
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("lists the buffers in the SAME docker call as the capture", async () => {
    const { sb, calls } = rig([listing()]);
    await sb.refresh();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(-4, -1)).toEqual([";", "list-buffers", "-F"]);
    expect(sb.lines).toEqual(["pi output"]);
    sb.stop();
  });

  it("treats the first listing as a baseline — a start never re-copies a stale buffer", async () => {
    const { sb, copied, calls } = rig([listing("buffer0 100 3")]);
    await sb.refresh();
    await settle();
    expect(copied).toEqual([]);
    expect(calls.some((c) => c.includes("show-buffer"))).toBe(false);
    sb.stop();
  });

  it("copies a buffer that appears after the baseline, read whole", async () => {
    const { sb, copied, calls } = rig([listing(), listing("buffer0 100 22")]);
    await sb.refresh();
    await sb.refresh();
    await settle();
    expect(copied).toEqual(["the **message**\n— done"]);
    expect(calls.find((c) => c.includes("show-buffer"))).toEqual([
      "exec",
      "qcr-companion",
      "tmux",
      "show-buffer",
      "-b",
      "buffer0",
    ]);
    sb.stop();
  });

  it("copies each new buffer once, not on every refresh", async () => {
    const same = listing("buffer1 200 9", "buffer0 100 3");
    const { sb, copied } = rig([listing("buffer0 100 3"), same, same, same]);
    for (let i = 0; i < 4; i++) await sb.refresh();
    await settle();
    expect(copied).toHaveLength(1);
    sb.stop();
  });

  it("a failed read leaves the buffer new — the next poll reads it again, and a buffer that never reads is given up on", async () => {
    const calls: string[][] = [];
    const reads: DockerResult[] = [
      { ok: false, stdout: "", stderr: "timed out", code: null },
      { ...OK, stdout: "copied at last" },
    ];
    const same = listing("buffer0 100 14");
    const listings = [listing(), same, same, same];
    const docker: DockerRunner = async (argv) => {
      calls.push(argv);
      if (argv.includes("show-buffer")) return reads.shift()!;
      return { ...OK, stdout: listings.shift() ?? "" };
    };
    const copied: string[] = [];
    const sb = new CompanionSidebar(CFG, docker, { onCopy: (t) => copied.push(t) });
    for (let i = 0; i < 4; i++) {
      await sb.refresh();
      await settle();
    }
    expect(copied).toEqual(["copied at last"]);
    expect(calls.filter((c) => c.includes("show-buffer"))).toHaveLength(2);
    sb.stop();

    const failing: string[][] = [];
    const stuck = new CompanionSidebar(
      CFG,
      async (argv) => {
        failing.push(argv);
        if (argv.includes("show-buffer")) return { ok: false, stdout: "", stderr: "", code: 1 };
        return { ...OK, stdout: failing.length === 1 ? listing() : same };
      },
      { onCopy: (t) => copied.push(t) },
    );
    for (let i = 0; i < 8; i++) {
      await stuck.refresh();
      await settle();
    }
    expect(failing.filter((c) => c.includes("show-buffer"))).toHaveLength(3);
    stuck.stop();
  });

  it("a slow read of an older buffer never overwrites a newer copy that landed first", async () => {
    let releaseOld: (r: DockerResult) => void = () => undefined;
    const listings = [
      listing(),
      listing("buffer0 100 3"),
      listing("buffer1 200 3", "buffer0 100 3"),
    ];
    const docker: DockerRunner = async (argv) => {
      if (argv.includes("show-buffer")) {
        if (argv.includes("buffer0")) return new Promise<DockerResult>((r) => (releaseOld = r));
        return { ...OK, stdout: "new" };
      }
      return { ...OK, stdout: listings.shift() ?? "" };
    };
    const copied: string[] = [];
    const sb = new CompanionSidebar(CFG, docker, { onCopy: (t) => copied.push(t) });
    await sb.refresh();
    await sb.refresh(); // buffer0's read starts and hangs
    await sb.refresh(); // buffer1 appears and reads at once
    await settle();
    releaseOld({ ...OK, stdout: "old" });
    await settle();
    expect(copied).toEqual(["new"]);
    sb.stop();
  });

  it("asks for no buffers at all when nobody listens", async () => {
    const calls: string[][] = [];
    const sb = new CompanionSidebar(CFG, async (argv) => (calls.push(argv), OK));
    await sb.refresh();
    expect(calls[0]).not.toContain("list-buffers");
    sb.stop();
  });
});
