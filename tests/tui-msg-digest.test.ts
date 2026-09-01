import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import {
  InjectSender,
  injectFileName,
  injectProbeArgv,
  injectWriteArgv,
  installMessageHooks,
  isValidSessionName,
  type DeliveryState,
} from "../src/tui/msg.js";
import {
  currentFile,
  digestCatArgv,
  digestListArgv,
  parseDigestList,
  renderDigestTab,
  styleDigestLine,
  type DigestState,
} from "../src/tui/digesttab.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";

const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (): RemoteResult => ({ ok: false, stdout: "", stderr: "", code: 1 });

function fakeStreams() {
  const out = new EventEmitter() as any;
  let buf = "";
  out.columns = 100;
  out.rows = 24;
  out.write = (s: string) => ((buf += s), true);
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return { out, input, written: () => buf, type: (s: string | Buffer) => input.emit("data", Buffer.from(s)) };
}

// ---- inject path construction / escaping -----------------------------------

describe("quick-message inject writes", () => {
  it("accepts only the daemon's session names", () => {
    expect(isValidSessionName("pr-5012")).toBe(true);
    expect(isValidSessionName("overseer")).toBe(true);
    expect(isValidSessionName("main")).toBe(true);
    expect(isValidSessionName("pr-5012; rm -rf /")).toBe(false);
    expect(isValidSessionName("../overseer")).toBe(false);
  });

  it("builds an atomic tmp+mv write with the text riding stdin only", () => {
    const argv = injectWriteArgv(TUI_DEFAULTS, "pr-5012", "f.md");
    expect(argv.slice(0, 5)).toEqual(["sudo", "docker", "exec", "-i", "quickreview-sandbox"]);
    const script = argv[argv.length - 1]!;
    expect(script).toContain("cat > '/opt/quickreview/sandbox/inject/pr-5012/.f.md.tmp'");
    expect(script).toContain("mv '/opt/quickreview/sandbox/inject/pr-5012/.f.md.tmp' '/opt/quickreview/sandbox/inject/pr-5012/f.md'");
  });

  it("probes the bridge's .done archive for consumption", () => {
    const script = injectProbeArgv(TUI_DEFAULTS, "pr-7", "f.md")[injectProbeArgv(TUI_DEFAULTS, "pr-7", "f.md").length - 1]!;
    expect(script).toContain("/opt/quickreview/sandbox/inject/pr-7/.done/f.md");
    expect(script).toContain("echo consumed");
  });

  it("names inject files with a sortable timestamp and .md suffix", () => {
    const name = injectFileName(new Date("2026-08-13T21:30:00.123Z"), 3);
    expect(name).toBe("2026-08-13T21-30-00-123Z-tui-0003.md");
  });
});

// ---- delivery confirmation lifecycle ---------------------------------------

describe("InjectSender", () => {
  function senderWith(sshResponses: Array<RemoteResult>, timeoutS = 30) {
    const calls: string[][] = [];
    const ssh: SshRunner = async (_h, argv) => {
      calls.push(argv);
      return sshResponses.shift() ?? fail();
    };
    let clock = 0;
    const states: Array<[DeliveryState, string]> = [];
    const sender = new InjectSender(
      { ...TUI_DEFAULTS, msg_timeout_s: timeoutS },
      ssh,
      () => new Date(clock),
      async (ms) => {
        clock += ms;
      },
    );
    return { sender, calls, states, record: (s: DeliveryState, l: string) => states.push([s, l]) };
  }

  it("goes pending → delivered when the bridge consumes the file", async () => {
    const { sender, states, record } = senderWith([ok(""), ok("pending\n"), ok("consumed\n")]);
    await sender.send("pr-5012", "check send_batch too", record);
    expect(states.map(([s]) => s)).toEqual(["pending", "delivered"]);
    expect(states[1]![1]).toBe("✓ msg pr-5012 delivered");
  });

  it("reports undelivered when the write itself fails", async () => {
    const { sender, states, record } = senderWith([fail()]);
    await sender.send("pr-5012", "x", record);
    expect(states.map(([s]) => s)).toEqual(["pending", "undelivered"]);
    expect(states[1]![1]).toContain("write failed");
  });

  it("times out to undelivered (session down?) — never silent", async () => {
    const probes = Array.from({ length: 20 }, () => ok("pending\n"));
    const { sender, states, record } = senderWith([ok(""), ...probes], 10);
    await sender.send("pr-5012", "x", record);
    expect(states[states.length - 1]).toEqual(["undelivered", "✖ msg pr-5012 undelivered (session down?)"]);
  });

  it("refuses to build paths from a bad session name", async () => {
    const { sender, states, calls, record } = senderWith([]);
    await sender.send("pr-1; whoami", "x", record);
    expect(states).toEqual([["undelivered", "✖ msg pr-1; whoami undelivered (bad session name)"]]);
    expect(calls).toEqual([]); // nothing ever hit ssh
  });
});

