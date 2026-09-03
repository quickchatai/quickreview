import { describe, expect, it } from "vitest";
import { ClipboardSink, osc52Text, type CmdRunner } from "../src/tui/clipboard.js";

describe("osc52Text", () => {
  it("decodes BEL- and ST-terminated sequences", () => {
    expect(osc52Text("\x1b]52;c;aGVsbG8=\x07")).toBe("hello");
    expect(osc52Text("\x1b]52;c;d29ybGQ=\x1b\\")).toBe("world");
  });

  it("accepts an empty selection field (tmux emits `52;;…`)", () => {
    expect(osc52Text("\x1b]52;;aGk=\x07")).toBe("hi");
  });

  it("ignores queries, empty payloads, and non-52 sequences", () => {
    expect(osc52Text("\x1b]52;c;?\x07")).toBeUndefined();
    expect(osc52Text("\x1b]52;c;\x07")).toBeUndefined();
    expect(osc52Text("\x1b]0;title\x07")).toBeUndefined();
  });
});

describe("ClipboardSink", () => {
  function fakeRunner(available: Record<string, boolean>): {
    run: CmdRunner;
    calls: Array<{ cmd: string; argv: string[]; stdin?: string }>;
  } {
    const calls: Array<{ cmd: string; argv: string[]; stdin?: string }> = [];
    const run: CmdRunner = async (cmd, argv, stdin) => {
      calls.push({ cmd, argv, stdin });
      return available[cmd] ?? false;
    };
    return { run, calls };
  }

  it("probes writers in order and pipes text into the first that works", async () => {
    const { run, calls } = fakeRunner({ xclip: true });
    const sink = new ClipboardSink(run);
    expect(await sink.write("the-auth-key")).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["wl-copy", "xclip"]);
    expect(calls[1]).toMatchObject({ argv: ["-selection", "clipboard"], stdin: "the-auth-key" });
  });

  it("falls through to klipper's D-Bus method with the text as an argument", async () => {
    const { run, calls } = fakeRunner({ qdbus6: true });
    const sink = new ClipboardSink(run);
    expect(await sink.write("key")).toBe(true);
    const last = calls[calls.length - 1]!;
    expect(last.cmd).toBe("qdbus6");
    expect(last.argv).toEqual(["org.kde.klipper", "/klipper", "setClipboardContents", "key"]);
    expect(last.stdin).toBeUndefined();
  });

  it("remembers the working writer and skips the re-probe on later writes", async () => {
    const { run, calls } = fakeRunner({ xsel: true });
    const sink = new ClipboardSink(run);
    await sink.write("a");
    const probed = calls.length;
    await sink.write("b");
    expect(calls.length).toBe(probed + 1);
    expect(calls[calls.length - 1]!.cmd).toBe("xsel");
  });

  it("re-probes when the cached writer stops working", async () => {
    const available: Record<string, boolean> = { "wl-copy": true };
    const { run, calls } = fakeRunner(available);
    const sink = new ClipboardSink(run);
    await sink.write("a");
    available["wl-copy"] = false;
    available["qdbus"] = true;
    expect(await sink.write("b")).toBe(true);
    expect(calls[calls.length - 1]!.cmd).toBe("qdbus");
  });

  it("returns false with no writer available and on empty text", async () => {
    const { run } = fakeRunner({});
    const sink = new ClipboardSink(run);
    expect(await sink.write("x")).toBe(false);
    expect(await sink.write("")).toBe(false);
  });
});