// ---- the input box flow through the App ------------------------------------

describe("quick-message input box", () => {
  it("m opens the box, typing edits, ⏎ hands the verbatim text to the sender", async () => {
    const streams = fakeStreams();
    const sshOk: SshRunner = async () => ok("");
    const app = new App(TUI_DEFAULTS, sshOk, streams.out, streams.input);
    const sent: Array<[string, string]> = [];
    installMessageHooks(app, {
      send: async (session, text, onState) => {
        sent.push([session, text]);
        onState("delivered", `✓ msg ${session} delivered`);
      },
    });
    app.view.snapshot = {
      written_at: "",
      dry_run: true,
      prs: [{ number: 5012, state: "reviewing", title: "t", head_sha: "x", stale_recheck: 0 }],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    };
    const running = app.run();
    streams.type("m");
    expect(app.view.inputBox?.target).toBe("#5012 (pi session pr-5012)");
    streams.type("hi");
    streams.type(Buffer.from("\x1b\r")); // Alt-⏎ newline
    streams.type("there");
    streams.type("\r");
    expect(sent).toEqual([["pr-5012", "hi\nthere"]]);
    expect(app.view.inputBox).toBeUndefined();
    expect(app.view.noticeLine).toBe("✓ msg pr-5012 delivered");
    streams.type("q");
    streams.type("y"); //: q asks before it quits
    await running;
  });

  it("Esc cancels and preserves the draft until board navigation", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => fail(), streams.out, streams.input);
    installMessageHooks(app, { send: async () => {} });
    app.view.snapshot = {
      written_at: "",
      dry_run: true,
      prs: [
        { number: 1, state: "reviewing", title: "a", head_sha: "x", stale_recheck: 0 },
        { number: 2, state: "reviewing", title: "b", head_sha: "x", stale_recheck: 0 },
      ],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    };
    const running = app.run();
    streams.type("m");
    streams.type("draft");
    streams.type(Buffer.from("\x1b")); // Esc
    expect(app.view.inputBox).toBeUndefined();
    streams.type("m"); // reopen: draft preserved
    expect(app.view.inputBox?.text).toBe("draft");
    streams.type(Buffer.from("\x1b"));
    streams.type("j"); // board navigation drops the draft
    streams.type("m");
    expect(app.view.inputBox?.text).toBe("");
    streams.type(Buffer.from("\x1b"));
    streams.type("q");
    streams.type("y"); //: q asks before it quits
    await running;
  });
});

// ---- digest tab -------------------------------------------------------------

describe("digest tab", () => {
  it("builds read-only ls/cat argv inside the container", () => {
    expect(digestListArgv(TUI_DEFAULTS).join(" ")).toContain("ls '/opt/quickreview/sandbox/digest'");
    expect(digestCatArgv(TUI_DEFAULTS, "2026-08-13.md").join(" ")).toContain("cat '/opt/quickreview/sandbox/digest/2026-08-13.md'");
  });

  it("parses and sorts the digest listing, ignoring foreign files", () => {
    expect(parseDigestList("2026-08-12.md\njunk.txt\n2026-08-13.md\n")).toEqual(["2026-08-12.md", "2026-08-13.md"]);
  });

  it("pages older/newer through currentFile", () => {
    const st: DigestState = { files: ["2026-08-11.md", "2026-08-12.md", "2026-08-13.md"], back: 0, scroll: 0, loaded: true };
    expect(currentFile(st)).toBe("2026-08-13.md");
    st.back = 2;
    expect(currentFile(st)).toBe("2026-08-11.md");
  });

  // one full-width column. The AWAITING YOU panel that took ~45% of
  // this view, its `⏎ attach · w why · m msg` hint and its click zone are gone
  // with the park they listed — a document is read, not chosen from.
  it("styles headings and renders one full-width column with the yesterday tag", () => {
    expect(stripAnsi(styleDigestLine("# Reviews"))).toBe("Reviews");
    const st: DigestState = { files: ["2026-08-12.md"], back: 0, scroll: 0, loaded: true, content: "# Reviews\n6 PRs · 9 rounds" };
    const frame = renderDigestTab(st, true, "2026-08-13", 100, 24);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("digest 2026-08-12 (yesterday)");
    expect(text).toContain("Reviews");
    expect(text).not.toContain("AWAITING YOU");
    expect(text).not.toContain("⏎ attach");
    expect(frame.zones).toEqual([]);
    // No interior divider: the body is one box row across the whole width.
    const body = frame.lines.map(stripAnsi)[2]!;
    expect(body.slice(1, -1)).not.toContain("│");
  });
});
